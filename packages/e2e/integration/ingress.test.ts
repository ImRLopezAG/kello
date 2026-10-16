import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { test } from "bun:test";
import pg from "pg";
import { defineRelations } from "drizzle-orm";
import * as v from "valibot";
import {
  connectDatabase,
  createRpcStorageEventDispatcher,
  defineSchema,
  createRpcCronDispatcher,
  createRpcJobQueue,
  createRpcJobWorker,
  createProjectProcedures,
  encodeRpcJobCall,
} from "kello/server";
import { createNeonActivationVerifier, createNeonIngressVerifier, neonIngressLockKey } from "kello/neon";
import { bootstrapDatabase, defineConfig } from "kello/tooling";
import type { NeonApi } from "@neon/config-runtime/v1";
import { createRealNeonApi } from "@neon/config-runtime/v1";
import { withDeploymentConnection } from "../../../apps/kello/src/tooling/deploy/neon/connection";
import { handoffNeonIngress } from "../../../apps/kello/src/tooling/deploy/neon/ingress";

const connectionString = process.env.LOOM_TEST_DATABASE_URL;
test.skipIf(!connectionString)(
  "ingress handoff waits for admitted cron transactions and preserves old queued execution",
  async () => {
    if (!connectionString) throw new Error("Missing database");
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const metadataNamespace = `loom_${suffix}`;
    const runtimeRole = `runtime_${suffix}`;
    const admin = new pg.Client({ connectionString });
    await admin.connect();
    const saved = ["NEON_BRANCH", "DATABASE_URL", "LOOM_ACTIVATION_TOKEN"].map(
      (name) => [name, process.env[name]] as const,
    );
    try {
      await bootstrapDatabase({ connectionString, metadataNamespace, runtimeRole });
      await admin.query(`ALTER ROLE "${runtimeRole}" LOGIN PASSWORD 'loom-test-only'`);
      const address = new URL(connectionString);
      const migrationRole = decodeURIComponent(address.username);
      address.username = runtimeRole;
      address.password = "loom-test-only";
      const version = "a".repeat(64);
      const token = "b".repeat(64);
      const binding = {
        metadataNamespace,
        deployment: "app",
        version,
        projectId: "project",
        branchId: "branch",
        branchName: "preview",
        endpointHost: address.hostname,
        databaseName: decodeURIComponent(address.pathname.slice(1)),
      };
      process.env.NEON_BRANCH = binding.branchName;
      process.env.DATABASE_URL = address.href;
      process.env.LOOM_ACTIVATION_TOKEN = token;
      await admin.query(
        `INSERT INTO "${metadataNamespace}".deployment_activations(deployment,version,project_id,branch_id,endpoint_host,database_name,token_hash,state) VALUES('app',$1,'project','branch',$2,$3,$4,'active')`,
        [version, binding.endpointHost, binding.databaseName, createHash("sha256").update(token).digest("hex")],
      );
      await admin.query(
        `INSERT INTO "${metadataNamespace}".release_ingress VALUES('project','branch','app',$1,$2,'current')`,
        ["c".repeat(64), version],
      );
      const schema = defineSchema(() => ({}));
      const connection = await connectDatabase({
        connectionString: address.href,
        schema,
        relations: defineRelations(schema.tables),
        maxConnections: 1,
      });
      const entered = Promise.withResolvers<void>();
      const drain = Promise.withResolvers<void>();
      let executions = 0;
      try {
        const verify = createNeonIngressVerifier(binding);
        const context = { connectionString: address.href, deployment: "app", version, metadataNamespace };
        const { procedure } = createProjectProcedures(schema);
        const run = procedure
          .input(v.object({}))
          .output(v.null())
          .handler(() => {
            executions++;
            return null;
          });
        const internal = [{ path: ["tasks", "run"], procedure: run }];
        const queueOptions = { db: connection.db, deployment: "app", version, metadataNamespace, internal };
        const queue = createRpcJobQueue(queueOptions);
        const dispatcher = createRpcCronDispatcher({
          ...queueOptions,
          queue,
          crons: {
            minute: { schedule: "* * * * *", call: encodeRpcJobCall(version, ["tasks", "run"], {}), maxAttempts: 1 },
          },
          assertActive: async () => {},
          assertIngress: async (signal, db) => {
            await verify(signal, { ...context, db });
            entered.resolve();
            await drain.promise;
          },
        });
        const admitted = dispatcher.dispatch("minute", new Date("2026-01-01T00:00:00Z"));
        await entered.promise;
        const provider: NeonApi = {
          ...createRealNeonApi({ apiKey: "fixture", baseUrl: "http://127.0.0.1:1" }),
          getProject: async () => ({ id: "project", name: "fixture", regionId: "aws-us-east-2", pgVersion: 18 }),
          listBranches: async () => [{ id: "branch", name: "preview", protected: false, isDefault: false }],
          listEndpoints: async () => [
            {
              id: address.hostname.split(".")[0] ?? "",
              branchId: "branch",
              type: "read_write" as const,
              autoscalingLimitMinCu: 0.25,
              autoscalingLimitMaxCu: 1,
              suspendTimeout: 300,
            },
          ],
          getConnectionUri: async () => ({ uri: connectionString }),
        };
        const config = defineConfig({
          project: "ingress",
          database: { metadataNamespace },
          provider: { projectId: "project", targets: { preview: { branchId: "branch" } } },
        });
        const started = Promise.withResolvers<number>();
        const handoff = withDeploymentConnection(
          { config, environment: "preview", databaseName: binding.databaseName, migrationRole },
          async (client) => {
            const process = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0];
            assert.ok(process);
            started.resolve(process.pid);
            await handoffNeonIngress(
              client,
              {
                config,
                environment: "preview",
                deployment: "app",
                version: "d".repeat(64),
                releaseKey: "e".repeat(64),
                workerSlug: "nextworker",
              },
              provider,
            );
          },
          provider,
        );
        const pid = await started.promise;
        let waiting = false;
        for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
          waiting =
            (await admin.query("SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND NOT granted", [pid]))
              .rowCount === 1;
          if (!waiting) await setTimeout(10);
        }
        drain.resolve();
        await Promise.all([admitted, handoff]);
        assert.equal(waiting, true, "handoff must wait for the admitted transaction");
        await assert.rejects(dispatcher.dispatch("minute", new Date("2026-01-01T00:01:00Z")), /ingress denied/i);
        await admin.query(`UPDATE "${metadataNamespace}".release_ingress SET version=$1 WHERE state='current'`, [
          version,
        ]);
        await assert.rejects(
          connection.db.transaction((db) => verify(new AbortController().signal, { ...context, db }), {
            isolationLevel: "repeatable read",
          }),
          /ingress denied/i,
        );
        await admin.query("BEGIN");
        await admin.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [neonIngressLockKey(binding)]);
        let watchdogReleased = false;
        const watchdog = setTimeout(1000).then(async () => {
          watchdogReleased = true;
          await admin.query("ROLLBACK");
        });
        const cancelled = AbortSignal.timeout(30);
        try {
          await assert.rejects(
            connection.db.transaction((db) => verify(cancelled, { ...context, db })),
            /ingress denied|aborted|timeout/i,
          );
          assert.equal(watchdogReleased, false, "cancellation must not wait for the exclusive holder");
        } finally {
          await watchdog;
        }
        await admin.query(`UPDATE "${metadataNamespace}".release_ingress SET version=$1 WHERE state='current'`, [
          "d".repeat(64),
        ]);
        const receipts = createRpcStorageEventDispatcher({
          ...queueOptions,
          projectId: binding.projectId,
          branchId: binding.branchId,
          queue,
          handlers: { uploads: { path: ["tasks", "run"], maxAttempts: 1 } },
          intents: {
            finalize: async () => {
              throw new Error("Retired ingress must not verify objects");
            },
          },
          assertActive: async () => {},
          assertIngress: (signal, db) => verify(signal, { ...context, db }),
        });
        assert.deepEqual(await receipts.reconcile(1), {
          claimed: 0,
          dispatched: 0,
          failed: 0,
          pending: 0,
          inactive: true,
        });
        const active = createNeonActivationVerifier(binding);
        const worker = createRpcJobWorker({
          queue,
          internal,
          assertActive: (signal) => active(signal, { ...context, db: connection.db }),
        });
        try {
          assert.equal((await worker.run()).completed, 1);
          assert.equal(executions, 1);
        } finally {
          await worker.stop();
        }
        assert.equal(
          (await admin.query(`SELECT count(*)::int AS total FROM "${metadataNamespace}".jobs`)).rows[0].total,
          1,
        );
      } finally {
        drain.resolve();
        await connection.close();
      }
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await admin.query(`DROP SCHEMA IF EXISTS "${metadataNamespace}" CASCADE`);
      await admin.query(`DROP ROLE IF EXISTS "${runtimeRole}"`);
      await admin.end();
    }
  },
  20000,
);
