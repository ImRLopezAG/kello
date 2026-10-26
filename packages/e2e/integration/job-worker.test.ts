import assert from "node:assert/strict";
import { channel } from "node:diagnostics_channel";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import {
  connectDatabase,
  createRpcJobQueue,
  createRpcJobWorker,
  defineSchema,
  createProjectProcedures,
  createDatabaseMiddleware,
  bindRpcDatabaseProcedure,
  encodeRpcJobCall,
} from "kello/server";
import { ORPCError } from "@orpc/server";
import { bootstrapDatabase } from "kello-cli";
import { defineRelations, sql } from "drizzle-orm";
import * as v from "valibot";
import pg from "pg";

const connectionString = process.env.LOOM_TEST_DATABASE_URL;
test.skipIf(!connectionString)(
  "Node worker termination recovers claims and replays committed mutations without repeated effects",
  async () => {
    if (!connectionString) throw new Error("Missing database URL");
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const metadataNamespace = `loom_worker_${suffix}`;
    const applicationNamespace = `app_worker_${suffix}`;
    const runtimeRole = `loom_runtime_${suffix}`;
    const admin = new pg.Client({ connectionString });
    await admin.connect();
    try {
      await bootstrapDatabase({ connectionString, metadataNamespace, runtimeRole });
      await admin.query(`CREATE SCHEMA "${applicationNamespace}"`);
      await admin.query(`CREATE TABLE "${applicationNamespace}".effects (value integer NOT NULL)`);
      await admin.query(`INSERT INTO "${applicationNamespace}".effects VALUES (0)`);
      await admin.query(`GRANT USAGE ON SCHEMA "${applicationNamespace}" TO "${runtimeRole}"`);
      await admin.query(`GRANT SELECT, UPDATE ON "${applicationNamespace}".effects TO "${runtimeRole}"`);
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
        const deployment = "worker-test";
        let actionCalls = 0;
        const actionJobIds: string[] = [];
        const slowStarted = Promise.withResolvers<void>();
        let denied = false;
        const authorize = async (context: { identity: { subject: string } | null }) => {
          if (denied || context.identity?.subject !== "alice") throw new ORPCError("FORBIDDEN");
        };
        const { procedure: baseProcedure } = createProjectProcedures(schema);
        const procedure = baseProcedure.use(async ({ context, next }) => {
          await authorize(context);
          return next();
        });
        const definitions = {
          "jobs:write": procedure
            .use(createDatabaseMiddleware(relations, "write", schema))
            .input(v.null())
            .output(v.number())
            .handler(async ({ context }) => {
              assert.ok(context.job);
              expect(Object.isFrozen(context.job)).toBe(true);
              expect(context.job.attempt).toBe(2);
              const identity = await context.db.execute<{ value: string }>(
                sql`SELECT current_setting('kello.identity') AS value`,
              );
              expect(JSON.parse(identity.rows[0]?.value ?? "null")).toEqual({ issuer: "test", subject: "alice" });
              const result = await context.db.execute<{ value: number }>(
                sql`UPDATE ${sql.identifier(applicationNamespace)}.effects SET value = value + 1 RETURNING value`,
              );
              return result.rows[0]?.value ?? -1;
            }),
          "jobs:external": procedure
            .input(v.null())
            .output(v.null())
            .handler(({ context }) => {
              assert.ok(context.job);
              actionJobIds.push(context.job.id);
              actionCalls++;
              throw Object.assign(new Error("external-secret"), { code: "40001" });
            }),
          "jobs:slow": procedure
            .input(v.null())
            .output(v.null())
            .handler(async ({ context }) => {
              const pending = Promise.withResolvers<null>();
              const abort = () => pending.reject(new Error("Action cancelled"));
              context.signal.addEventListener("abort", abort, { once: true });
              slowStarted.resolve();
              try {
                return await pending.promise;
              } finally {
                context.signal.removeEventListener("abort", abort);
              }
            }),
        };
        const internal = [
          {
            path: ["jobs", "write"],
            procedure: bindRpcDatabaseProcedure(definitions["jobs:write"], {
              connection,
              replay: { deployment, metadataNamespace },
              authorize,
            }),
          },
          { path: ["jobs", "external"], procedure: definitions["jobs:external"] },
          { path: ["jobs", "slow"], procedure: definitions["jobs:slow"] },
        ];
        const queue = createRpcJobQueue({ db: connection.db, version, internal, deployment, metadataNamespace });
        const worker = createRpcJobWorker({ queue, internal, assertActive: async () => {}, leaseSeconds: 1 });
        const call = encodeRpcJobCall(version, ["jobs", "write"], null);
        const identity = { issuer: "test", subject: "alice" };
        const schedule = { dueAt: new Date(0), maxAttempts: 2, retryDelaySeconds: 0 };
        try {
          let expectedEffects = 0;
          for (const [crash, manual] of [
            ["claimed", false],
            ["committed", false],
            ["committed", true],
          ] as const) {
            const id = await queue.enqueue(connection.db, call, identity, {
              ...schedule,
              maxAttempts: manual ? 1 : 2,
              deduplicationKey: `${crash}-${manual}`,
            });
            const child = Bun.spawn(["node", fileURLToPath(new URL("../fixtures/job-worker.ts", import.meta.url))], {
              env: {
                ...process.env,
                LOOM_TEST_DATABASE_URL: address.href,
                LOOM_TEST_JOB_METADATA: metadataNamespace,
                LOOM_TEST_JOB_SCHEMA: applicationNamespace,
                LOOM_TEST_JOB_CRASH: crash,
              },
              stdout: "pipe",
              stderr: "pipe",
            });
            const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
            try {
              const reader = child.stdout.getReader();
              let output = "";
              while (!output.includes("\n")) {
                const next = await reader.read();
                if (next.done) break;
                output += new TextDecoder().decode(next.value);
              }
              reader.releaseLock();
              expect(output).toBe(`${crash}\n`);
              child.kill("SIGKILL");
              expect(await child.exited).not.toBe(0);
              expect(await new Response(child.stderr).text()).toBe("");
            } finally {
              clearTimeout(timer);
              child.kill("SIGKILL");
              await child.exited;
            }
            const beforeRecovery = expectedEffects + (crash === "committed" ? 1 : 0);
            expect((await admin.query(`SELECT value FROM "${applicationNamespace}".effects`)).rows).toEqual([
              { value: beforeRecovery },
            ]);
            await admin.query("SELECT pg_sleep(1.1)");
            if (manual) {
              expect(await worker.run(1)).toMatchObject({ claimed: 0 });
              const failed = await queue.inspect(id);
              assert.ok(failed);
              expect(failed).toMatchObject({ state: "failed", errorCode: "LEASE_EXPIRED" });
              expect(await queue.replay(id, failed.fencingToken, new Date(0))).toBe(true);
            }
            expect(await worker.run(1)).toEqual({ claimed: 1, completed: 1, failed: 0, leaseLost: 0 });
            expectedEffects++;
            expect((await admin.query(`SELECT value FROM "${applicationNamespace}".effects`)).rows).toEqual([
              { value: expectedEffects },
            ]);
            expect(await queue.inspect(id)).toMatchObject({
              state: "succeeded",
              attempts: manual ? 1 : 2,
              result: { protocol: "loom-orpc-2", payload: { json: expectedEffects } },
            });
          }
          const revoked = await queue.enqueue(connection.db, call, identity, {
            ...schedule,
            maxAttempts: 1,
            deduplicationKey: "revoked",
          });
          denied = true;
          expect(await worker.run(1)).toMatchObject({ claimed: 1, failed: 1 });
          expect(await queue.inspect(revoked)).toMatchObject({ state: "failed", errorCode: "FORBIDDEN" });
          denied = false;
          const incompatible = await queue.enqueue(connection.db, call, identity, {
            ...schedule,
            deduplicationKey: "different-runtime-version",
          });
          const replacementQueue = createRpcJobQueue({
            db: connection.db,
            version: "b".repeat(64),
            internal,
            deployment,
            metadataNamespace,
          });
          expect(await replacementQueue.claim("replacement", 1)).toBeNull();
          expect(await queue.inspect(incompatible)).toMatchObject({ state: "pending", attempts: 0 });
          expect(await queue.cancel(incompatible)).toBe("cancelled");
          const external = await queue.enqueue(
            connection.db,
            encodeRpcJobCall(version, ["jobs", "external"], null),
            identity,
            { dueAt: new Date(0), deduplicationKey: "external" },
          );
          expect(await worker.run(10)).toMatchObject({ claimed: 1, failed: 1 });
          expect(actionCalls).toBe(1);
          expect(actionJobIds).toEqual([external]);
          expect(await queue.inspect(external)).toMatchObject({ state: "failed", errorCode: "INTERNAL" });
          expect(JSON.stringify(await queue.inspect(external))).not.toContain("external-secret");
          const retried = await queue.enqueue(
            connection.db,
            encodeRpcJobCall(version, ["jobs", "external"], null),
            identity,
            {
              ...schedule,
              deduplicationKey: "explicit-action-retry",
            },
          );
          expect(await worker.run(10)).toMatchObject({ claimed: 2, failed: 2 });
          expect(actionCalls).toBe(3);
          expect(actionJobIds).toEqual([external, retried, retried]);
          const slow = await queue.enqueue(connection.db, encodeRpcJobCall(version, ["jobs", "slow"], null), identity, {
            ...schedule,
            deduplicationKey: "running-cancellation",
          });
          const running = worker.run(1);
          await slowStarted.promise;
          await new Promise((resolve) => setTimeout(resolve, 1100));
          expect(await queue.claim("competing-worker", 1)).toBeNull();
          const metrics = channel("kello.runtime.metric");
          const losses: string[] = [];
          const capture: Parameters<typeof metrics.subscribe>[0] = (event) => {
            if (v.parse(v.object({ type: v.string() }), event).type === "job.lease.lost") {
              losses.push(JSON.stringify(event));
            }
          };
          metrics.subscribe(capture);
          try {
            expect(await queue.cancel(slow)).toBe("requested");
            expect(await running).toMatchObject({ claimed: 1, failed: 1 });
            expect(losses).toEqual([JSON.stringify({ type: "job.lease.lost", reason: "ownership" })]);
          } finally {
            metrics.unsubscribe(capture);
          }
          expect(await queue.inspect(slow)).toMatchObject({ state: "cancelled", attempts: 1 });
          expect((await admin.query(`SELECT value FROM "${applicationNamespace}".effects`)).rows).toEqual([
            { value: expectedEffects },
          ]);
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
  20000,
);
