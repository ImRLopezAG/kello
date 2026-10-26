import { initializeProject } from "kello-cli";
import assert from "node:assert/strict";
import { buildNeonFunctionBundle } from "kello-cli";
import { unzipSync } from "fflate";
import { expect, test } from "bun:test";
import {
  prepareNeonEntrypoints,
  generateProject,
  prepareProject,
  activateProject,
  assertGeneratedVersion,
  loadProject,
  readMigrations,
  planRelease,
} from "kello-cli";
import {
  mkdtemp,
  mkdir,
  readFile,
  readlink,
  readdir,
  rm,
  symlink,
  access,
  writeFile,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

test("initialization creates a consumer and preserves existing user files", async () => {
  const root = await mkdtemp(join(tmpdir(), "loom-init-"));
  try {
    expect(await initializeProject(root, "tasks")).toContain("kello/schema.ts");
    expect(await readFile(join(root, "kello/app.config.ts"), "utf8")).toContain("defineApplication");
    expect(await readFile(join(root, "kello/auth.config.ts"), "utf8")).toContain("defineRpcAuth()");
    expect(await readFile(join(root, "kello/contracts/tasks.ts"), "utf8")).toContain("defineContract");
    const handler = await readFile(join(root, "kello/functions/tasks.ts"), "utf8");
    expect(handler).toContain('from "../_generated/rpc"');
    expect(handler).not.toMatch(/clientMode|databaseRead|databaseWrite/);
    expect(Bun.spawnSync(["git", "init", "--quiet"], { cwd: root }).exitCode).toBe(0);
    const ignored = Bun.spawnSync(
      ["git", "check-ignore", "--no-index", "kello/_generated/server.ts", "kello/_generated/migrations/0001.sql"],
      { cwd: root },
    );
    expect(ignored.exitCode).toBe(0);
    expect(new TextDecoder().decode(ignored.stdout).trim()).toBe("kello/_generated/server.ts");
    const before = await readFile(join(root, "kello/schema.ts"), "utf8");
    await assert.rejects(initializeProject(root, "tasks"), /overwrite/);
    expect(await readFile(join(root, "kello/schema.ts"), "utf8")).toBe(before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("generated service and worker entries capture runtime configuration and expose typed connection options", async () => {
  const root = await mkdtemp(join(tmpdir(), "loom-entry-import-"));
  try {
    await initializeProject(root, "tasks");
    await mkdir(join(root, "node_modules/@kello"), { recursive: true });
    await mkdir(join(root, "node_modules/@orpc"), { recursive: true });
    for (const name of ["kello", "valibot", "drizzle-orm", "@orpc/server", "effect"]) {
      await symlink(
        await realpath(fileURLToPath(new URL(`../../tests/node_modules/${name}`, import.meta.url))),
        join(root, "node_modules", name),
      );
    }
    const generation = await generateProject(root);
    const directory = join(root, ".kello/generations", generation.version);
    const deployed = await prepareNeonEntrypoints(
      root,
      {
        metadataNamespace: "loom_meta",
        deployment: "preview",
        version: generation.version,
        projectId: "project",
        branchId: "br-preview",
        branchName: "preview",
        endpointHost: "ep-preview.example.test",
        databaseName: "neondb",
      },
      { wake: { kind: "wake", name: "worker" } },
    );
    expect(
      (await prepareNeonEntrypoints(root, deployed.binding, { wake: { kind: "wake", name: "worker" } })).directory,
    ).toBe(deployed.directory);
    expect(await readFile(deployed.service, "utf8")).toContain('process.env["LOOM_DATABASE_URL"]');
    expect(await readFile(deployed.service, "utf8")).not.toContain("createNeonStorageBackend");
    const deployedNode = Bun.spawn(
      [
        "node",
        "--input-type=module",
        "-e",
        `
      import assert from "node:assert/strict";
      import service from ${JSON.stringify(pathToFileURL(deployed.service).href)};
      import worker from ${JSON.stringify(pathToFileURL(deployed.worker).href)};
      for (const entry of [service, worker]) {
        const result = await entry.fetch(new Request("https://app.example.test/api/kello/call"));
        assert.equal(result.status, 503);
        assert.equal(await result.text(), "Service unavailable");
        await entry.stop();
      }
    `,
      ],
      { stdout: "pipe", stderr: "pipe", env: { ...process.env, LOOM_DATABASE_URL: "", LOOM_ACTIVATION_TOKEN: "" } },
    );
    expect(await new Response(deployedNode.stderr).text()).toBe("");
    expect(await deployedNode.exited).toBe(0);
    for (const [slug, source] of [
      ["service", deployed.service],
      ["worker", deployed.worker],
    ]) {
      assert.ok(slug && source);
      const archive = await buildNeonFunctionBundle(source);
      const packed = await mkdtemp(join(tmpdir(), "loom-packed-entry-"));
      try {
        const files = unzipSync(archive);
        expect(files["index.mjs"]).toBeDefined();
        for (const [name, contents] of Object.entries(files)) {
          const filename = join(packed, name);
          await mkdir(dirname(filename), { recursive: true });
          await writeFile(filename, contents);
        }
        const execution = Bun.spawn(
          [
            "node",
            "--input-type=module",
            "-e",
            `
          import assert from "node:assert/strict";
          import entry from ${JSON.stringify(pathToFileURL(join(packed, "index.mjs")).href)};
          assert.equal((await entry.fetch(new Request("https://app.example.test"))).status, 503);
          await entry.stop();
        `,
          ],
          {
            cwd: packed,
            stdout: "pipe",
            stderr: "pipe",
            env: { ...process.env, LOOM_DATABASE_URL: "", LOOM_ACTIVATION_TOKEN: "" },
          },
        );
        expect(await new Response(execution.stderr).text()).toBe("");
        expect(await execution.exited).toBe(0);
      } finally {
        await rm(packed, { recursive: true, force: true });
      }
    }
    await writeFile(deployed.service, "changed artifact");
    await assert.rejects(
      prepareNeonEntrypoints(root, deployed.binding, { wake: { kind: "wake", name: "worker" } }),
      /artifact changed/i,
    );

    const runtime = await import(pathToFileURL(join(directory, "runtime.js")).href);
    expect(runtime.runtimeOptions().version).toBe(generation.version);
    const captured = runtime.runtimeOptions();
    expect(captured.config.jobs.leaseMs).toBe(60000);
    expect(captured.metadataNamespace).toBe("loom_meta");
    captured.config.jobs.leaseMs = 1000;
    expect(runtime.runtimeOptions().config.jobs.leaseMs).toBe(60000);
    await writeFile(
      join(root, "kello/check-entry.ts"),
      `
import { createService } from "./_generated/service";
import { createWorker } from "./_generated/worker";
const connection = { connectionString: "postgres://localhost:1/test", deployment: "test", assertActive: async () => {} };
void createService(connection);
void createWorker({ ...connection, bindings: { wake: { kind: "wake", name: "worker" } } });
// @ts-expect-error activation verification is required
void createService({ connectionString: connection.connectionString, deployment: "test" });
// @ts-expect-error provider bindings are required for a worker
void createWorker(connection);
`,
    );
    const tsc = Bun.spawn(
      [
        fileURLToPath(new URL("../../../node_modules/.bin/tsc", import.meta.url)),
        "--project",
        join(root, "tsconfig.json"),
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect((await new Response(tsc.stdout).text()) + (await new Response(tsc.stderr).text())).toBe("");
    expect(await tsc.exited).toBe(0);
    await writeFile(join(root, "kello.config.ts"), "throw new Error('changed configuration');");
    await writeFile(join(root, "kello/schema.ts"), "throw new Error('changed schema');");
    const node = Bun.spawn(
      [
        "node",
        "--input-type=module",
        "-e",
        `
      import assert from "node:assert/strict";
      import { createService } from ${JSON.stringify(pathToFileURL(join(directory, "service.js")).href)};
      import { createWorker } from ${JSON.stringify(pathToFileURL(join(directory, "worker.js")).href)};
      const options = { connectionString: "postgres://localhost:1/test", deployment: "test", assertActive: async () => { throw new Error("quarantined"); } };
      await assert.rejects(createService(options), /activation denied/);
      await assert.rejects(createWorker({ ...options, bindings: {} }), /activation denied/);
    `,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await new Response(node.stderr).text()).toBe("");
    expect(await node.exited).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30000); // Two Vite+ bundles, native imports and a real TypeScript compiler invocation.

test("generation captures explicit authorization and refuses invalid auth modules without activation", async () => {
  const root = await mkdtemp(join(tmpdir(), "loom-auth-import-"));
  try {
    await initializeProject(root, "tasks");
    await mkdir(join(root, "node_modules/@kello"), { recursive: true });
    await mkdir(join(root, "node_modules/@orpc"), { recursive: true });
    for (const name of ["kello", "valibot", "drizzle-orm", "@orpc/server", "effect"]) {
      await symlink(
        await realpath(fileURLToPath(new URL(`../../tests/node_modules/${name}`, import.meta.url))),
        join(root, "node_modules", name),
      );
    }
    const first = await generateProject(root);
    const filename = join(root, "kello/auth.config.ts");
    const context = {
      path: ["tasks", "list"],
      input: null,
      requestId: "request",
      identity: null,
      signal: new AbortController().signal,
    };
    const initial = await loadProject(root);
    if (initial.protocol !== "loom-orpc-2") throw new Error("Expected native fixture");
    await assert.rejects(initial.auth.authorize(context), /Forbidden/);
    await writeFile(
      filename,
      `import { defineRpcAuth } from "kello/server";
import { ORPCError } from "@orpc/server";
export default defineRpcAuth({ allowAnonymous: true, authorize: ({ path }) => {
  if (path.join(".") !== "tasks.list") throw new ORPCError("FORBIDDEN");
} });`,
    );
    const candidate = await prepareProject(root);
    expect(candidate.version).not.toBe(first.version);
    const loaded = await loadProject(root);
    expect(loaded.auth.allowAnonymous).toBe(true);
    const generated = await import(
      pathToFileURL(join(root, ".kello/generations", candidate.version, "router.js")).href
    );
    const auth = generated.auth;
    expect(auth.allowAnonymous).toBe(true);
    await auth.authorize(context);
    await assert.rejects(auth.authorize({ ...context, path: ["tasks", "other"] }), /Forbidden/);
    for (const source of ["export default null;", "export default { authorize: () => {}, allowAnonymous: true };"]) {
      await writeFile(filename, source);
      await assert.rejects(generateProject(root), /defineRpcAuth/);
      expect(await readlink(join(root, "kello/_generated/current"))).toBe("../../.kello/generations/" + first.version);
    }
    await auth.authorize(context);
    const runtime = Bun.spawn(
      [
        "node",
        "--input-type=module",
        "-e",
        `
      import assert from "node:assert/strict";
      import { auth } from ${JSON.stringify(pathToFileURL(join(root, ".kello/generations", candidate.version, "router.js")).href)};
      assert.equal(auth.allowAnonymous, true);
      await auth.authorize(${JSON.stringify(context)});
      await assert.rejects(auth.authorize({ ...${JSON.stringify(context)}, path: ["tasks", "other"] }), /Forbidden/);
    `,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await new Response(runtime.stderr).text()).toBe("");
    expect(await runtime.exited).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("generation loads native relations against its own immutable schema", async () => {
  const root = await mkdtemp(join(tmpdir(), "loom-relations-import-"));
  try {
    await initializeProject(root, "tasks");
    await mkdir(join(root, "node_modules/@kello"), { recursive: true });
    await mkdir(join(root, "node_modules/@orpc"), { recursive: true });
    for (const name of ["kello", "valibot", "drizzle-orm", "@orpc/server", "effect"]) {
      await symlink(
        await realpath(fileURLToPath(new URL(`../../tests/node_modules/${name}`, import.meta.url))),
        join(root, "node_modules", name),
      );
    }
    const first = await generateProject(root);
    const initial = await import(pathToFileURL(join(root, ".kello/generations", first.version, "router.js")).href);
    expect(initial.relations.tasks.table).toBe(initial.schema.tables.tasks);
    expect(initial.relations.tasks.relations).toEqual({});
    const filename = join(root, "kello/relations.ts");
    const source = `import { defineRelations } from "drizzle-orm";
import schema from "./schema";
export default defineRelations(schema.tables, (r) => ({
  tasks: { sameTask: r.one.tasks({ from: r.tasks._id, to: r.tasks._id }) },
}));
`;
    await writeFile(filename, source);
    await assert.rejects(assertGeneratedVersion(root, first.version), /stale/);
    const candidate = await prepareProject(root);
    const project = await loadProject(root);
    expect(project.relations.tasks?.table).toBe(project.schema.tables.tasks);
    const generated = await import(
      pathToFileURL(join(root, ".kello/generations", candidate.version, "router.js")).href
    );
    expect(generated.relations.tasks.table).toBe(generated.schema.tables.tasks);
    expect(generated.relations.tasks.relations.sameTask.targetTable).toBe(generated.schema.tables.tasks);
    expect(await readlink(join(root, "kello/_generated/current"))).toBe("../../.kello/generations/" + first.version);
    await writeFile(filename, "export default null;");
    await assert.rejects(generateProject(root), /native Drizzle relations/);
    await writeFile(
      filename,
      source.replace(
        'import schema from "./schema";',
        `import { defineSchema } from "kello/server";
const schema = defineSchema((s) => ({ tasks: { title: s.text() } }), { namespace: "app" });`,
      ),
    );
    await assert.rejects(generateProject(root), /compiled table/);
    expect(await readlink(join(root, "kello/_generated/current"))).toBe("../../.kello/generations/" + first.version);
    expect(initial.relations.tasks.relations).toEqual({});
    expect(generated.relations.tasks.relations.sameTask.targetTable).toBe(generated.schema.tables.tasks);
    const runtime = Bun.spawn(
      [
        "node",
        "--input-type=module",
        "-e",
        `
      import assert from "node:assert/strict";
      import { schema, relations } from ${JSON.stringify(pathToFileURL(join(root, ".kello/generations", candidate.version, "router.js")).href)};
      assert.equal(relations.tasks.table, schema.tables.tasks);
      assert.equal(relations.tasks.relations.sameTask.targetTable, schema.tables.tasks);
    `,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await new Response(runtime.stderr).text()).toBe("");
    expect(await runtime.exited).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("extensionless internal imports capture native cron targets and keep candidate versions stable", async () => {
  const root = await mkdtemp(join(tmpdir(), "loom-internal-import-"));
  try {
    await initializeProject(root, "tasks");
    await mkdir(join(root, "node_modules/@kello"), { recursive: true });
    await mkdir(join(root, "node_modules/@orpc"), { recursive: true });
    for (const name of ["kello", "valibot", "drizzle-orm", "@orpc/server", "effect"])
      await symlink(
        await realpath(fileURLToPath(new URL(`../../tests/node_modules/${name}`, import.meta.url))),
        join(root, "node_modules", name),
      );
    await mkdir(join(root, "kello/internal"));
    await mkdir(join(root, "kello/contracts/internal"), { recursive: true });
    await writeFile(
      join(root, "kello/contracts/internal/chain.ts"),
      'import { defineContract, oc } from "kello/contract"; import * as v from "valibot"; export default defineContract({ target: oc.output(v.string()) });',
    );
    const filename = join(root, "kello/internal/chain.ts");
    const cronsFile = join(root, "kello/crons.ts");
    const source =
      'import { os } from "../_generated/rpc"; export default os.internal.chain.router({ target: os.internal.chain.target.handler(() => "first") });';
    const cronSource =
      'import { procedureCron } from "kello/server"; import chain from "./internal/chain"; const target = chain.target; export default { refresh: procedureCron("* * * * *", target, undefined) };';
    await writeFile(filename, source);
    await writeFile(cronsFile, cronSource);
    const discovered = await Promise.all([loadProject(root), loadProject(root), loadProject(root)]);
    const first = await generateProject(root);
    expect(discovered.map((project) => project.version)).toEqual([first.version, first.version, first.version]);
    expect((await generateProject(root)).version).toBe(first.version);
    expect((await prepareProject(root)).version).toBe(first.version);
    await assertGeneratedVersion(root, first.version);
    expect((await loadProject(root)).crons).toMatchObject({
      refresh: { schedule: "* * * * *", call: { path: ["chain", "target"], version: first.version } },
    });
    await writeFile(filename, source.replace('"first"', '"second"'));
    const candidate = await prepareProject(root);
    expect(candidate.version).not.toBe(first.version);
    expect((await loadProject(root)).crons.refresh?.call.version).toBe(candidate.version);
    await activateProject(root, candidate.version);
    expect((await generateProject(root)).version).toBe(candidate.version);
    // Both retained native generations resolve their own procedure objects.
    for (const [version, expected] of [
      [first.version, "first"],
      [candidate.version, "second"],
    ] as const) {
      const routerUrl = pathToFileURL(join(root, ".kello/generations", version, "router.js")).href;
      const node = Bun.spawn(
        [
          "node",
          "--input-type=module",
          "--eval",
          `import { Context } from "effect"; import { call } from "@orpc/server"; import { internal, crons } from ${JSON.stringify(routerUrl)}; if (crons.refresh.procedure !== internal.chain.target) throw new Error("Wrong native cron target"); console.log(await internal.chain.target["~orpc"].handler({}));`,
        ],
        { cwd: root, stdout: "pipe", stderr: "pipe" },
      );
      expect(await new Response(node.stderr).text()).toBe("");
      expect((await new Response(node.stdout).text()).trim()).toBe(expected);
      expect(await node.exited).toBe(0);
    }
    await writeFile(cronsFile, cronSource.replace('"* * * * *"', '"*/5 * * * *"'));
    await assert.rejects(assertGeneratedVersion(root, candidate.version), /stale/);
    expect((await prepareProject(root)).version).not.toBe(candidate.version);
    await writeFile(cronsFile, cronSource.replace("refresh:", '"invalid name":'));
    await assert.rejects(generateProject(root), /invalid name/);
    await writeFile(
      cronsFile,
      cronSource.replace(
        'import chain from "./internal/chain"; const target = chain.target;',
        'import tasks from "./functions/tasks"; const target = tasks.list;',
      ),
    );
    await assert.rejects(generateProject(root), /registered internal procedure/);
    const configFile = join(root, "kello.config.ts");
    await writeFile(configFile, "export default { jobs: { maxAttempts: 1 } };");
    await writeFile(cronsFile, cronSource.replace("target, undefined)", "target, undefined, { maxAttempts: 2 })"));
    await assert.rejects(generateProject(root), /configured attempts/);
    expect(await readlink(join(root, "kello/_generated/current"))).toBe(
      "../../.kello/generations/" + candidate.version,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("initialization refuses a backend symlink outside the project", async () => {
  const root = await mkdtemp(join(tmpdir(), "loom-init-"));
  const outside = await mkdtemp(join(tmpdir(), "loom-external-"));
  try {
    await mkdir(join(outside, "functions"));
    await symlink(outside, join(root, "kello"));
    await assert.rejects(initializeProject(root, "tasks"), /escape/);
    await assert.rejects(access(join(outside, "schema.ts")));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("offline generation is deterministic, detects stale contracts and keeps internal references out of the browser API", async () => {
  const root = await mkdtemp(join(tmpdir(), "loom-generate-"));
  try {
    await initializeProject(root, "tasks");
    await mkdir(join(root, "node_modules/@kello"), { recursive: true });
    await mkdir(join(root, "node_modules/@orpc"), { recursive: true });
    for (const name of ["kello", "valibot", "drizzle-orm", "@orpc/server", "effect"]) {
      await symlink(
        await realpath(fileURLToPath(new URL(`../../tests/node_modules/${name}`, import.meta.url))),
        join(root, "node_modules", name),
      );
    }
    const tasksFile = join(root, "kello/functions/tasks.ts");
    await writeFile(
      tasksFile,
      (await readFile(tasksFile, "utf8")) + '\nexport const helper = () => "not an endpoint";\n',
    );
    await mkdir(join(root, "kello/internal"));
    await mkdir(join(root, "kello/contracts/internal"), { recursive: true });
    await writeFile(
      join(root, "kello/contracts/internal/tasks.ts"),
      'import { defineContract, oc } from "kello/contract"; import * as v from "valibot"; export default defineContract({ secret: oc.output(v.string()) });',
    );
    await writeFile(
      join(root, "kello/internal/tasks.ts"),
      'import { os } from "../_generated/rpc"; export default os.internal.tasks.router({ secret: os.internal.tasks.secret.handler(() => "CLI_PRIVATE_SENTINEL") });',
    );
    const concurrent = await Promise.all([generateProject(root), generateProject(root), generateProject(root)]);
    const first = concurrent[0];
    if (!first) throw new Error("Missing generated manifest");
    expect(concurrent.map((manifest) => manifest.version)).toEqual([first.version, first.version, first.version]);
    expect(first.procedures).toEqual([
      { path: ["tasks", "list"], visibility: "public" },
      { path: ["tasks", "secret"], visibility: "internal" },
    ]);
    expect((await generateProject(root)).version).toBe(first.version);
    const api = await readFile(join(root, "kello/_generated/current/api.js"), "utf8");
    expect(api).not.toContain('"secret"');
    const imported = await import(pathToFileURL(join(root, ".kello/generations", first.version, "api.js")).href);
    const session = imported.createClient({ url: "https://example.test", getToken: async () => null });
    expect(session.client.tasks.list).toBeInstanceOf(Function);
    session.dispose();
    await writeFile(
      join(root, "kello/consumer.ts"),
      `import { createClient } from "./_generated/api";
declare const options: Parameters<typeof createClient>[0];
const { client } = createClient(options);
const query: Promise<string[]> = client.tasks.list();
void query;
// @ts-expect-error internal procedures are absent from the native client
client.tasks.secret();
`,
    );
    const tsc = Bun.spawn(
      [
        fileURLToPath(new URL("../../../node_modules/.bin/tsc", import.meta.url)),
        "--project",
        join(root, "tsconfig.json"),
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const diagnostics = (await new Response(tsc.stdout).text()) + (await new Response(tsc.stderr).text());
    expect(diagnostics).toBe("");
    expect(await tsc.exited).toBe(0);
    const browser = await Bun.build({ entrypoints: [join(root, "kello/_generated/api.js")], target: "browser" });
    expect(browser.success).toBe(true);
    const browserCode = await browser.outputs[0]?.text();
    expect(browserCode).toContain("createORPCClient");
    expect(browserCode).not.toContain("CLI_PRIVATE_SENTINEL");
    expect(browserCode).not.toContain("kello/server");
    await mkdir(join(root, "kello/functions/tasks"));
    await writeFile(
      join(root, "kello/functions/tasks/list.ts"),
      'import tasks from "../tasks"; export default { child: tasks.list };',
    );
    await assert.rejects(generateProject(root), /Procedure conflicts with router/);
    expect(await readlink(join(root, "kello/_generated/current"))).toBe("../../.kello/generations/" + first.version);
    await rm(join(root, "kello/functions/tasks"), { recursive: true });
    expect((await generateProject(root)).version).toBe(first.version);

    const cli = fileURLToPath(new URL("../../../apps/kello-cli/src/cli.ts", import.meta.url));
    const doctor = Bun.spawn([process.execPath, cli, "doctor", "--cwd", root, "--json"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await new Response(doctor.stdout).text()).toContain('"ok":true');
    expect(await new Response(doctor.stderr).text()).toBe("");
    expect(await doctor.exited).toBe(0);
    for (const args of [
      ["schema", "diff"],
      ["migrations", "generate", "--name", "initial"],
    ]) {
      const child = Bun.spawn([process.execPath, cli, ...args, "--cwd", root, "--json"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(await new Response(child.stderr).text()).toBe("");
      const output = await new Response(child.stdout).text();
      expect(output.startsWith('{"ok":true')).toBe(true);
      expect(await child.exited).toBe(0);
    }
    expect(await readMigrations(root, "kello/_generated/migrations")).toHaveLength(1);
    expect((await planRelease(root)).statements).toEqual([]);
    await assertGeneratedVersion(root, first.version);
    const active = join(root, "kello/_generated/current");
    const beforeFailure = await readlink(active);
    const tasksSource = await readFile(tasksFile, "utf8");
    await writeFile(tasksFile, "export const broken = ;");
    await assert.rejects(generateProject(root));
    expect(await readlink(active)).toBe(beforeFailure);
    await writeFile(tasksFile, tasksSource);
    await writeFile(tasksFile, (await readFile(tasksFile, "utf8")).replace('"not an endpoint"', '"changed helper"'));
    await assert.rejects(assertGeneratedVersion(root, first.version), /stale/);
    const candidate = await prepareProject(root);
    expect(candidate.version).not.toBe(first.version);
    expect(await readlink(active)).toBe(beforeFailure);
    const cancelled = new AbortController();
    cancelled.abort();
    await assert.rejects(activateProject(root, candidate.version, cancelled.signal), { name: "AbortError" });
    expect(await readlink(active)).toBe(beforeFailure);
    await writeFile(tasksFile, (await readFile(tasksFile, "utf8")).replace('"changed helper"', '"newest helper"'));
    await assert.rejects(activateProject(root, candidate.version), /stale/);
    expect(await readlink(active)).toBe(beforeFailure);
    const latest = await prepareProject(root);
    await activateProject(root, latest.version);
    expect(await readlink(active)).toBe("../../.kello/generations/" + latest.version);
    const publicFiles = await readdir(join(root, "kello/_generated"));
    expect(publicFiles.sort()).toEqual(
      [
        ".kello-generated",
        "api.d.ts",
        "api.js",
        "components.ts",
        "config.d.ts",
        "config.js",
        "contract-registry.ts",
        "contracts",
        "current",
        "internal.d.ts",
        "internal.js",
        "migrations",
        "registration.d.ts",
        "rpc.ts",
        "schema.ts",
        "server.ts",
        "service.d.ts",
        "service.js",
        "worker.d.ts",
        "worker.js",
      ].sort(),
    );
    expect(await readdir(join(root, ".kello/generations"))).toHaveLength(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI produces matching structured/human failures without leaking executable config errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "loom-doctor-"));
  const cli = fileURLToPath(new URL("../../../apps/kello-cli/src/cli.ts", import.meta.url));
  try {
    await writeFile(
      join(root, "kello.config.ts"),
      'throw new Error("secret-sentinel-do-not-print"); export default {};',
    );
    const outputs = [];
    for (const flags of [[], ["--json"]]) {
      const child = Bun.spawn([process.execPath, cli, "doctor", "--cwd", root, ...flags], {
        stdout: "pipe",
        stderr: "pipe",
      });
      outputs.push(await new Response(child.stderr).text());
      expect(await child.exited).toBe(3);
      expect(await new Response(child.stdout).text()).toBe("");
    }
    expect(outputs[0]).toContain("PROJECT_INVALID");
    expect(outputs[1]).toContain('"code":"PROJECT_INVALID"');
    expect(outputs.join("")).not.toContain("secret-sentinel");
    await mkdir(join(root, "node_modules/@kello"), { recursive: true });
    await mkdir(join(root, "node_modules/@orpc"), { recursive: true });
    await symlink(
      await realpath(fileURLToPath(new URL("../../tests/node_modules/kello", import.meta.url))),
      join(root, "node_modules/kello"),
    );
    await writeFile(
      join(root, "kello.config.ts"),
      `import {ProcedureUpgradeError} from "kello-cli";
throw new ProcedureUpgradeError([{id:"00000000-0000-4000-8000-000000000001",version:null,reason:"missing-mapping"}]);
export default {};`,
    );
    const blocked = Bun.spawn([process.execPath, cli, "doctor", "--cwd", root, "--json"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const blockedOutput = JSON.parse(await new Response(blocked.stderr).text());
    expect(await blocked.exited).toBe(5);
    expect(blockedOutput.error.code).toBe("DURABLE_UPGRADE_BLOCKED");
    expect(blockedOutput.error.inventory).toEqual([
      { id: "00000000-0000-4000-8000-000000000001", version: null, reason: "missing-mapping" },
    ]);
    const missing = Bun.spawn([process.execPath, cli, "init", "--cwd", root, "--json"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await new Response(missing.stderr).text()).toContain("MISSING_VALUE");
    expect(await missing.exited).toBe(2);
    const extra = Bun.spawn([process.execPath, cli, "doctor", "extra", "unexpected", "--json"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await new Response(extra.stderr).text()).toContain('"code":"USAGE"');
    expect(await extra.exited).toBe(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("generation captures storage policies and validates current internal handlers before activation", async () => {
  const root = await mkdtemp(join(tmpdir(), "loom-storage-import-"));
  try {
    await initializeProject(root, "tasks");
    await writeFile(
      join(root, "kello.config.ts"),
      `import { defineConfig } from "kello-cli";
export default defineConfig({ project: "tasks", jobs: { maxAttempts: 2 } });`,
    );
    await mkdir(join(root, "node_modules/@kello"), { recursive: true });
    await mkdir(join(root, "node_modules/@orpc"), { recursive: true });
    for (const name of ["kello", "valibot", "drizzle-orm", "@orpc/server", "effect"]) {
      await symlink(
        await realpath(fileURLToPath(new URL(`../../tests/node_modules/${name}`, import.meta.url))),
        join(root, "node_modules", name),
      );
    }
    const first = await generateProject(root);
    const context = {
      identity: { issuer: "issuer", subject: "alice" },
      operation: "upload" as const,
      upload: { bucket: "uploads", size: 1, contentType: "text/plain", sha256: "a".repeat(64) },
      signal: new AbortController().signal,
    };
    await assert.rejects((await loadProject(root)).storage.authorize(context), /Storage access denied/);
    await mkdir(join(root, "kello/internal"));
    await mkdir(join(root, "kello/contracts/internal"), { recursive: true });
    await writeFile(
      join(root, "kello/contracts/internal/files.ts"),
      `import { defineContract, oc } from "kello/contract";
import { storageObjectCreatedValidator } from "kello/server";
import * as v from "valibot";
export default defineContract({ created: oc.input(storageObjectCreatedValidator).output(v.null()) });`,
    );
    await writeFile(
      join(root, "kello/internal/files.ts"),
      `import { os } from "../_generated/rpc";
export default os.internal.files.router({ created: os.internal.files.created.handler(async () => null) });`,
    );
    const filename = join(root, "kello/storage.ts");
    const source = `import { defineProcedureStorage, procedureObjectCreated } from "kello/server";
import files from "./internal/files"; const created = files.created;
export default defineProcedureStorage({ buckets: { uploads: { onObjectCreated: procedureObjectCreated(created) } },
authorize: ({ identity }) => { if (identity.subject !== "alice") throw new Error("Storage access denied"); } });`;
    await writeFile(filename, source);
    const candidate = await prepareProject(root);
    expect(candidate.version).not.toBe(first.version);
    const project = await loadProject(root);
    if (project.protocol !== "loom-orpc-2") throw new Error("Expected native fixture");
    expect(project.storage.buckets.uploads?.onObjectCreated?.procedure).toBe(
      project.procedures.find((entry) => entry.path.join(".") === "files.created")?.definition,
    );
    const registryUrl = pathToFileURL(join(root, ".kello/generations", candidate.version, "router.js")).href;
    const generated = await import(registryUrl);
    const runtimeUrl = pathToFileURL(join(root, ".kello/generations", candidate.version, "runtime.js")).href;
    const generatedRuntime = await import(runtimeUrl);
    expect(generatedRuntime.runtimeOptions().storage).toBe(generated.storage);
    expect(await readFile(join(root, ".kello/generations", candidate.version, "worker.d.ts"), "utf8")).toContain(
      "storageBackend",
    );
    await generated.storage.authorize(context);
    await assert.rejects(
      generated.storage.authorize({ ...context, identity: { ...context.identity, subject: "bob" } }),
      /access denied/,
    );
    // A policy-only edit must have its own immutable build identity.
    await writeFile(filename, source.replace('!== "alice"', '!== "bob"'));
    const changed = await prepareProject(root);
    expect(changed.version).not.toBe(candidate.version);
    for (const invalid of [
      "export default null;",
      "export default { buckets: {}, authorize: () => {} };",
      source.replace("procedureObjectCreated(created)", "procedureObjectCreated({})"),
      source.replace("procedureObjectCreated(created)", "procedureObjectCreated({ ...created })"),
      source.replace("procedureObjectCreated(created)", "procedureObjectCreated(created, { maxAttempts: 10 })"),
    ]) {
      await writeFile(filename, invalid);
      await assert.rejects(
        generateProject(root),
        /defineProcedureStorage|native procedure|registered internal procedure|configured attempts/,
      );
      expect(await readlink(join(root, "kello/_generated/current"))).toBe("../../.kello/generations/" + first.version);
    }
    await generated.storage.authorize(context);
    const runtime = Bun.spawn(
      [
        "node",
        "--input-type=module",
        "-e",
        `
import assert from "node:assert/strict";
import { storage, procedures } from ${JSON.stringify(registryUrl)};
import { runtimeOptions } from ${JSON.stringify(runtimeUrl)};
assert.equal(runtimeOptions().storage, storage);
assert.equal(storage.buckets.uploads.onObjectCreated.procedure, procedures.find(entry => entry.path.join(".") === "files.created").procedure);
assert.equal(Object.isFrozen(storage.buckets.uploads.onObjectCreated), true);
await storage.authorize(${JSON.stringify(context)});
await assert.rejects(storage.authorize({ ...${JSON.stringify(context)}, identity: { issuer: "issuer", subject: "bob" } }), /access denied/);
`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await new Response(runtime.stderr).text()).toBe("");
    expect(await runtime.exited).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
