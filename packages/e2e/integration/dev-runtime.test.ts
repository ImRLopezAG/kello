import { initializeProject } from "kello/tooling";
import assert from "node:assert/strict";
import { callExample } from "../fixtures/rpc-call";
import { RPCLink } from "@orpc/client/fetch";
import { expect, test } from "bun:test";
import { channel } from "node:diagnostics_channel";
import { writeFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, realpath, symlink, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { setTimeout } from "node:timers/promises";
import pg from "pg";
import {
  prepareProject,
  synchronizeDevelopment,
  startDevelopmentRuntime,
  startProjectDevelopment,
  startDiagnostics,
} from "kello/tooling";
import type { DevelopmentDatabaseProvider, DiagnosticsRecord } from "kello/tooling";

const connectionString = process.env.LOOM_TEST_DATABASE_URL;
test.skipIf(!connectionString)(
  "development startup binds synchronized generations, runtime authority and durable activation",
  async () => {
    if (!connectionString) throw new Error("Missing test database");
    const root = await mkdtemp(join(tmpdir(), "loom-dev-runtime-"));
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const namespace = `app_${suffix}`;
    const metadataNamespace = `loom_${suffix}`;
    const runtimeRole = `runtime_${suffix}`;
    const address = new URL(connectionString);
    const runtimeAddress = new URL(address);
    runtimeAddress.username = runtimeRole;
    runtimeAddress.password = "development-test-only";
    const environment = [process.env.NEON_BRANCH, process.env.DATABASE_URL, process.env.LOOM_ACTIVATION_TOKEN];
    const admin = new pg.Client({ connectionString });
    await admin.connect();
    let runtimeUri = runtimeAddress.href;
    const branch = { id: "br-development", name: "development", protected: false, isDefault: false };
    let runtimeCredentialsResolved = () => {};
    let buckets: { name: string; accessLevel: "private" | "public_read" }[] = [];
    const provider: DevelopmentDatabaseProvider = {
      listBranchBuckets: async () => buckets,
      getProject: async () => ({ id: "project", name: "tasks", regionId: "test", pgVersion: 18 }),
      listBranches: async () => [branch],
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
      getConnectionUri: async (_project, request) => {
        if (request.roleName === runtimeRole) runtimeCredentialsResolved();
        return { uri: request.roleName === runtimeRole ? runtimeUri : connectionString };
      },
    };
    const options = {
      root,
      databaseName: decodeURIComponent(address.pathname.slice(1)),
      migrationRole: decodeURIComponent(address.username),
      runtimeRole,
      deployment: "local-development",
      activationToken: "e".repeat(64),
    };
    const runtimes: Awaited<ReturnType<typeof startDevelopmentRuntime>>["runtime"][] = [];
    async function expectConnections(expected: number) {
      const deadline = Date.now() + 2000;
      for (;;) {
        const result = await admin.query<{ count: number }>(
          "SELECT count(*)::integer AS count FROM pg_stat_activity WHERE usename = $1",
          [runtimeRole],
        );
        if (result.rows[0]?.count === expected) return;
        if (Date.now() > deadline) {
          const activity = await admin.query(
            "SELECT pid, state, wait_event, application_name, backend_start, query FROM pg_stat_activity WHERE usename = $1 ORDER BY pid",
            [runtimeRole],
          );
          assert.fail(`Expected ${expected} runtime connections; observed ${JSON.stringify(activity.rows)}`);
        }
        await setTimeout(10);
      }
    }
    try {
      await initializeProject(root, "tasks");
      await mkdir(join(root, "node_modules/@kello"), { recursive: true });
      for (const name of ["kello", "valibot", "drizzle-orm"])
        await symlink(
          await realpath(fileURLToPath(new URL(`../../tests/node_modules/${name}`, import.meta.url))),
          join(root, "node_modules", name),
        );
      await writeFile(
        join(root, "kello.config.ts"),
        `import { defineConfig } from "kello/tooling";
      export default defineConfig({project:"tasks",database:{namespace:"${namespace}",metadataNamespace:"${metadataNamespace}"},provider:{projectId:"project",targets:{development:{branchId:"br-development"}}}});`,
      );
      await writeFile(
        join(root, "kello/auth.config.ts"),
        'import { defineRpcAuth } from "kello/server"; export default defineRpcAuth({allowAnonymous:true, authorize: () => {}});',
      );
      const schemaFile = join(root, "kello/schema.ts");
      const initialSource = (await readFile(schemaFile, "utf8")).replace(
        'namespace: "app"',
        `namespace: "${namespace}"`,
      );
      await writeFile(schemaFile, initialSource);
      const first = await prepareProject(root);
      await synchronizeDevelopment({ ...options, sourceVersion: first.version }, provider);
      await admin.query(`ALTER ROLE "${runtimeRole}" LOGIN PASSWORD 'development-test-only'`);
      const startup = { ...options, sourceVersion: first.version };
      runtimeUri = connectionString;
      await assert.rejects(startDevelopmentRuntime(startup, provider), /connection.*target/i);
      runtimeUri = runtimeAddress.href;
      await admin.query(`ALTER ROLE "${runtimeRole}" CREATEDB`);
      await assert.rejects(startDevelopmentRuntime(startup, provider), /Runtime database preflight failed/);
      await admin.query(`ALTER ROLE "${runtimeRole}" NOCREATEDB`);
      await admin.query(`GRANT UPDATE (claim_version) ON "${metadataNamespace}".jobs TO "${runtimeRole}"`);
      await assert.rejects(startDevelopmentRuntime(startup, provider), /Runtime database preflight failed/);
      await admin.query(`REVOKE UPDATE (claim_version) ON "${metadataNamespace}".jobs FROM "${runtimeRole}"`);
      runtimeCredentialsResolved = () => {
        branch.protected = true;
      };
      await assert.rejects(
        startDevelopmentRuntime(startup, provider).then(async (started) => {
          await started.runtime.stop();
          return started;
        }),
        /protected/,
      );
      branch.protected = false;
      runtimeCredentialsResolved = () => {};
      assert.equal(
        (await admin.query(`SELECT count(*) FROM "${metadataNamespace}".deployment_activations`)).rows[0].count,
        "0",
      );
      await expectConnections(0);
      const started = await startDevelopmentRuntime(startup, provider);
      runtimes.push(started.runtime);
      if (!("router" in started.runtime)) throw new Error("Expected native fixture");
      assert.equal(started.binding.branchId, "br-development");
      assert.equal(started.binding.version, first.version);
      assert.ok(!JSON.stringify(started.binding).includes(options.activationToken));
      expect(await callExample(started.runtime, ["tasks", "list"], undefined, null)).toMatchObject({
        ok: true,
        value: [],
      });
      await expectConnections(1);
      await assert.rejects(
        startDevelopmentRuntime({ ...startup, activationToken: "f".repeat(64) }, provider),
        /grant preparation failed/,
      );
      await expectConnections(1);
      await writeFile(
        schemaFile,
        initialSource.replace("title: s.text().notNull()", "title: s.text().notNull(), description: s.text()"),
      );
      const next = await prepareProject(root);
      await assert.rejects(
        startDevelopmentRuntime({ ...startup, sourceVersion: next.version }, provider),
        /not synchronized/,
      );
      await synchronizeDevelopment({ ...options, sourceVersion: next.version }, provider);
      const successor = await startDevelopmentRuntime({ ...startup, sourceVersion: next.version }, provider);
      runtimes.push(successor.runtime);
      if (!("router" in successor.runtime)) throw new Error("Expected native fixture");
      await expectConnections(2);
      expect(await callExample(started.runtime, ["tasks", "list"], undefined, null)).toMatchObject({
        ok: true,
        value: [],
      });
      expect(await callExample(successor.runtime, ["tasks", "list"], undefined, null)).toMatchObject({
        ok: true,
        value: [],
      });
      await assert.rejects(startDevelopmentRuntime(startup, provider), /stale/);
      assert.deepEqual(
        [process.env.NEON_BRANCH, process.env.DATABASE_URL, process.env.LOOM_ACTIVATION_TOKEN],
        environment,
      );
      await admin.query(
        `UPDATE "${metadataNamespace}".deployment_activations SET state = 'quarantined' WHERE version = $1`,
        [first.version],
      );
      expect(await callExample(started.runtime, ["tasks", "list"], undefined, null)).toMatchObject({
        ok: false,
        error: { code: "INTERNAL_SERVER_ERROR" },
      });
      expect(await callExample(successor.runtime, ["tasks", "list"], undefined, null)).toMatchObject({
        ok: true,
        value: [],
      });
      await started.runtime.stop();
      await expectConnections(1);
      await admin.query(
        `UPDATE "${metadataNamespace}".deployment_activations SET branch_id = 'br-foreign' WHERE version = $1`,
        [next.version],
      );
      await assert.rejects(
        startDevelopmentRuntime({ ...startup, sourceVersion: next.version }, provider),
        /grant preparation failed/,
      );
      expect(await callExample(successor.runtime, ["tasks", "list"], undefined, null)).toMatchObject({
        ok: false,
        error: { code: "INTERNAL_SERVER_ERROR" },
      });
      await successor.runtime.stop();
      await expectConnections(0);
      await assert.rejects(
        startDevelopmentRuntime({ ...startup, sourceVersion: next.version, signal: AbortSignal.abort() }, provider),
      );
      await admin.query(
        `UPDATE "${metadataNamespace}".deployment_activations SET branch_id = 'br-development' WHERE version = $1`,
        [next.version],
      );
      await writeFile(
        join(root, "kello/storage.ts"),
        'import { defineProcedureStorage } from "kello/server"; export default defineProcedureStorage({buckets:{uploads:{}}});',
      );
      const storageSource = await readFile(schemaFile, "utf8");
      const withStorage = await prepareProject(root);
      await synchronizeDevelopment({ ...options, sourceVersion: withStorage.version }, provider);
      let closed = 0;
      let onConnect = () => {};
      const storageBackend = {
        projectId: "project",
        branchId: "br-development",
        connect() {
          onConnect();
          return {
            target: { projectId: "project", branchId: "br-development" },
            close() {
              closed++;
            },
            async remove() {
              throw new Error("Unexpected storage request");
            },
            async signUpload() {
              throw new Error("Unexpected storage request");
            },
            async sealUpload() {
              throw new Error("Unexpected storage request");
            },
            async signDownload() {
              throw new Error("Unexpected storage request");
            },
          };
        },
      };
      const storageStartup = { ...startup, sourceVersion: withStorage.version, storageBackend };
      for (const invalid of [
        [],
        [{ name: "uploads", accessLevel: "public_read" as const }],
        [
          { name: "uploads", accessLevel: "private" as const },
          { name: "uploads", accessLevel: "private" as const },
        ],
      ]) {
        buckets = invalid;
        await assert.rejects(
          startDevelopmentRuntime(storageStartup, provider).then(async (started) => {
            await started.runtime.stop();
          }),
          /development storage/i,
        );
      }
      assert.equal(closed, 0);
      const { listBranchBuckets: _listBuckets, ...databaseOnly } = provider;
      await assert.rejects(startDevelopmentRuntime(storageStartup, databaseOnly), /development storage/i);
      await assert.rejects(
        startDevelopmentRuntime(storageStartup, {
          ...provider,
          listBranchBuckets: async () => {
            throw new Error("private-provider-credential");
          },
        }),
        { message: "Could not verify development storage buckets" },
      );
      await assert.rejects(
        startDevelopmentRuntime(
          {
            ...storageStartup,
            storageBackend: { ...storageBackend, branchId: "br-other" },
          },
          provider,
        ),
        /different target/,
      );
      assert.equal(
        (
          await admin.query(`SELECT count(*) FROM "${metadataNamespace}".deployment_activations WHERE version = $1`, [
            withStorage.version,
          ])
        ).rows[0].count,
        "0",
      );
      buckets = [{ name: "uploads", accessLevel: "private" }];
      onConnect = () => {
        writeFileSync(
          schemaFile,
          storageSource.replace("description: s.text()", "description: s.text(), another: s.text()"),
        );
      };
      await assert.rejects(startDevelopmentRuntime(storageStartup, provider), /stale/);
      assert.equal(closed, 1);
      await expectConnections(0);
      await writeFile(schemaFile, storageSource);
      const cancellation = new AbortController();
      onConnect = () => {
        cancellation.abort();
      };
      await assert.rejects(
        startDevelopmentRuntime({ ...storageStartup, signal: cancellation.signal }, provider),
        /aborted/i,
      );
      assert.equal(closed, 2);
      await expectConnections(0);
      onConnect = () => {
        throw new Error("Storage startup rejected");
      };
      await assert.rejects(startDevelopmentRuntime(storageStartup, provider), /Storage startup rejected/);
      await expectConnections(0);
      assert.deepEqual(
        (
          await admin.query(
            `SELECT version,state FROM "${metadataNamespace}".deployment_activations WHERE version IN ($1,$2) ORDER BY version`,
            [next.version, withStorage.version],
          )
        ).rows,
        [
          { version: next.version, state: "active" },
          { version: withStorage.version, state: "quarantined" },
        ].sort((a, b) => a.version.localeCompare(b.version)),
      );
      assert.deepEqual(
        (
          await admin.query(
            `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND column_name IN ('description', 'another') ORDER BY column_name`,
            [namespace],
          )
        ).rows,
        [{ column_name: "description" }],
      );
      const sessionEnvironment = {
        LOOM_TEST_STORAGE_DEV_TOKEN: options.activationToken,
        LOOM_TEST_STORAGE_ACCESS: "fixture-access",
        LOOM_TEST_STORAGE_SECRET: "fixture-secret",
      };
      const previousEnvironment = Object.fromEntries(
        Object.keys(sessionEnvironment).map((name) => [name, process.env[name]]),
      );
      try {
        Object.assign(process.env, sessionEnvironment);
        await writeFile(
          join(root, "kello.dev.json"),
          JSON.stringify({
            format: 1,
            databaseName: options.databaseName,
            migrationRole: options.migrationRole,
            runtimeRole,
            deployment: options.deployment,
            activationTokenEnv: "LOOM_TEST_STORAGE_DEV_TOKEN",
            port: 0,
            storage: {
              projectId: "project",
              branchId: "br-development",
              endpoint: "https://br-development.storage.c-1.us-east-2.aws.neon.tech",
              region: "us-east-2",
              accessKeyIdEnv: "LOOM_TEST_STORAGE_ACCESS",
              secretAccessKeyEnv: "LOOM_TEST_STORAGE_SECRET",
            },
          }),
        );
        // This fixture uses built public exports throughout, including generated project modules.
        const records: DiagnosticsRecord[] = [];
        const runtimeChannel = channel("kello.runtime.metric");
        const deploymentChannel = channel("kello.deployment.metric");
        assert.equal(runtimeChannel.hasSubscribers, false);
        assert.equal(deploymentChannel.hasSubscribers, false);
        const diagnostics = await startDiagnostics({
          output: {
            format: "jsonl",
            write(chunk, signal) {
              assert.equal(signal.aborted, false);
              records.push(JSON.parse(chunk));
            },
          },
        });
        let development: Awaited<ReturnType<typeof startProjectDevelopment>> | undefined;
        const currentFailure = () => development?.failure;
        async function waitFor(description: string, ready: () => boolean) {
          const deadline = Date.now() + 10000;
          while (!ready()) {
            assert.ok(Date.now() < deadline, `Timed out waiting for ${description}`);
            await setTimeout(10);
          }
        }
        async function expectRpcEvents(count: number) {
          await waitFor("diagnostics output", () => records.length === diagnostics.snapshot().accepted);
          const rpc = records.filter((record) => record.source === "runtime" && record.event.type === "rpc.procedure");
          assert.equal(rpc.length, count, "Each completed native RPC must be observed exactly once");
          for (const record of rpc) {
            assert.equal(record.source, "runtime");
            if (record.source !== "runtime" || record.event.type !== "rpc.procedure")
              throw new Error("Expected RPC diagnostics");
            assert.equal(record.event.mode, "finite");
            assert.equal(record.event.status, "success");
            assert.ok(Number.isFinite(record.event.durationMs) && record.event.durationMs >= 0);
          }
          assert.equal(runtimeChannel.hasSubscribers, true);
          assert.equal(deploymentChannel.hasSubscribers, true);
          assert.deepEqual(diagnostics.snapshot(), {
            accepted: records.length,
            invalid: 0,
            dropped: 0,
            outputFailures: 0,
            exportFailures: 0,
          });
        }
        try {
          development = await startProjectDevelopment(root, "kello.dev.json", provider);
          await development.settled();
          assert.equal(development.failure, null);
          assert.ok(development.url);
          assert.ok(development.active);
          const firstVersion = development.active.version;
          const serverUrl = development.url;
          async function readTasks(version: string) {
            const link = new RPCLink({
              origin: serverUrl.origin,
              url: "/api/kello/rpc",
              headers: { "x-loom-protocol": "loom-orpc-2", "x-loom-version": version },
            });
            return link.call(["tasks", "list"], undefined, { context: {} });
          }
          assert.deepEqual(await readTasks(firstVersion), []);
          await expectRpcEvents(1);
          const response = await fetch(new URL("/api/kello/storage", development.url), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          });
          assert.match(await response.text(), /UNAUTHENTICATED/);

          const procedureFile = join(root, "kello/functions/tasks.ts");
          const procedureSource = await readFile(procedureFile, "utf8");
          // Use the filesystem watcher itself: neither flush nor manual prepare drives recovery.
          await writeFile(procedureFile, 'throw new Error("watched-edit-failure-canary");\n');
          await waitFor("failed watched edit", () => development!.failure !== null);
          await development.settled();
          const failedRevision = currentFailure()?.revision;
          assert.ok(failedRevision !== undefined);
          assert.equal(development.watchError, null);
          assert.equal(development.active?.version, firstVersion);
          assert.deepEqual(await readTasks(firstVersion), []);
          await expectRpcEvents(2);
          assert.equal(currentFailure()?.revision, failedRevision);

          const recoveredSource = procedureSource.replace(
            ").map((row) => row.title)",
            ').map((row) => row.title).concat("recovered")',
          );
          assert.notEqual(recoveredSource, procedureSource, "Fixture must change the native handler result");
          const previousConnections = await admin.query<{ pid: number }>(
            "SELECT pid FROM pg_stat_activity WHERE usename = $1",
            [runtimeRole],
          );
          assert.ok(previousConnections.rows.length > 0);
          await writeFile(procedureFile, recoveredSource);
          await waitFor(
            "healthy recovered generation",
            () =>
              development!.failure === null &&
              development!.active !== null &&
              development!.active.version !== firstVersion,
          );
          await development.settled();
          assert.equal(development.failure, null);
          assert.equal(development.watchError, null);
          assert.equal(development.url?.href, serverUrl.href);
          assert.ok(development.active);
          assert.notEqual(development.active.version, firstVersion);
          // Hold a real empty job claim so native RPC deterministically needs a second pooled connection.
          await admin.query("BEGIN");
          await admin.query(`LOCK TABLE "${metadataNamespace}".jobs IN ACCESS EXCLUSIVE MODE`);
          try {
            const deadline = Date.now() + 5000;
            for (;;) {
              const blocked = await admin.query<{ count: number }>(
                "SELECT count(*)::integer AS count FROM pg_stat_activity WHERE usename = $1 AND wait_event_type = 'Lock'",
                [runtimeRole],
              );
              if (blocked.rows[0]?.count) break;
              assert.ok(Date.now() < deadline, "Expected native worker claim to wait on fixture lock");
              await setTimeout(10);
            }
            assert.deepEqual(await readTasks(development.active.version), ["recovered"]);
          } finally {
            await admin.query("ROLLBACK");
          }
          await expectRpcEvents(3);
          const recoveredConnections = await admin.query<{ pid: number }>(
            "SELECT pid FROM pg_stat_activity WHERE usename = $1",
            [runtimeRole],
          );
          assert.equal(recoveredConnections.rows.length, 2, "Worker and RPC share the active generation pool");
          const previousPids = new Set(previousConnections.rows.map(({ pid }) => pid));
          assert.ok(
            recoveredConnections.rows.every(({ pid }) => !previousPids.has(pid)),
            "Every previous generation connection must retire before replacement settles",
          );
        } finally {
          try {
            await development?.stop();
            await waitFor("final diagnostics output", () => records.length === diagnostics.snapshot().accepted);
          } finally {
            await diagnostics.stop();
          }
        }
        assert.equal(runtimeChannel.hasSubscribers, false);
        assert.equal(deploymentChannel.hasSubscribers, false);
        assert.deepEqual(
          records.map((record) => record.sequence),
          records.map((_record, index) => index + 1),
        );
        assert.ok(records.every((record) => record.schemaVersion === 1 && record.scope === "local-process"));
        assert.ok(!JSON.stringify(records).includes("watched-edit-failure-canary"));
        assert.deepEqual(diagnostics.snapshot(), {
          accepted: records.length,
          invalid: 0,
          dropped: 0,
          outputFailures: 0,
          exportFailures: 0,
        });
        const stoppedStats = diagnostics.snapshot();
        const stoppedRecords = records.length;
        runtimeChannel.publish({ type: "rpc.procedure", mode: "finite", status: "success", durationMs: 1 });
        await setTimeout(20);
        assert.deepEqual(diagnostics.snapshot(), stoppedStats);
        assert.equal(records.length, stoppedRecords);
        await expectConnections(0);
      } finally {
        for (const [name, value] of Object.entries(previousEnvironment)) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      }
    } finally {
      await Promise.all(runtimes.map((runtime) => runtime.stop()));
      await admin.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
      await admin.query(`DROP SCHEMA IF EXISTS "${metadataNamespace}" CASCADE`);
      await admin.query(`DROP ROLE IF EXISTS "${runtimeRole}"`);
      await admin.end();
      await rm(root, { recursive: true, force: true });
    }
  },
  60000,
);
