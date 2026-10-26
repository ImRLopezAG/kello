import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  connectDatabase,
  createRpcCronDispatcher,
  createRpcJobQueue,
  createRpcJobWorker,
  encodeRpcJobCall,
  defineSchema,
  createProjectProcedures,
  createDatabaseMiddleware,
  bindRpcDatabaseProcedure,
} from "kello/server";
import { createNeonTriggers } from "kello/neon";
import { bootstrapDatabase, defineConfig, prepareNeonScheduleTriggers } from "kello-cli";
import type { DeploymentTriggerProvider } from "kello-cli";
import { defineRelations, sql } from "drizzle-orm";
import * as v from "valibot";
import pg from "pg";

const connectionString = process.env.LOOM_TEST_DATABASE_URL;
test.skipIf(!connectionString)(
  "native cron occurrences persist once across dispatchers and completed-job redelivery",
  async () => {
    if (!connectionString) throw new Error("Missing database URL");
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const metadataNamespace = `loom_cron_${suffix}`;
    const applicationNamespace = `app_cron_${suffix}`;
    const runtimeRole = `loom_runtime_${suffix}`;
    const admin = new pg.Client({ connectionString });
    await admin.connect();
    try {
      await bootstrapDatabase({ connectionString, metadataNamespace, runtimeRole });
      await admin.query(`CREATE SCHEMA "${applicationNamespace}"`);
      await admin.query(`CREATE TABLE "${applicationNamespace}".effects (job_id uuid PRIMARY KEY, value integer)`);
      await admin.query(`GRANT USAGE ON SCHEMA "${applicationNamespace}" TO "${runtimeRole}"`);
      await admin.query(`GRANT SELECT, INSERT ON "${applicationNamespace}".effects TO "${runtimeRole}"`);
      await admin.query(`ALTER ROLE "${runtimeRole}" LOGIN PASSWORD 'loom-test-only'`);
      const address = new URL(connectionString);
      address.username = runtimeRole;
      address.password = "loom-test-only";
      const schema = defineSchema(() => ({}));
      const relations = defineRelations(schema.tables);
      const connection = await connectDatabase({
        schema,
        relations,
        connectionString: address.href,
      });
      try {
        const version = "a".repeat(64);
        const { procedure } = createProjectProcedures(schema);
        const handler = procedure
          .use(createDatabaseMiddleware(relations, "write", schema))
          .input(v.object({ value: v.number() }))
          .output(v.null())
          .handler(async ({ context, input: args }) => {
            assert.ok(context.job);
            assert.equal(context.identity, null);
            await context.db.execute(
              sql`INSERT INTO ${sql.identifier(applicationNamespace)}.effects VALUES (${context.job.id}::uuid, ${args.value})`,
            );
            return null;
          });
        const internal = [{ path: ["jobs", "cron"], procedure: handler }];
        const declarationFor = (version: string, value: number) => ({
          schedule: "* * * * *",
          call: encodeRpcJobCall(version, ["jobs", "cron"], { value }),
          maxAttempts: 1,
        });
        const queueOptions = { db: connection.db, deployment: "cron-test", metadataNamespace, version, internal };
        const queue = createRpcJobQueue(queueOptions);
        const declaration = declarationFor(version, 1);
        const crons = { minute: declaration, second: declaration };
        const options = {
          db: connection.db,
          deployment: queueOptions.deployment,
          metadataNamespace,
          queue,
          crons,
          assertActive: async () => {},
        };
        const first = createRpcCronDispatcher(options);
        const second = createRpcCronDispatcher({ ...options, queue: createRpcJobQueue(queueOptions) });
        crons.minute = declarationFor(version, 9);
        const occurrence = new Date("2026-01-01T00:00:00Z");
        const [a, b] = await Promise.all([first.dispatch("minute", occurrence), second.dispatch("minute", occurrence)]);
        assert.equal(a, b);
        const bound = bindRpcDatabaseProcedure(handler, {
          connection,
          replay: queueOptions,
          authorize: async () => {},
        });
        const worker = createRpcJobWorker({
          queue,
          internal: [{ path: ["jobs", "cron"], procedure: bound }],
          assertActive: options.assertActive,
        });
        try {
          assert.deepEqual(await worker.run(), { claimed: 1, completed: 1, failed: 0, leaseLost: 0 });
          assert.equal(await second.dispatch("minute", new Date(occurrence)), a);
          assert.equal((await worker.run()).claimed, 0);
          assert.equal(
            (await admin.query(`SELECT count(*)::int AS total FROM "${metadataNamespace}".jobs`)).rows[0].total,
            1,
          );
          assert.deepEqual((await admin.query(`SELECT value FROM "${applicationNamespace}".effects`)).rows, [
            { value: 1 },
          ]);
          assert.notEqual(await second.dispatch("second", occurrence), a);
          assert.equal((await worker.run()).completed, 1);
          await assert.rejects(first.dispatch("unknown", occurrence), /not configured/);
          await assert.rejects(first.dispatch("minute", new Date("invalid")), /Invalid/);
          const denied = createRpcCronDispatcher({
            ...options,
            assertActive: async () => {
              throw new Error("inactive clone");
            },
          });
          await assert.rejects(denied.dispatch("minute", new Date("2026-01-01T00:01:00Z")), /inactive clone/);
          assert.equal((await worker.run()).claimed, 0);
          const changed = createRpcCronDispatcher(options);
          await assert.rejects(changed.dispatch("minute", occurrence), /deduplication conflict/);
          const changedVersion = "b".repeat(64);
          const redeployed = createRpcCronDispatcher({
            ...options,
            queue: createRpcJobQueue({ ...queueOptions, version: changedVersion }),
            crons: { minute: declarationFor(changedVersion, 1) },
          });
          await assert.rejects(redeployed.dispatch("minute", occurrence), /deduplication conflict/);
          assert.equal((await queue.inspect(a))?.state, "succeeded");
          const wake = { invocationId: "wake-one", triggerId: "wake-trigger", triggerName: "worker" };
          await Promise.all([first.recordWake(wake, occurrence), second.recordWake(wake, occurrence)]);
          await assert.rejects(first.recordWake(wake, new Date("2026-01-01T00:01:00Z")), /invocation conflict/);
          const conflicting = { invocationId: "cron-one", triggerId: "trigger-minute", triggerName: "minute" };
          const conflictJob = await first.dispatch("minute", new Date("2026-01-01T00:04:00Z"), undefined, conflicting);
          await assert.rejects(
            first.dispatch("minute", new Date("2026-01-01T00:05:00Z"), undefined, conflicting),
            /invocation conflict/,
          );
          assert.equal(await queue.cancel(conflictJob), "cancelled");
          await admin.query(`REVOKE INSERT ON "${metadataNamespace}".trigger_receipts FROM "${runtimeRole}"`);
          try {
            await assert.rejects(
              first.dispatch("minute", new Date("2026-01-01T00:06:00Z"), undefined, {
                ...conflicting,
                invocationId: "receipt-denied",
              }),
            );
          } finally {
            await admin.query(`GRANT INSERT ON "${metadataNamespace}".trigger_receipts TO "${runtimeRole}"`);
          }
          assert.equal(
            (await admin.query(`SELECT count(*)::int AS total FROM "${metadataNamespace}".jobs`)).rows[0].total,
            3,
          );
          await assert.rejects(
            connection.pool.query(`DELETE FROM "${metadataNamespace}".trigger_receipts`),
            /permission denied/,
          );
          await assert.rejects(
            connection.pool.query(`UPDATE "${metadataNamespace}".trigger_receipts SET trigger_name = 'changed'`),
            /permission denied/,
          );
          const providerTriggers: Awaited<ReturnType<DeploymentTriggerProvider["listBranchTriggers"]>> = [];
          const provider: DeploymentTriggerProvider = {
            getProject: async () => ({ id: "project", name: "tasks", regionId: "aws-us-east-2", pgVersion: 18 }),
            listBranches: async () => [{ id: "br-preview", name: "preview", protected: false, isDefault: false }],
            listEndpoints: async () => [
              {
                id: "ep-preview",
                branchId: "br-preview",
                type: "read_write",
                autoscalingLimitMinCu: 0.25,
                autoscalingLimitMaxCu: 1,
                suspendTimeout: 300,
              },
            ],
            listBranchFunctions: async () => [
              {
                id: "worker",
                slug: "loomworker",
                name: "worker",
                invocationUrl: "https://example.test",
                activeDeploymentId: 1,
                currentDeployment: { id: 1, status: "completed" },
              },
            ],
            listBranchTriggers: async () => structuredClone(providerTriggers),
            createBranchTrigger: async (_project, _branch, input) => {
              assert.equal(input.enabled, false);
              assert.equal(input.type, "schedule");
              if (input.type !== "schedule") throw new Error("Unexpected trigger type");
              const created = {
                type: "schedule" as const,
                triggerId: crypto.randomUUID(),
                name: input.name,
                functionSlug: input.functionSlug,
                functionPath: input.functionPath ?? "/",
                enabled: false,
                inherited: false,
                cron: input.cron,
                nextRunAt: null,
              };
              providerTriggers.push(created);
              return created;
            },
            updateBranchTrigger: async () => {
              throw new Error("Unexpected trigger update");
            },
          };
          const prepared = await prepareNeonScheduleTriggers(
            {
              config: defineConfig({
                project: "tasks",
                database: { metadataNamespace },
                provider: { projectId: "project", targets: { preview: { branchId: "br-preview" } } },
              }),
              environment: "preview",
              workerSlug: "loomworker",
              schedules: [
                {
                  name: "minute",
                  schedule: declaration.schedule,
                  binding: { kind: "cron", name: "minute", cron: "minute" },
                },
              ],
            },
            provider,
          );
          const providerTriggerId = prepared.triggers[0]?.triggerId;
          assert.ok(providerTriggerId);
          const app = createNeonTriggers({ bindings: prepared.bindings, crons: first, worker });
          function delivery() {
            return new Request("https://api.example.test/api/kello/triggers", {
              method: "POST",
              headers: { "content-type": "application/json", "x-neon-trigger-invocation-id": "occurrence-three" },
              body: JSON.stringify({
                version: 1,
                invocation_id: "occurrence-three",
                trigger: { type: "schedule", id: providerTriggerId, name: "minute" },
                data: { scheduled_at: "2026-01-01T00:03:00Z" },
              }),
            });
          }
          try {
            const responses = await Promise.all([app.fetch(delivery()), app.fetch(delivery())]);
            assert.ok(responses.every((response) => response.status === 200));
            assert.equal((await app.fetch(delivery())).status, 200);
            const receipts = await admin.query(
              `SELECT invocation_id, trigger_id, job_id FROM "${metadataNamespace}".trigger_receipts WHERE invocation_id = 'occurrence-three'`,
            );
            assert.equal(receipts.rows.length, 1);
            assert.equal(receipts.rows[0].invocation_id, "occurrence-three");
            assert.equal(receipts.rows[0].trigger_id, providerTriggerId);
            assert.equal((await queue.inspect(receipts.rows[0].job_id))?.state, "succeeded");
            assert.deepEqual((await admin.query(`SELECT value FROM "${applicationNamespace}".effects`)).rows, [
              { value: 1 },
              { value: 1 },
              { value: 1 },
            ]);
          } finally {
            await worker.stop();
          }
          const aborted = AbortSignal.abort();
          await assert.rejects(first.dispatch("minute", new Date("2026-01-01T00:02:00Z"), aborted));
          assert.equal(
            (await admin.query(`SELECT count(*)::int AS total FROM "${metadataNamespace}".jobs`)).rows[0].total,
            4,
          );
        } finally {
          await worker.stop();
        }
      } finally {
        await connection.close();
      }
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS "${applicationNamespace}" CASCADE`);
      await admin.query(`DROP SCHEMA IF EXISTS "${metadataNamespace}" CASCADE`);
      await admin.query(`DROP ROLE IF EXISTS "${runtimeRole}"`);
      await admin.end();
    }
  },
);
