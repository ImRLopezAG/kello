import assert from "node:assert/strict";
import { RPCLink } from "@orpc/client/fetch";
import { test } from "bun:test";
import { mkdtemp, mkdir, readFile, realpath, symlink, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { setTimeout } from "node:timers/promises";
import pg from "pg";
import { initializeProject as initializeSourceProject } from "../../../apps/loom/src/tooling/project/initialize";
import { prepareProject as prepareSourceProject } from "../../../apps/loom/src/tooling/codegen/generate";
import { synchronizeDevelopment as synchronizeSourceDevelopment } from "../../../apps/loom/src/tooling/dev/sync";
import type { DevelopmentDatabaseProvider as SourceDevelopmentDatabaseProvider } from "../../../apps/loom/src/tooling/dev/connection";
import type { DiagnosticsRecord as SourceDiagnosticsRecord } from "../../../apps/loom/src/tooling/diagnostics/types";

const connectionString = process.env.LOOM_TEST_DATABASE_URL;

test("real CLI composition recovers a failed edit while its owned JSONL stream continues and counts native RPC once", async () => {
  if (!connectionString) throw new Error("Missing test database");
  const root = await mkdtemp(join(tmpdir(), "kello-cli-native-diagnostics-"));
  const alias = root + "-alias";
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const namespace = `app_${suffix}`;
  const metadataNamespace = `loom_${suffix}`;
  const runtimeRole = `runtime_${suffix}`;
  const address = new URL(connectionString);
  const runtimeAddress = new URL(address);
  runtimeAddress.username = runtimeRole;
  runtimeAddress.password = "development-test-only";
  const admin = new pg.Client({ connectionString });
  await admin.connect();
  const provider: SourceDevelopmentDatabaseProvider = {
    getProject: async () => ({ id: "project", name: "tasks", regionId: "test", pgVersion: 18 }),
    listBranches: async () => [{ id: "br-development", name: "development", protected: false, isDefault: false }],
    listEndpoints: async () => [
      {
        id: address.hostname.split(".")[0]!,
        branchId: "br-development",
        type: "read_write",
        autoscalingLimitMinCu: 0.25,
        autoscalingLimitMaxCu: 1,
        suspendTimeout: 300,
      },
    ],
    getConnectionUri: async (_project, request) => ({
      uri: request.roleName === runtimeRole ? runtimeAddress.href : connectionString,
    }),
  };
  const options = {
    root,
    databaseName: decodeURIComponent(address.pathname.slice(1)),
    migrationRole: decodeURIComponent(address.username),
    runtimeRole,
    deployment: "local-development",
    activationToken: "e".repeat(64),
  };
  try {
    await initializeSourceProject(root, "tasks");
    await mkdir(join(root, "node_modules"));
    for (const name of ["kello", "valibot", "drizzle-orm"])
      await symlink(
        await realpath(fileURLToPath(new URL(`../../tests/node_modules/${name}`, import.meta.url))),
        join(root, "node_modules", name),
      );
    await symlink(root, alias);
    await writeFile(
      join(root, "kello.config.ts"),
      `
        import { defineConfig } from "kello/tooling";
        export default defineConfig({ project: "tasks", database: { namespace: "${namespace}", metadataNamespace: "${metadataNamespace}" }, provider: { projectId: "project", targets: { development: { branchId: "br-development" } } } });
      `,
    );
    await writeFile(
      join(root, "kello/auth.config.ts"),
      'import { defineRpcAuth } from "kello/server"; export default defineRpcAuth({ allowAnonymous: true, authorize: () => {} });',
    );
    const schema = join(root, "kello/schema.ts");
    await writeFile(schema, (await readFile(schema, "utf8")).replace('namespace: "app"', `namespace: "${namespace}"`));
    const candidate = await prepareSourceProject(root);
    await synchronizeSourceDevelopment({ ...options, sourceVersion: candidate.version }, provider);
    await admin.query(`ALTER ROLE "${runtimeRole}" LOGIN PASSWORD 'development-test-only'`);
    await writeFile(
      join(root, "session.json"),
      JSON.stringify({
        format: 1,
        databaseName: options.databaseName,
        migrationRole: options.migrationRole,
        runtimeRole,
        deployment: options.deployment,
        activationTokenEnv: "LOOM_TEST_CLI_NATIVE_TOKEN",
        port: 0,
      }),
    );
    const cliPath = fileURLToPath(new URL("../../../apps/loom/src/cli.ts", import.meta.url));
    const neonPath = fileURLToPath(new URL("../../../apps/loom/src/tooling/neon/api.ts", import.meta.url));
    const runner = join(root, ".loom/cli-runner.ts");
    await writeFile(
      runner,
      `
        import { mock } from "bun:test";
        import { channel } from "node:diagnostics_channel";
        const neon = await import(${JSON.stringify(neonPath)});
        // Only management discovery/credentials use the isolated PG fixture provider.
        // CLI routing, declaration, watcher, runtime, RPC and sinks remain real.
        const provider = {
          getProject: async () => ({ id: "project", pgVersion: 18 }),
          listBranches: async () => [{ id: "br-development", name: "development", protected: false, isDefault: false }],
          listEndpoints: async () => [{ id: ${JSON.stringify(address.hostname.split(".")[0])}, branchId: "br-development", type: "read_write" }],
          getConnectionUri: async (_project, request) => ({ uri: request.roleName === ${JSON.stringify(runtimeRole)} ? ${JSON.stringify(runtimeAddress.href)} : ${JSON.stringify(connectionString)} }),
        };
        mock.module(${JSON.stringify(neonPath)}, () => ({ ...neon, createKelloNeonApi: () => provider }));
        const { runCli } = await import(${JSON.stringify(cliPath)});
        const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
        const timer = setInterval(() => channel("kello.runtime.metric").publish({ type: "realtime.coordinator", subscriptions: 0, evaluating: 0, queued: 0 }), 10);
        try {
          const exit = await runCli(["dev", "--development", "session.json", "--cwd", ${JSON.stringify(alias)}, "--json", "--diagnostics", "jsonl", "--diagnostics-file", "events.jsonl"]);
          console.log(JSON.stringify({ fixture: "cleanup", exit, before, after: [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")], subscribers: [channel("kello.runtime.metric").hasSubscribers, channel("kello.deployment.metric").hasSubscribers] }));
          process.exitCode = exit;
        } finally { clearInterval(timer); }
      `,
    );
    const child = Bun.spawn([process.execPath, runner], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, LOOM_TEST_CLI_NATIVE_TOKEN: options.activationToken },
    });
    let stdout = "";
    let stderr = "";
    const capture = async (stream: ReadableStream<Uint8Array>, append: (text: string) => void) => {
      const decoder = new TextDecoder();
      for await (const chunk of stream) append(decoder.decode(chunk, { stream: true }));
      append(decoder.decode());
    };
    const captures = [
      capture(child.stdout, (text) => {
        stdout += text;
      }),
      capture(child.stderr, (text) => {
        stderr += text;
      }),
    ];
    const timeout = globalThis.setTimeout(() => child.kill("SIGKILL"), 30000);
    const events = (): {
      event?: string;
      version?: string;
      url?: string;
      fixture?: string;
      exit?: number;
      before?: number[];
      after?: number[];
      subscribers?: boolean[];
    }[] =>
      stdout
        .split("\n")
        .slice(0, -1)
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    async function waitFor(description: string, ready: () => boolean | Promise<boolean>) {
      const deadline = Date.now() + 10000;
      while (!(await ready())) {
        assert.ok(Date.now() < deadline, `Timed out waiting for ${description}: ${stderr}`);
        await setTimeout(10);
      }
    }
    const outputPath = join(root, "events.jsonl");
    const records = async (): Promise<SourceDiagnosticsRecord[]> =>
      (await readFile(outputPath, "utf8"))
        .split("\n")
        .slice(0, -1)
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    async function expectRpcCount(count: number) {
      await waitFor(
        "native RPC diagnostics",
        async () => (await records()).filter((record) => record.event.type === "rpc.procedure").length >= count,
      );
      const rpc = (await records()).filter(
        (record) => record.source === "runtime" && record.event.type === "rpc.procedure",
      );
      assert.equal(rpc.length, count, "Each native RPC must appear exactly once while background diagnostics continue");
      for (const record of rpc) {
        assert.equal(record.source, "runtime");
        if (record.source !== "runtime" || record.event.type !== "rpc.procedure") throw new Error("Expected RPC event");
        assert.equal(record.event.mode, "finite");
        assert.equal(record.event.status, "success");
        assert.ok(Number.isFinite(record.event.durationMs) && record.event.durationMs >= 0);
      }
    }
    try {
      await waitFor("initial CLI ready", () => events().some((event) => event.event === "ready"));
      const first = events().find((event) => event.event === "ready");
      assert.ok(first?.url && first.version);
      const readTasks = (version: string) =>
        new RPCLink({
          origin: new URL(first.url!).origin,
          url: "/api/kello/rpc",
          headers: { "x-loom-protocol": "loom-orpc-2", "x-loom-version": version },
        }).call(["tasks", "list"], undefined, { context: {} });
      assert.deepEqual(await readTasks(first.version), []);
      await expectRpcCount(1);
      const procedure = join(root, "kello/functions/tasks.ts");
      const original = await readFile(procedure, "utf8");
      const beforeFailure = (await readFile(outputPath)).byteLength;
      await writeFile(procedure, 'throw new Error("watched-cli-failure-canary");\n');
      await waitFor("failed CLI edit", () => stderr.includes("DEVELOPMENT_UPDATE_FAILED"));
      assert.deepEqual(await readTasks(first.version), []);
      await expectRpcCount(2);
      assert.ok((await readFile(outputPath)).byteLength > beforeFailure);
      const recovered = original.replace(").map((row) => row.title)", ').map((row) => row.title).concat("recovered")');
      assert.notEqual(recovered, original);
      const beforeSave = (await readFile(outputPath)).byteLength;
      await writeFile(procedure, recovered);
      await waitFor("recovered CLI ready", () =>
        events().some((event) => event.event === "ready" && event.version !== first.version),
      );
      const next = events()
        .filter((event) => event.event === "ready")
        .at(-1);
      assert.ok(next?.version);
      assert.equal(next.url, first.url);
      assert.deepEqual(await readTasks(next.version), ["recovered"]);
      await expectRpcCount(3);
      assert.ok((await readFile(outputPath)).byteLength > beforeSave, "The owned stream continues during activation");
      assert.equal((stderr.match(/DEVELOPMENT_UPDATE_FAILED/g) ?? []).length, 1);
      child.kill("SIGTERM");
      assert.equal(await child.exited, 0, stderr);
      await Promise.all(captures);
      const cleanup = events().find((event) => event.fixture === "cleanup");
      assert.ok(cleanup);
      assert.equal(cleanup.exit, 0);
      assert.deepEqual(cleanup.after, cleanup.before);
      assert.deepEqual(cleanup.subscribers, [false, false]);
      assert.ok(events().some((event) => event.event === "stopped"));
      assert.ok(!stderr.includes("watched-cli-failure-canary"));
      assert.ok(!stdout.includes(options.activationToken));
      const final = await records();
      assert.deepEqual(
        final.map((record) => record.sequence),
        final.map((_record, index) => index + 1),
      );
      assert.equal(final.filter((record) => record.event.type === "rpc.procedure").length, 3);
    } finally {
      clearTimeout(timeout);
      child.kill("SIGKILL");
      await child.exited;
      await Promise.all(captures);
    }
  } finally {
    await admin.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
    await admin.query(`DROP SCHEMA IF EXISTS "${metadataNamespace}" CASCADE`);
    await admin.query(`DROP ROLE IF EXISTS "${runtimeRole}"`);
    await admin.end();
    await rm(alias, { force: true });
    await rm(root, { recursive: true, force: true });
  }
}, 60000);
