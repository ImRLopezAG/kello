import { expect, test } from "bun:test";
import { call } from "@orpc/server";
import { Context } from "effect";
import { evaluateSnapshot } from "../../../apps/kello/src/core/server/rpc/snapshot";
import { channel } from "node:diagnostics_channel";
import { setTimeout } from "node:timers/promises";
import { cpus, platform, arch } from "node:os";
import pg from "pg";
import { defineRelations, sql } from "drizzle-orm";
import * as v from "valibot";
import {
  connectDatabase,
  bindRpcDatabaseProcedure,
  createDatabaseMiddleware,
  createProjectProcedures,
  Invocation,
  createRevisionReader,
  createRevisionCoordinator,
  defineSchema,
  runFunctionTransaction,
} from "../../../apps/kello/src/core/server/index";
import { bootstrapDatabase, installRevisionTracking } from "kello/tooling";

function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: sorted[Math.max(0, Math.ceil(sorted.length * 0.5) - 1)] ?? 0,
    p95: sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0,
    max: sorted.at(-1) ?? 0,
  };
}

const connectionString = process.env.LOOM_TEST_DATABASE_URL;
test.skipIf(!connectionString)(
  "capacity workload measures revision contention and subscriber convergence",
  async () => {
    if (!connectionString) throw new Error("Missing database URL");
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const metadata = `loom_capacity_${suffix}`;
    const namespace = `app_${suffix}`;
    const role = `runtime_${suffix}`;
    const admin = new pg.Client({ connectionString });
    await admin.connect();
    try {
      await bootstrapDatabase({ connectionString, metadataNamespace: metadata, runtimeRole: role });
      await admin.query(`CREATE SCHEMA "${namespace}"`);
      await admin.query(`CREATE TABLE "${namespace}".counters (id integer PRIMARY KEY, value integer NOT NULL)`);
      await admin.query(`INSERT INTO "${namespace}".counters SELECT id, 0 FROM generate_series(0, 7) AS id`);
      await admin.query("BEGIN");
      await installRevisionTracking(admin, namespace, metadata, ["counters"]);
      await admin.query("COMMIT");
      await admin.query(`GRANT USAGE ON SCHEMA "${namespace}" TO "${role}"`);
      await admin.query(`GRANT SELECT, UPDATE ON "${namespace}".counters TO "${role}"`);
      await admin.query(`ALTER ROLE "${role}" LOGIN PASSWORD 'loom-test-only'`);
      const address = new URL(connectionString);
      address.username = role;
      address.password = "loom-test-only";
      const schema = defineSchema(() => ({}));
      const options = {
        connectionString: address.href,
        schema,
        relations: defineRelations(schema.tables),
        maxConnections: 4,
      };
      const first = await connectDatabase(options);
      try {
        const second = await connectDatabase(options);
        try {
          const connections = [first, second];
          const { procedure } = createProjectProcedures(schema);
          const revisions = createRevisionReader({ namespace, metadataNamespace: metadata, tables: ["counters"] });
          const counter = procedure
            .use(createDatabaseMiddleware(options.relations, "read", schema))
            .handler(async ({ context }) => {
              const result = await context.db.execute<{ total: number }>(
                sql`SELECT SUM(value)::integer AS total FROM ${sql.identifier(namespace)}.counters`,
              );
              return result.rows[0]?.total ?? 0;
            });
          const procedures = connections.map((connection) =>
            bindRpcDatabaseProcedure(counter, {
              connection,
              revisions,
              replay: { deployment: "capacity", metadataNamespace: metadata },
              authorize: async () => {},
            }),
          );
          for (const workload of [
            { writers: 1, subscribers: 2 },
            { writers: 4, subscribers: 16 },
            { writers: 8, subscribers: 64 },
          ]) {
            await admin.query(`UPDATE "${namespace}".counters SET value = 0`);
            const acquisitionMs: number[] = [];
            const evaluationMs: number[] = [];
            const revisionMs: number[] = [];
            const writeMs: number[] = [];
            let retries = 0;
            let peakConnections = 0;
            let peakWaiting = 0;
            const metrics = channel("kello.runtime.metric");
            const capture: Parameters<typeof metrics.subscribe>[0] = (event) => {
              const { type } = v.parse(v.object({ type: v.string() }), event);
              if (type === "transaction.retry") retries++;
              if (["database.acquire", "revision.read"].includes(type)) {
                const timing = v.parse(v.object({ durationMs: v.pipe(v.number(), v.finite(), v.minValue(0)) }), event);
                if (type === "database.acquire") acquisitionMs.push(timing.durationMs);
                if (type === "revision.read") revisionMs.push(timing.durationMs);
                peakConnections = Math.max(peakConnections, first.pool.totalCount + second.pool.totalCount);
                peakWaiting = Math.max(peakWaiting, first.pool.waitingCount + second.pool.waitingCount);
              }
            };
            metrics.subscribe(capture);
            const latest = Array.from({ length: workload.subscribers }, () => -1);
            const closed: string[] = [];
            const pollers = connections.map((connection) =>
              createRevisionCoordinator({
                readRevisions: () => revisions(connection.db),
                intervalMs: 60_000,
                concurrency: 4,
              }),
            );
            try {
              for (let index = 0; index < workload.subscribers; index++) {
                const poller = pollers[index % 2];
                if (!poller) throw new Error("Missing poller");
                poller.subscribe(
                  {
                    expiresAt: Math.floor(Date.now() / 1000) + 120,
                  },
                  {
                    evaluate: async (signal) => {
                      const item = procedures[index % 2];
                      if (!item) throw new Error("Missing procedure");
                      const invocation = {
                        identity: { issuer: "capacity", subject: String(index) },
                        requestId: crypto.randomUUID(),
                        signal,
                      };
                      const started = performance.now();
                      try {
                        return await evaluateSnapshot(() =>
                          call(item, undefined, {
                            context: { ...invocation, "effect/context": Context.make(Invocation, invocation) },
                          }),
                        );
                      } finally {
                        evaluationMs.push(performance.now() - started);
                      }
                    },
                    publish: (value) => {
                      latest[index] = value;
                      return true;
                    },
                    close: (reason) => closed.push(reason),
                  },
                );
              }
              await Promise.all(pollers.map((poller) => poller.poll()));
              expect(latest.every((value) => value === 0)).toBe(true);
              acquisitionMs.length = 0;
              evaluationMs.length = 0;
              revisionMs.length = 0;
              peakConnections = 0;
              peakWaiting = 0;
              retries = 0;
              let finished = false;
              const started = performance.now();
              const writing = Promise.allSettled(
                Array.from({ length: workload.writers }, async (_, writer) => {
                  const connection = connections[writer % 2];
                  if (!connection) throw new Error("Missing writer connection");
                  for (let iteration = 0; iteration < 10; iteration++) {
                    const before = performance.now();
                    await runFunctionTransaction(
                      connection,
                      "mutation",
                      async (tx) => {
                        await tx.execute(
                          sql`UPDATE ${sql.identifier(namespace)}.counters SET value = value + 1 WHERE id = ${writer}`,
                        );
                      },
                      { maxAttempts: 10 },
                    );
                    writeMs.push(performance.now() - before);
                  }
                }),
              )
                .then((outcomes) => {
                  for (const outcome of outcomes) if (outcome.status === "rejected") throw outcome.reason;
                })
                .finally(() => {
                  finished = true;
                });
              const polling = (async () => {
                while (!finished) {
                  await Promise.all(pollers.map((poller) => poller.poll()));
                  await setTimeout(5);
                }
              })();
              const lockWaiters: number[] = [];
              const activeBackends: number[] = [];
              const sampling = (async () => {
                while (!finished) {
                  const activity = await admin.query<{ waiting: number; active: number }>(
                    "SELECT count(*) FILTER (WHERE wait_event_type = 'Lock')::integer AS waiting, count(*) FILTER (WHERE state = 'active')::integer AS active FROM pg_stat_activity WHERE usename = $1",
                    [role],
                  );
                  lockWaiters.push(activity.rows[0]?.waiting ?? 0);
                  activeBackends.push(activity.rows[0]?.active ?? 0);
                  await setTimeout(5);
                }
              })();
              const outcomes = await Promise.allSettled([writing, polling, sampling]);
              for (const outcome of outcomes) if (outcome.status === "rejected") throw outcome.reason;
              await Promise.all(pollers.map((poller) => poller.poll()));
              const elapsedMs = performance.now() - started;
              expect(latest.every((value) => value === workload.writers * 10)).toBe(true);
              expect(closed).toEqual([]);
              expect(writeMs).toHaveLength(workload.writers * 10);
              expect(peakConnections).toBeLessThanOrEqual(8);
              expect(first.pool.waitingCount + second.pool.waitingCount).toBe(0);
              console.info(
                "kello.capacity",
                JSON.stringify({
                  environment: {
                    runtime: `bun ${Bun.version}`,
                    nodeCompatibilityVersion: process.version,
                    platform: platform(),
                    arch: arch(),
                    cpu: cpus()[0]?.model,
                    postgres: 18,
                  },
                  ...workload,
                  processes: 1,
                  runtimeInstances: 2,
                  poolLimitPerInstance: 4,
                  elapsedMs,
                  writesPerSecond: (writeMs.length * 1000) / elapsedMs,
                  retries,
                  peakConnections,
                  peakWaiting,
                  lockWaiters: distribution(lockWaiters),
                  activeBackends: distribution(activeBackends),
                  writeMs: distribution(writeMs),
                  acquisitionMs: distribution(acquisitionMs),
                  evaluationMs: distribution(evaluationMs),
                  revisionMs: distribution(revisionMs),
                }),
              );
            } finally {
              await Promise.all(pollers.map((poller) => poller.stop()));
              metrics.unsubscribe(capture);
            }
          }
        } finally {
          await second.close();
        }
      } finally {
        await first.close();
      }
    } finally {
      await admin.query("ROLLBACK");
      await admin.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
      await admin.query(`DROP SCHEMA IF EXISTS "${metadata}" CASCADE`);
      await admin.query(`DROP ROLE IF EXISTS "${role}"`);
      await admin.end();
    }
  },
  60_000,
);
