import assert from "node:assert/strict";
import { channel } from "node:diagnostics_channel";
import { expect, test } from "bun:test";
import {
  connectDatabase,
  createRpcJobQueue,
  defineSchema,
  createProjectProcedures,
  encodeRpcJobCall,
  createRpcCronDispatcher,
} from "kello/server";
import { bootstrapDatabase, defineConfig } from "kello-cli";
import { defineRelations, sql } from "drizzle-orm";
import * as v from "valibot";
import pg from "pg";

const connectionString = process.env.LOOM_TEST_DATABASE_URL;
test.skipIf(!connectionString)(
  "durable jobs share transaction rollback, deduplicate and fence recovered leases",
  async () => {
    if (!connectionString) throw new Error("Missing database URL");
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const metadataNamespace = `loom_jobs_${suffix}`;
    const applicationNamespace = `app_jobs_${suffix}`;
    const runtimeRole = `loom_runtime_${suffix}`;
    const admin = new pg.Client({ connectionString });
    await admin.connect();
    try {
      await bootstrapDatabase({ connectionString, metadataNamespace, runtimeRole });
      await admin.query(`CREATE SCHEMA "${applicationNamespace}"`);
      await admin.query(`CREATE TABLE "${applicationNamespace}".effects (value integer PRIMARY KEY)`);
      await admin.query(`GRANT USAGE ON SCHEMA "${applicationNamespace}" TO "${runtimeRole}"`);
      await admin.query(`GRANT SELECT, INSERT ON "${applicationNamespace}".effects TO "${runtimeRole}"`);
      await admin.query(`ALTER ROLE "${runtimeRole}" LOGIN PASSWORD 'loom-test-only'`);
      const address = new URL(connectionString);
      address.username = runtimeRole;
      address.password = "loom-test-only";
      const schema = defineSchema(() => ({}));
      const connection = await connectDatabase({
        schema,
        relations: defineRelations(schema.tables),
        connectionString: address.href,
      });
      const claimMetric = v.strictObject({
        type: v.literal("job.claim"),
        ageMs: v.pipe(v.number(), v.finite(), v.minValue(0)),
        dueLagMs: v.pipe(v.number(), v.finite(), v.minValue(0)),
        attempt: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(10)),
        recovered: v.boolean(),
      });
      const claimsMeasured: v.InferOutput<typeof claimMetric>[] = [];
      const reaped: number[] = [];
      const metricChannel = channel("kello.runtime.metric");
      const captureMetric: Parameters<typeof metricChannel.subscribe>[0] = (event) => {
        const { type } = v.parse(v.object({ type: v.string() }), event);
        if (type === "job.claim") claimsMeasured.push(v.parse(claimMetric, event));
        if (type === "job.lease.reaped") {
          const metric = v.parse(
            v.strictObject({
              type: v.literal("job.lease.reaped"),
              count: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100)),
            }),
            event,
          );
          reaped.push(metric.count);
        }
      };
      metricChannel.subscribe(captureMetric);
      try {
        const version = "a".repeat(64);
        const { procedure } = createProjectProcedures(schema);
        const definition = procedure.input(v.object({ value: v.number() })).handler(() => null);
        const options = {
          db: connection.db,
          metadataNamespace,
          deployment: "preview-one",
          version,
          internal: [{ path: ["jobs", "write"], procedure: definition }],
        };
        const queue = createRpcJobQueue(options);
        const call = encodeRpcJobCall(version, ["jobs", "write"], { value: 1 });
        const identity = { issuer: "test", subject: "alice", tenantId: "one" };
        const schedule = {
          deduplicationKey: "occurrence-one",
          dueAt: new Date(0),
          maxAttempts: 2,
          retryDelaySeconds: 0,
        };
        await assert.rejects(
          connection.db.transaction(async (transaction) => {
            await transaction.execute(sql`INSERT INTO ${sql.identifier(applicationNamespace)}.effects VALUES (1)`);
            await queue.enqueue(transaction, call, identity, schedule);
            throw new Error("rollback fixture");
          }),
          /rollback fixture/,
        );
        expect((await admin.query(`SELECT * FROM "${applicationNamespace}".effects`)).rows).toEqual([]);
        expect(await queue.claim("worker-one", 30)).toBeNull();
        const id = await queue.enqueue(connection.db, call, identity, schedule);
        expect(await queue.enqueue(connection.db, call, identity, schedule)).toBe(id);
        await assert.rejects(
          queue.enqueue(connection.db, encodeRpcJobCall(version, ["jobs", "write"], { value: 2 }), identity, schedule),
          /deduplication conflict/,
        );
        await assert.rejects(
          queue.enqueue(connection.db, encodeRpcJobCall(version, ["jobs", "write"], null), identity, {
            ...schedule,
            deduplicationKey: "invalid",
          }),
        );
        await assert.rejects(queue.enqueue(connection.db, { ...call, version: "b".repeat(64) }, identity, schedule));
        const newerVersion = "b".repeat(64);
        const newerQueue = createRpcJobQueue({ ...options, version: newerVersion });
        assert.equal(await newerQueue.claim("newer-worker", 30), null);
        const newerId = await newerQueue.enqueue(connection.db, { ...call, version: newerVersion }, identity, {
          ...schedule,
          deduplicationKey: "newer-occurrence",
        });
        const newerLease = await newerQueue.claim("newer-worker", 30);
        assert.equal(newerLease?.id, newerId);
        assert.ok(newerLease);
        assert.equal(await newerQueue.complete(newerLease, null), true);
        assert.equal((await queue.inspect(id))?.attempts, 0);
        await admin.query(
          `UPDATE "${metadataNamespace}".jobs SET created_at = clock_timestamp() - interval '10 seconds', due_at = clock_timestamp() - interval '5 seconds' WHERE id = $1`,
          [id],
        );
        const measuredBeforeClaims = claimsMeasured.length;
        const claims = await Promise.all([
          queue.claim("worker-one", 30),
          createRpcJobQueue(options).claim("worker-two", 30),
        ]);
        const lease = claims.find((value) => value !== null);
        assert.ok(lease);
        expect(claims.filter((value) => value !== null)).toHaveLength(1);
        expect(claimsMeasured).toHaveLength(measuredBeforeClaims + 1);
        expect(claimsMeasured.at(-1)).toMatchObject({ attempt: 1, recovered: false });
        expect(claimsMeasured.at(-1)?.ageMs).toBeGreaterThanOrEqual(10_000);
        expect(claimsMeasured.at(-1)?.dueLagMs).toBeGreaterThanOrEqual(5_000);
        expect(lease).toMatchObject({ id, call, identity, attempt: 1 });
        expect(await createRpcJobQueue({ ...options, deployment: "other" }).claim("other", 30)).toBeNull();
        await admin.query(
          `UPDATE "${metadataNamespace}".jobs SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1`,
          [id],
        );
        assert.equal(await newerQueue.claim("newer-worker", 30), null);
        assert.equal((await queue.inspect(id))?.attempts, 1);
        const recovered = await createRpcJobQueue(options).claim("worker-three", 30);
        assert.ok(recovered);
        expect(recovered.attempt).toBe(2);
        expect(claimsMeasured.at(-1)).toMatchObject({ attempt: 2, recovered: true });
        expect(recovered.token).not.toBe(lease.token);
        expect(await queue.complete(lease, null)).toBe(false);
        expect(await queue.renew(lease, 30)).toBe(false);
        expect(await queue.fail(lease, "INTERNAL")).toBe(false);
        expect(await queue.renew(recovered, 30)).toBe(true);
        expect(await queue.complete(recovered, { saved: true })).toBe(true);
        expect(await queue.complete(recovered, null)).toBe(false);
        expect(await queue.inspect(id)).toMatchObject({ state: "succeeded", attempts: 2, result: { saved: true } });
        expect(await queue.claim("worker-four", 30)).toBeNull();
        expect(await queue.enqueue(connection.db, call, identity, schedule)).toBe(id);

        const pending = await queue.enqueue(connection.db, call, identity, {
          ...schedule,
          deduplicationKey: "cancel-pending",
        });
        expect(await queue.cancel(pending)).toBe("cancelled");
        expect(await queue.claim("worker", 30)).toBeNull();
        const running = await queue.enqueue(connection.db, call, identity, {
          ...schedule,
          deduplicationKey: "cancel-running",
        });
        const active = await queue.claim("worker", 30);
        assert.ok(active);
        expect(active.id).toBe(running);
        expect(await queue.cancel(running)).toBe("requested");
        expect(await queue.renew(active, 30)).toBe(false);
        expect(await queue.fail(active, "CANCELLED")).toBe(true);
        expect(await queue.inspect(running)).toMatchObject({ state: "cancelled" });

        const failed = await queue.enqueue(connection.db, call, identity, { ...schedule, deduplicationKey: "fail" });
        const first = await queue.claim("worker", 30);
        assert.ok(first);
        expect(await queue.fail(first, "INTERNAL")).toBe(true);
        const second = await queue.claim("worker", 30);
        assert.ok(second);
        expect(second.id).toBe(failed);
        expect(await queue.fail(second, "INTERNAL")).toBe(true);
        expect(await queue.inspect(failed)).toMatchObject({ state: "failed", attempts: 2, errorCode: "INTERNAL" });
        expect(await queue.claim("worker", 30)).toBeNull();

        const exhausted = await queue.enqueue(connection.db, call, identity, {
          ...schedule,
          deduplicationKey: "crashed",
          maxAttempts: 1,
        });
        const crashed = await queue.claim("worker", 30);
        assert.ok(crashed);
        await admin.query(
          `UPDATE "${metadataNamespace}".jobs SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1`,
          [exhausted],
        );
        assert.equal(await newerQueue.claim("newer-worker", 30), null);
        assert.equal((await queue.inspect(exhausted))?.state, "running");
        const reapedBefore = reaped.length;
        expect(await queue.claim("replacement", 30)).toBeNull();
        expect(reaped).toHaveLength(reapedBefore + 1);
        expect(reaped.at(-1)).toBe(1);
        expect(await queue.inspect(exhausted)).toMatchObject({ state: "failed", errorCode: "LEASE_EXPIRED" });
        const future = await queue.enqueue(connection.db, call, identity, {
          ...schedule,
          deduplicationKey: "future",
          dueAt: new Date(Date.now() + 3600000),
        });
        expect(await queue.claim("worker", 30)).toBeNull();
        expect(await queue.cancel(future)).toBe("cancelled");
        const duplicateIds = await Promise.all([
          queue.enqueue(connection.db, call, identity, { ...schedule, deduplicationKey: "concurrent" }),
          createRpcJobQueue(options).enqueue(connection.db, call, identity, {
            ...schedule,
            deduplicationKey: "concurrent",
          }),
        ]);
        expect(duplicateIds[0]).toBe(duplicateIds[1]);
        const lockedId = duplicateIds[0];
        assert.ok(lockedId);
        await admin.query("BEGIN");
        try {
          await admin.query(`SELECT id FROM "${metadataNamespace}".jobs WHERE id = $1 FOR UPDATE`, [lockedId]);
          expect(await queue.claim("worker", 30)).toBeNull();
        } finally {
          await admin.query("ROLLBACK");
        }
        const short = await queue.claim("worker", 1);
        assert.ok(short);
        await admin.query("BEGIN");
        let acknowledgement: Promise<boolean> | undefined;
        try {
          await admin.query(`SELECT id FROM "${metadataNamespace}".jobs WHERE id = $1 FOR UPDATE`, [short.id]);
          acknowledgement = queue.complete(short, null);
          let waiting = false;
          for (let attempt = 0; attempt < 100; attempt++) {
            await admin.query("SELECT pg_stat_clear_snapshot()");
            const state = await admin.query<{ waiting: boolean }>(
              "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE usename = $1 AND wait_event_type = 'Lock') AS waiting",
              [runtimeRole],
            );
            if (state.rows[0]?.waiting) {
              waiting = true;
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          assert.equal(waiting, true, "Acknowledgement must wait on the job row lock");
          await new Promise((resolve) => setTimeout(resolve, 1100));
        } finally {
          await admin.query("ROLLBACK");
        }
        expect(await acknowledgement).toBe(false);
        const afterWait = await queue.claim("replacement", 30);
        assert.ok(afterWait);
        expect(afterWait.id).toBe(short.id);
        expect(await queue.cancel(afterWait.id)).toBe("requested");
        // A cooperative cancellation cannot undo effects that have already completed.
        expect(await queue.complete(afterWait, null)).toBe(true);
        expect(await queue.cancel(afterWait.id)).toBe("finished");
        expect(await queue.inspect(afterWait.id)).toMatchObject({ state: "succeeded", cancelRequested: true });
        for (const seconds of [0, 301, 1.5]) await assert.rejects(queue.claim("worker", seconds));
        await assert.rejects(queue.claim("", 30));
        await assert.rejects(
          queue.enqueue(connection.db, encodeRpcJobCall(version, ["unregistered"], { value: 1 }), identity, schedule),
        );
        await assert.rejects(queue.enqueue(connection.db, call, identity, { ...schedule, maxAttempts: 11 }));
        await assert.rejects(queue.enqueue(connection.db, call, identity, { ...schedule, dueAt: new Date(NaN) }));
        await assert.rejects(queue.enqueue(connection.db, call, identity, { ...schedule, retryDelaySeconds: 3601 }));
        const failure = await queue.inspect(failed);
        assert.ok(failure);
        const replays = await Promise.all([
          queue.replay(failed, failure.fencingToken, new Date(0)),
          createRpcJobQueue(options).replay(failed, failure.fencingToken, new Date(0)),
        ]);
        expect(replays.filter(Boolean)).toHaveLength(1);
        const replay = await queue.claim("replay-worker", 30);
        assert.ok(replay);
        expect(replay.id).toBe(failed);
        expect(replay.call).toEqual(call);
        expect(replay.attempt).toBe(1);
        expect(replay.token).not.toBe(failure.fencingToken);
        expect(await queue.complete(second, null)).toBe(false);
        expect(await queue.fail(replay, "INTERNAL")).toBe(true);
        const replayLast = await queue.claim("replay-worker", 30);
        assert.ok(replayLast);
        expect(await queue.fail(replayLast, "INTERNAL")).toBe(true);
        expect(await queue.replay(failed, failure.fencingToken, new Date(0))).toBe(false);
        const beforeAuditFailure = await queue.inspect(failed);
        await admin.query(`REVOKE INSERT ON "${metadataNamespace}".job_replays FROM "${runtimeRole}"`);
        try {
          await assert.rejects(queue.replay(failed, replayLast.token, new Date(0)));
          expect(await queue.inspect(failed)).toEqual(beforeAuditFailure);
        } finally {
          await admin.query(`GRANT INSERT ON "${metadataNamespace}".job_replays TO "${runtimeRole}"`);
        }
        const audit = await admin.query(
          `SELECT attempts, error_code FROM "${metadataNamespace}".job_replays WHERE job_id = $1`,
          [failed],
        );
        expect(audit.rows).toEqual([{ attempts: 2, error_code: "INTERNAL" }]);
        const success = await queue.inspect(id);
        assert.ok(success);
        expect(await queue.replay(id, success.fencingToken, new Date(0))).toBe(false);
        expect(
          await createRpcJobQueue({ ...options, deployment: "other" }).replay(failed, replayLast.token, new Date(0)),
        ).toBe(false);
        await assert.rejects(
          connection.pool.query(`DELETE FROM "${metadataNamespace}".job_replays`),
          /permission denied/,
        );
        expect(await queue.inspect(crypto.randomUUID())).toBeNull();
        await assert.rejects(connection.pool.query(`DELETE FROM "${metadataNamespace}".jobs`), /permission denied/);
        const config = defineConfig({ project: "tasks", jobs: { maxAttempts: 2, retryBaseMs: 7000 } });
        const configuredOptions = {
          ...options,
          deployment: "configured",
          maxAttempts: config.jobs.maxAttempts,
          retryDelaySeconds: config.jobs.retryBaseMs / 1000,
          internal: [
            ...options.internal,
            {
              path: ["jobs", "external"],
              procedure: procedure.input(v.object({ value: v.number() })).handler(() => null),
            },
          ],
        };
        const configured = createRpcJobQueue(configuredOptions);
        const external = encodeRpcJobCall(version, ["jobs", "external"], { value: 1 });
        const defaultId = await configured.enqueue(connection.db, external, identity, {
          deduplicationKey: "default",
          dueAt: new Date(0),
        });
        expect(
          (
            await admin.query(
              `SELECT max_attempts, retry_delay_seconds FROM "${metadataNamespace}".jobs WHERE id = $1`,
              [defaultId],
            )
          ).rows,
        ).toEqual([{ max_attempts: 1, retry_delay_seconds: 7 }]);
        const defaultLease = await configured.claim("configured-worker", config.jobs.leaseMs / 1000);
        assert.ok(defaultLease);
        expect(await configured.fail(defaultLease, "INTERNAL")).toBe(true);
        expect(await configured.inspect(defaultId)).toMatchObject({ state: "failed", attempts: 1 });
        expect(await configured.claim("configured-worker", config.jobs.leaseMs / 1000)).toBeNull();
        await assert.rejects(
          configured.enqueue(connection.db, external, identity, { ...schedule, maxAttempts: 3 }),
          /attempt limit/,
        );
        const explicitId = await configured.enqueue(connection.db, external, identity, {
          ...schedule,
          deduplicationKey: "explicit",
        });
        expect(
          (
            await admin.query(
              `SELECT max_attempts, retry_delay_seconds FROM "${metadataNamespace}".jobs WHERE id = $1`,
              [explicitId],
            )
          ).rows,
        ).toEqual([{ max_attempts: 2, retry_delay_seconds: 0 }]);
        await configured.cancel(explicitId);
        const declared = { schedule: "* * * * *", call, maxAttempts: 2 };
        const crons = createRpcCronDispatcher({
          ...configuredOptions,
          queue: configured,
          crons: { refresh: declared },
          assertActive: async () => {},
        });
        const cronId = await crons.dispatch("refresh", new Date(0));
        expect(
          (
            await admin.query(
              `SELECT max_attempts, retry_delay_seconds FROM "${metadataNamespace}".jobs WHERE id = $1`,
              [cronId],
            )
          ).rows,
        ).toEqual([{ max_attempts: 2, retry_delay_seconds: 7 }]);
        expect(() => createRpcJobQueue({ ...configuredOptions, maxAttempts: 11 })).toThrow();
        expect(() => createRpcJobQueue({ ...configuredOptions, retryDelaySeconds: 0.5 })).toThrow();
      } finally {
        metricChannel.unsubscribe(captureMetric);
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
