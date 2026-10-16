import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { bootstrapDatabase } from "../../../apps/kello/src/tooling/migrations/bootstrap";
import { registerRateLimitPolicies } from "../../../apps/kello/src/tooling/migrations/rate-limits";
import { cleanupRateLimits } from "../../../apps/kello/src/tooling/migrations/rate-limits-cleanup";
import { defineRateLimits } from "../../../apps/kello/src/core/server/rate-limits/policy";

const connectionString = process.env.LOOM_TEST_DATABASE_URL;
const pooledConnectionString = process.env.LOOM_TEST_POOLED_DATABASE_URL;
function requireMaintenanceProfiles(): void {
  if (!connectionString) throw new Error("LOOM_TEST_DATABASE_URL is required for native cleanup tests");
  if (!pooledConnectionString)
    throw new Error("LOOM_TEST_POOLED_DATABASE_URL is required for transaction-pooler cleanup tests");
}

// Test harness causes remain private: assertions keep their original identity,
// while teardown/pipe errors never become raw SQL/credential log payloads.
const harnessFailures = new WeakMap<
  Error,
  {
    primary: { error: unknown } | undefined;
    cleanup: unknown[];
  }
>();

async function withMaintenanceTeardown(
  run: () => Promise<void>,
  cleanup: readonly (() => Promise<void>)[],
): Promise<void> {
  let primary: { error: unknown } | undefined;
  try {
    await run();
  } catch (error) {
    primary = { error };
  }
  const failures: unknown[] = [];
  for (const close of cleanup) {
    try {
      await close();
    } catch (error) {
      failures.push(error);
    }
  }
  if (primary || failures.length) {
    const error = primary?.error instanceof Error ? primary.error : new Error("Maintenance harness teardown failed");
    const previous = harnessFailures.get(error);
    harnessFailures.set(error, {
      primary: previous?.primary ?? primary,
      cleanup: [...(previous?.cleanup ?? []), ...failures],
    });
    throw error;
  }
}

type MaintenanceChild = Pick<Bun.Subprocess<"ignore", "pipe", "pipe">, "exited" | "stdout" | "stderr" | "kill">;
async function readMaintenanceChild(
  child: MaintenanceChild,
  maxDurationMs = 40_000,
): Promise<[number, string, string]> {
  let exited = false;
  const exit = child.exited.finally(() => {
    exited = true;
  });
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
  const owned: Promise<number | string>[] = [exit];
  // Observe each promise immediately, including partially completed setup.
  void Promise.allSettled(owned);
  function read(stream: ReadableStream<Uint8Array>): Promise<string> {
    const reader = stream.getReader();
    readers.push(reader);
    const output = (async () => {
      const decoder = new TextDecoder();
      let text = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return text + decoder.decode();
        text += decoder.decode(value, { stream: true });
      }
    })();
    owned.push(output);
    void Promise.allSettled([output]);
    return output;
  }
  let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
  let primary: { error: unknown } | undefined;
  const failures: unknown[] = [];
  try {
    const stdout = read(child.stdout);
    const stderr = read(child.stderr);
    return await Promise.race([
      Promise.all([exit, stdout, stderr]),
      new Promise<never>((_resolve, reject) => {
        timer = globalThis.setTimeout(() => reject(new Error("Maintenance child timeout")), maxDurationMs);
      }),
    ]);
  } catch (error) {
    primary = { error };
    // Harness failure/timeout owns kill-and-join. Normal completion never kills.
    // Synchronous setup failure can precede an already-settled exit reaction.
    await Promise.resolve();
    if (!exited) {
      try {
        child.kill("SIGKILL");
      } catch (error) {
        failures.push(error);
      }
    }
    // Both cancellations start independently; a failed cancellation must not
    // skip its sibling or let fixture teardown overtake owned settlements.
    const cancellations = await Promise.allSettled(readers.map((reader) => reader.cancel(error)));
    for (const cancellation of cancellations)
      if (cancellation.status === "rejected" && cancellation.reason !== primary.error)
        failures.push(cancellation.reason);
    const settlements = await Promise.allSettled(owned);
    for (const settlement of settlements)
      if (settlement.status === "rejected" && settlement.reason !== primary.error) failures.push(settlement.reason);
    const failure = new Error("Maintenance child harness failed");
    harnessFailures.set(failure, { primary, cleanup: failures });
    throw failure;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    for (const reader of readers) reader.releaseLock();
  }
}

async function fixture(
  run: (fixture: {
    admin: pg.Client;
    metadataNamespace: string;
    runtimeRole: string;
    table: string;
    seed: (count: number, ageMs?: number) => Promise<void>;
  }) => Promise<void>,
) {
  requireMaintenanceProfiles();
  const suffix = randomUUID().replaceAll("-", "");
  const metadataNamespace = `loom_u3_cleanup_${suffix}`;
  const runtimeRole = `u3_cleanup_${suffix}`;
  const admin = new pg.Client({ connectionString });
  const table = `"${metadataNamespace}".rate_limit_buckets`;
  await withMaintenanceTeardown(async () => {
    await admin.connect();
    await bootstrapDatabase({ connectionString: connectionString!, metadataNamespace, runtimeRole });
    await registerRateLimitPolicies(admin, {
      metadataNamespace,
      applicationNamespace: "cleanup_app",
      scopes: [
        {
          mountPath: "",
          definitions: defineRateLimits({
            writes: { version: 1, mode: "quota", scope: "user", limit: 100, windowMs: 1000 },
          }),
        },
      ],
    });
    await run({
      admin,
      metadataNamespace,
      runtimeRole,
      table,
      seed: async (count, ageMs = 10_000) => {
        await admin.query(
          `INSERT INTO ${table}
        (application_namespace,mount_path,policy_name,version,key_digest,count,
         window_start_ms,window_end_ms,last_observed_ms,cleanup_after_ms)
        SELECT 'cleanup_app','','writes',1,decode(lpad(to_hex(n),64,'0'),'hex'),7,
          0,1000,1000,floor(extract(epoch FROM clock_timestamp())*1000)::bigint-$2-$1::integer+n
        FROM generate_series(1,$1::integer) n`,
          [count, ageMs],
        );
      },
    });
  }, [
    async () => {
      await admin.query(`DROP SCHEMA IF EXISTS "${metadataNamespace}" CASCADE`);
    },
    async () => {
      await admin.query(`DROP ROLE IF EXISTS "${runtimeRole}"`);
    },
    () => admin.end(),
  ]);
}

describe("native cleanup", () => {
  test("deletes only expired buckets in independently committed bounded batches", async () => {
    await fixture(async ({ admin, metadataNamespace, table, seed }) => {
      await seed(502);
      await admin.query(
        `UPDATE ${table} SET cleanup_after_ms=floor(extract(epoch FROM clock_timestamp())*1000)::bigint+86400000 WHERE key_digest=decode(lpad('1f6',64,'0'),'hex')`,
      );
      await admin.query(`ANALYZE ${table}`);
      const clock = (await admin.query("SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS now"))
        .rows[0].now;
      for (const selection of ["application_namespace,mount_path,policy_name,version,key_digest", "cleanup_after_ms"]) {
        const plan = await admin.query(
          `EXPLAIN (FORMAT JSON) SELECT ${selection} FROM ${table}
        WHERE cleanup_after_ms <= $1::bigint ORDER BY cleanup_after_ms LIMIT 1${selection === "cleanup_after_ms" ? "" : " FOR UPDATE SKIP LOCKED"}`,
          [clock],
        );
        expect(JSON.stringify(plan.rows)).toContain("rate_limit_buckets_cleanup");
        expect(JSON.stringify(plan.rows)).toContain("Index Cond");
      }
      const first = await cleanupRateLimits({ connectionString: connectionString!, metadataNamespace, maxBatches: 1 });
      expect(first).toMatchObject({ removed: 500, batches: 1, hasMore: true, stoppedBy: "batch-budget" });
      expect(first.oldestExpiredAgeMs).toBeGreaterThanOrEqual(10_000);
      expect((await admin.query(`SELECT count(*)::integer AS n FROM ${table}`)).rows[0].n).toBe(2);
      const resumed = await cleanupRateLimits({ connectionString: connectionString!, metadataNamespace });
      expect(resumed).toMatchObject({ removed: 1, hasMore: false, oldestExpiredAgeMs: null, stoppedBy: "empty" });
      expect((await admin.query(`SELECT count FROM ${table}`)).rows).toEqual([{ count: 7 }]);
      expect((await admin.query(`SELECT policy_name FROM "${metadataNamespace}".rate_limit_policies`)).rows).toEqual([
        { policy_name: "writes" },
      ]);
    });
  }, 60_000);

  test("overlapping dedicated cleanup sessions skip locked batches without double deletion", async () => {
    await fixture(async ({ admin, metadataNamespace, table, seed }) => {
      await seed(4);
      const barrier = `cleanup:${metadataNamespace}`;
      await admin.query(`CREATE FUNCTION "${metadataNamespace}".cleanup_barrier() RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN IF OLD.key_digest=decode(lpad('1',64,'0'),'hex') THEN
        PERFORM pg_advisory_xact_lock(hashtextextended('${barrier}',0));
      END IF; RETURN OLD; END $body$`);
      await admin.query(
        `CREATE TRIGGER cleanup_barrier BEFORE DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION "${metadataNamespace}".cleanup_barrier()`,
      );
      await admin.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [barrier]);
      const first = cleanupRateLimits({
        connectionString: connectionString!,
        metadataNamespace,
        batchSize: 2,
        maxBatches: 1,
      });
      const outcome = first.then(
        (result) => ({ result, error: undefined }),
        (error) => ({ result: undefined, error }),
      );
      await withMaintenanceTeardown(async () => {
        const deadline = performance.now() + 15_000;
        for (;;) {
          const waiting = await admin.query(
            `SELECT 1 FROM pg_stat_activity
          WHERE application_name='kello-rate-limits-cleanup' AND wait_event='advisory' AND query LIKE $1`,
            [`%${metadataNamespace}%`],
          );
          if (waiting.rows.length) break;
          if (performance.now() >= deadline) throw new Error("Cleanup did not reach lock barrier");
          await setTimeout(25);
        }
        const second = await cleanupRateLimits({
          connectionString: connectionString!,
          metadataNamespace,
          batchSize: 2,
          maxBatches: 1,
        });
        expect(second).toMatchObject({ removed: 2, batches: 1, hasMore: true, stoppedBy: "batch-budget" });
        expect(second.oldestExpiredAgeMs).toBeGreaterThanOrEqual(10_000);
        expect((await admin.query(`SELECT count(*)::integer AS n FROM ${table}`)).rows[0].n).toBe(2);
      }, [
        async () => {
          await admin.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [barrier]);
        },
        // Join even if unlocking or a barrier assertion failed.
        async () => {
          await outcome;
        },
      ]);
      expect((await outcome).error).toBeUndefined();
      expect((await outcome).result).toMatchObject({
        removed: 2,
        batches: 1,
        hasMore: false,
        oldestExpiredAgeMs: null,
      });
      expect((await admin.query(`SELECT count(*)::integer AS n FROM ${table}`)).rows[0].n).toBe(0);
    });
  }, 60_000);

  test("locked expired backlog remains visible and a manual renewal racing selection survives", async () => {
    await fixture(async ({ admin, metadataNamespace, table, seed }) => {
      await seed(2, 3_700_000);
      const locker = new pg.Client({ connectionString });
      await withMaintenanceTeardown(async () => {
        await locker.connect();
        await locker.query("BEGIN");
        await locker.query(`SELECT * FROM ${table} ORDER BY key_digest FOR UPDATE`);
        await locker.query(
          `UPDATE ${table} SET cleanup_after_ms=floor(extract(epoch FROM clock_timestamp())*1000)::bigint+86400000 WHERE key_digest=decode(lpad('1',64,'0'),'hex')`,
        );
        const locked = await cleanupRateLimits({
          connectionString: connectionString!,
          metadataNamespace,
          maxBatches: 2,
        });
        expect(locked).toMatchObject({ removed: 0, batches: 2, hasMore: true, stoppedBy: "batch-budget" });
        expect(locked.oldestExpiredAgeMs).toBeGreaterThan(3_600_000);
        await locker.query("COMMIT");
        const renewed = await cleanupRateLimits({ connectionString: connectionString!, metadataNamespace });
        expect(renewed.removed).toBe(1);
        expect((await admin.query(`SELECT count,cleanup_after_ms FROM ${table}`)).rows).toHaveLength(1);
        expect((await admin.query(`SELECT count FROM ${table}`)).rows[0].count).toBe(7);
      }, [
        async () => {
          await locker.query("ROLLBACK");
        },
        () => locker.end(),
      ]);
    });
  }, 60_000);

  test("rejects ownership and missing, stale, divergent or unsupported history before deleting", async () => {
    await fixture(async ({ admin, metadataNamespace, runtimeRole, table, seed }) => {
      await seed(1);
      const run = () => cleanupRateLimits({ connectionString: connectionString!, metadataNamespace });
      const ledger = `"${metadataNamespace}".framework_migrations`;
      await admin.query(`ALTER SCHEMA "${metadataNamespace}" OWNER TO "${runtimeRole}"`);
      try {
        await expect(run()).rejects.toThrow("Rate limit cleanup failed");
      } finally {
        await admin.query(`ALTER SCHEMA "${metadataNamespace}" OWNER TO CURRENT_USER`);
      }
      const current = (
        await admin.query<{ version: number; hash: string }>(`SELECT version,hash FROM ${ledger} ORDER BY version`)
      ).rows;
      const last = current.at(-1)!;
      for (const mutation of [
        `UPDATE ${ledger} SET hash=repeat('0',64) WHERE version=1`,
        `DELETE FROM ${ledger} WHERE version=1`,
        `DELETE FROM ${ledger} WHERE version=${last.version}`,
        `INSERT INTO ${ledger}(version,hash) VALUES(${last.version + 1},repeat('a',64))`,
        `DELETE FROM ${ledger}`,
      ]) {
        await admin.query("BEGIN");
        await admin.query(mutation);
        await admin.query("COMMIT");
        await expect(run()).rejects.toThrow("Rate limit cleanup failed");
        expect((await admin.query(`SELECT count FROM ${table}`)).rows).toHaveLength(1);
        await admin.query(`DELETE FROM ${ledger}`);
        await admin.query(
          `INSERT INTO ${ledger}(version,hash) SELECT version,hash FROM jsonb_to_recordset($1::jsonb) AS r(version integer,hash text)`,
          [JSON.stringify(current)],
        );
      }
      await admin.query(`ALTER TABLE "${metadataNamespace}".migration_history RENAME TO cleanup_hidden_history`);
      await expect(run()).rejects.toThrow("Rate limit cleanup failed");
      await admin.query(`ALTER TABLE "${metadataNamespace}".cleanup_hidden_history RENAME TO migration_history`);
      await admin.query(`ALTER TABLE ${ledger} RENAME TO cleanup_hidden_framework`);
      await expect(run()).rejects.toThrow("Rate limit cleanup failed");
      expect((await admin.query(`SELECT count FROM ${table}`)).rows).toHaveLength(1);
      await admin.query(`ALTER TABLE "${metadataNamespace}".cleanup_hidden_framework RENAME TO framework_migrations`);
      expect((await run()).removed).toBe(1);
    });
  }, 60_000);

  test("validates every budget before connecting and handles pre-aborted signals", async () => {
    requireMaintenanceProfiles();
    for (const invalid of [
      { batchSize: 501 },
      { batchSize: 0 },
      { batchSize: 1.5 },
      { maxBatches: 21 },
      { maxDurationMs: 30_001 },
      { maxDurationMs: NaN },
    ])
      await expect(
        cleanupRateLimits({
          connectionString: connectionString!,
          metadataNamespace: "loom_u3_cleanup_invalid",
          ...invalid,
        }),
      ).rejects.toThrow("Invalid rate limit cleanup input");
    const controller = new AbortController();
    controller.abort(new Error("secret cancellation cause"));
    await expect(
      cleanupRateLimits({
        connectionString: connectionString!,
        metadataNamespace: "loom_u3_cleanup_invalid",
        signal: controller.signal,
      }),
    ).rejects.toThrow("Rate limit cleanup failed");
  });

  test.each([
    ["direct", connectionString, false],
    ["transaction-pooler", pooledConnectionString, false],
    ["direct controlled barrier failure", connectionString, true],
  ])(
    "%s cancels in-flight SQL, preserves prior commits, and resumes remaining rows",
    async (_profile, targetUrl, failBarrier) => {
      await fixture(async ({ admin, metadataNamespace, table, seed }) => {
        await seed(3);
        await admin.query(`CREATE FUNCTION "${metadataNamespace}".cleanup_pause() RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN IF OLD.key_digest=decode(lpad('2',64,'0'),'hex') THEN
        PERFORM set_config('client_connection_check_interval','0',true);
        PERFORM pg_sleep(20); END IF; RETURN OLD; END $body$`);
        await admin.query(
          `CREATE TRIGGER cleanup_pause BEFORE DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION "${metadataNamespace}".cleanup_pause()`,
        );
        const controller = new AbortController();
        const pending = cleanupRateLimits({
          connectionString: targetUrl!,
          metadataNamespace,
          batchSize: 1,
          signal: controller.signal,
        });
        // Attach immediately; database observations, not a JS timing guess, form the barrier.
        const outcome = pending.then(
          (result) => ({ result, error: undefined }),
          (error) => ({ result: undefined, error }),
        );
        let backendPid: number | undefined;
        let cancelledAt = 0;
        const barrierFailure = new Error("Controlled native barrier failure");
        const observed = await withMaintenanceTeardown(async () => {
          const deadline = performance.now() + 15_000;
          for (;;) {
            const waiting = await admin.query<{ pid: number }>(
              `SELECT pid FROM pg_stat_activity
          WHERE application_name='kello-rate-limits-cleanup' AND wait_event='PgSleep' AND query LIKE $1`,
              [`%${metadataNamespace}%`],
            );
            if (waiting.rows.length) {
              backendPid = waiting.rows[0]!.pid;
              break;
            }
            if (performance.now() >= deadline) throw new Error("Cleanup did not reach SQL barrier");
            await setTimeout(25);
          }
          if (failBarrier) throw barrierFailure;
          expect((await admin.query(`SELECT count(*)::integer AS n FROM ${table}`)).rows[0].n).toBe(2);
        }, [
          async () => {
            cancelledAt = performance.now();
            controller.abort();
            await outcome;
          },
        ]).then(
          () => undefined,
          (error) => error,
        );
        if (failBarrier) expect(observed).toBe(barrierFailure);
        else if (observed !== undefined) throw observed;
        expect((await outcome).error).toMatchObject({ message: "Rate limit cleanup failed", removed: 1, batches: 1 });
        // With disconnect checks disabled and 20s sleep/30s statement timeout,
        // prompt backend quiescence proves cancellation, not merely socket teardown.
        const releasedBy = cancelledAt + 5000;
        for (;;) {
          const activity = await admin.query(
            `SELECT 1 FROM pg_stat_activity
        WHERE pid=$1 AND (state='active' OR xact_start IS NOT NULL)`,
            [backendPid],
          );
          if (!activity.rows.length) break;
          if (performance.now() >= releasedBy) throw new Error("Cancelled cleanup retained its native transaction");
          await setTimeout(25);
        }
        expect(performance.now() - cancelledAt).toBeLessThan(5000);
        expect(
          (
            await admin.query(
              `SELECT 1 FROM pg_locks
      WHERE pid=$1 AND relation=$2::regclass AND granted`,
              [backendPid, table],
            )
          ).rows,
        ).toEqual([]);
        await admin.query(`DROP TRIGGER cleanup_pause ON ${table}`);
        expect((await cleanupRateLimits({ connectionString: connectionString!, metadataNamespace })).removed).toBe(2);
      });
    },
    60_000,
  );

  test("SQL failure after a confirmed batch retains counters and only the pending batch rolls back", async () => {
    await fixture(async ({ admin, metadataNamespace, table, seed }) => {
      await seed(3);
      await admin.query(`CREATE FUNCTION "${metadataNamespace}".cleanup_fail() RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN IF OLD.key_digest=decode(lpad('2',64,'0'),'hex') THEN
        RAISE EXCEPTION 'PRIVATE_SQL_CAUSE_SECRET'; END IF; RETURN OLD; END $body$`);
      await admin.query(
        `CREATE TRIGGER cleanup_fail BEFORE DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION "${metadataNamespace}".cleanup_fail()`,
      );
      const failure = await cleanupRateLimits({
        connectionString: connectionString!,
        metadataNamespace,
        batchSize: 1,
      }).then(
        () => undefined,
        (error) => error,
      );
      expect(failure).toMatchObject({ message: "Rate limit cleanup failed", removed: 1, batches: 1 });
      expect(failure.cause).toBeUndefined();
      expect(JSON.stringify(failure)).toBe('{"removed":1,"batches":1}');
      expect((await admin.query(`SELECT count(*)::integer AS n FROM ${table}`)).rows[0].n).toBe(2);
      await admin.query(`DROP TRIGGER cleanup_fail ON ${table}`);
      expect((await cleanupRateLimits({ connectionString: connectionString!, metadataNamespace })).removed).toBe(2);
    });
  }, 60_000);

  test("timeout bounds SQL and releases the transaction without deleting its rows", async () => {
    await fixture(async ({ admin, metadataNamespace, table, seed }) => {
      await seed(1);
      await admin.query(`CREATE FUNCTION "${metadataNamespace}".cleanup_pause() RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN PERFORM pg_sleep(20); RETURN OLD; END $body$`);
      await admin.query(
        `CREATE TRIGGER cleanup_pause BEFORE DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION "${metadataNamespace}".cleanup_pause()`,
      );
      const started = performance.now();
      await expect(
        cleanupRateLimits({ connectionString: connectionString!, metadataNamespace, maxDurationMs: 2000 }),
      ).rejects.toThrow("Rate limit cleanup failed");
      // The 2s budget includes connection, SQL, cancellation and owned close.
      expect(performance.now() - started).toBeLessThan(2000);
      await admin.query("SET lock_timeout='2s'");
      await admin.query(`DROP TRIGGER cleanup_pause ON ${table}`);
      expect((await admin.query(`SELECT count FROM ${table}`)).rows).toHaveLength(1);
      expect((await cleanupRateLimits({ connectionString: connectionString!, metadataNamespace })).removed).toBe(1);
    });
  }, 60_000);
});

describe("built maintenance script (host build required)", () => {
  test.each(["sql", "timeout"] as const)(
    "%s after a confirmed batch exits 1 with safe committed counters",
    async (failure) => {
      await fixture(async ({ admin, metadataNamespace, table, seed }) => {
        await seed(3);
        await admin.query(`CREATE FUNCTION "${metadataNamespace}".cleanup_fail() RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN IF OLD.key_digest=decode(lpad('2',64,'0'),'hex') THEN
        ${failure === "sql" ? "RAISE EXCEPTION 'PRIVATE_SQL_CAUSE_SECRET';" : "PERFORM pg_sleep(20);"}
      END IF; RETURN OLD; END $body$`);
        await admin.query(
          `CREATE TRIGGER cleanup_fail BEFORE DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION "${metadataNamespace}".cleanup_fail()`,
        );
        const script = fileURLToPath(new URL("../../../scripts/rate-limits-maintenance.ts", import.meta.url));
        const child = Bun.spawn(
          [
            "bun",
            script,
            "--metadata-namespace",
            metadataNamespace,
            "--batch-size",
            "1",
            "--max-duration-ms",
            failure === "timeout" ? "2000" : "30000",
          ],
          { env: { ...process.env, LOOM_MIGRATION_DATABASE_URL: connectionString! }, stdout: "pipe", stderr: "pipe" },
        );
        const [code, stdout, stderr] = await readMaintenanceChild(child);
        expect(code).toBe(1);
        expect(stderr).toBe("");
        expect(stdout).toBe('{"status":"RATE_LIMIT_CLEANUP_FAILED","removed":1,"batches":1}\n');
        expect((await admin.query(`SELECT count(*)::integer AS n FROM ${table}`)).rows[0].n).toBe(2);
        await admin.query(`DROP TRIGGER cleanup_fail ON ${table}`);
        expect((await cleanupRateLimits({ connectionString: connectionString!, metadataNamespace })).removed).toBe(2);
      });
    },
    60_000,
  );

  test("actual public built export reports young, old locked, and empty backlog with redacted failures", async () => {
    await fixture(async ({ admin, metadataNamespace, table, seed }) => {
      const script = fileURLToPath(new URL("../../../scripts/rate-limits-maintenance.ts", import.meta.url));
      async function invoke(credential: string | undefined, extra: string[] = []) {
        const env = { ...process.env };
        delete env.LOOM_MIGRATION_DATABASE_URL;
        if (credential !== undefined) env.LOOM_MIGRATION_DATABASE_URL = credential;
        const child = Bun.spawn(
          ["bun", script, "--metadata-namespace", metadataNamespace, "--max-batches", "1", ...extra],
          { env, stdout: "pipe", stderr: "pipe" },
        );
        const [code, stdout, stderr] = await readMaintenanceChild(child);
        expect(stderr).toBe("");
        expect(stdout.trim().split("\n")).toHaveLength(1);
        const output = JSON.parse(stdout);
        expect(Object.keys(output).sort()).toEqual(
          code === 1
            ? output.removed === undefined
              ? ["status"]
              : ["batches", "removed", "status"]
            : ["batches", "hasMore", "oldestExpiredAgeMs", "removed", "status", "stoppedBy"],
        );
        return { code, output };
      }
      const locker = new pg.Client({ connectionString });
      await withMaintenanceTeardown(async () => {
        await locker.connect();
        await seed(1);
        await locker.query("BEGIN");
        await locker.query(`SELECT * FROM ${table} FOR UPDATE`);
        expect(await invoke(connectionString)).toMatchObject({
          code: 0,
          output: { status: "RATE_LIMIT_CLEANUP_OK", removed: 0, hasMore: true, stoppedBy: "batch-budget" },
        });
        await locker.query(
          `UPDATE ${table} SET cleanup_after_ms=floor(extract(epoch FROM clock_timestamp())*1000)::bigint-3700000`,
        );
        await locker.query("COMMIT");
        await locker.query("BEGIN");
        await locker.query(`SELECT * FROM ${table} FOR UPDATE`);
        expect(await invoke(connectionString)).toMatchObject({
          code: 2,
          output: { status: "RATE_LIMIT_CLEANUP_BACKLOG", removed: 0, hasMore: true },
        });
        await locker.query("COMMIT");
        expect(await invoke(connectionString)).toMatchObject({
          code: 0,
          output: { removed: 1, oldestExpiredAgeMs: null, hasMore: false, stoppedBy: "empty" },
        });
        await seed(1);
        await admin.query(`CREATE FUNCTION "${metadataNamespace}".cleanup_fail() RETURNS trigger LANGUAGE plpgsql AS $body$
        BEGIN RAISE EXCEPTION 'PRIVATE_SQL_CAUSE_SECRET'; END $body$`);
        await admin.query(
          `CREATE TRIGGER cleanup_fail BEFORE DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION "${metadataNamespace}".cleanup_fail()`,
        );
        expect(await invoke(connectionString)).toEqual({
          code: 1,
          output: { status: "RATE_LIMIT_CLEANUP_FAILED", removed: 0, batches: 0 },
        });
        expect((await admin.query(`SELECT count FROM ${table}`)).rows).toHaveLength(1);
        expect(await invoke(undefined)).toEqual({ code: 1, output: { status: "RATE_LIMIT_CLEANUP_FAILED" } });
        expect(await invoke("postgresql://LEAK_THIS:SECRET@127.0.0.1:1/missing", ["--max-duration-ms", "100"])).toEqual(
          { code: 1, output: { status: "RATE_LIMIT_CLEANUP_FAILED", removed: 0, batches: 0 } },
        );
      }, [
        async () => {
          await locker.query("ROLLBACK");
        },
        () => locker.end(),
      ]);
    });
  }, 60_000);
});

describe("offline maintenance harness", () => {
  function controlledPipe(cancelFailure?: Error) {
    let controller: ReadableStreamDefaultController<Uint8Array<ArrayBuffer>>;
    let cancelled = false;
    let cancelJoined = false;
    let released = false;
    const cancellation = Promise.withResolvers<void>();
    const stream = new ReadableStream<Uint8Array<ArrayBuffer>>({
      start(value) {
        controller = value;
      },
      async cancel() {
        cancelled = true;
        await cancellation.promise;
        cancelJoined = true;
        if (cancelFailure) throw cancelFailure;
      },
    });
    return {
      stream,
      isCancelled: () => cancelled,
      isCancelJoined: () => cancelJoined,
      release() {
        if (released) return;
        released = true;
        cancellation.resolve();
        if (!cancelled) controller.close();
      },
    };
  }

  test("already-exited child cancels an open pipe and joins before fixture cleanup", async () => {
    const pipe = controlledPipe();
    const sibling = controlledPipe();
    let fixtureCleaned = false;
    let kills = 0;
    let settled = false;
    const outcome = withMaintenanceTeardown(async () => {
      await readMaintenanceChild(
        {
          stdout: pipe.stream,
          stderr: sibling.stream,
          exited: Promise.resolve(0),
          kill: () => {
            kills++;
          },
        },
        10,
      );
    }, [
      async () => {
        fixtureCleaned = true;
      },
    ]).catch((error) => {
      settled = true;
      return error;
    });
    try {
      await setTimeout(40);
      expect(pipe.isCancelled()).toBe(true);
      expect(sibling.isCancelled()).toBe(true);
      expect(settled).toBe(false);
      expect(fixtureCleaned).toBe(false);
      pipe.release();
      await setTimeout(20);
      expect(settled).toBe(false);
      sibling.release();
      const completed = await Promise.race([outcome.then(() => true), setTimeout(100, false)]);
      expect(completed).toBe(true);
      const error = await outcome;
      expect(error.message).toBe("Maintenance child harness failed");
      expect(harnessFailures.get(error)?.primary?.error).toMatchObject({ message: "Maintenance child timeout" });
      expect(pipe.isCancelJoined()).toBe(true);
      expect(sibling.isCancelJoined()).toBe(true);
      expect(pipe.stream.locked).toBe(false);
      expect(sibling.stream.locked).toBe(false);
      expect(fixtureCleaned).toBe(true);
      expect(kills).toBe(0);
    } finally {
      pipe.release();
      sibling.release();
      await outcome;
    }
  });

  test("rejected pipe cancels its open sibling and preserves the read cause through cleanup", async () => {
    const cancelFailure = new Error("Controlled reader cleanup failure");
    const sibling = controlledPipe(cancelFailure);
    const readFailure = new Error("Controlled initiating read failure");
    const failedPipe = new ReadableStream<Uint8Array<ArrayBuffer>>({
      start: (controller) => controller.error(readFailure),
    });
    let fixtureCleaned = false;
    let settled = false;
    const outcome = withMaintenanceTeardown(async () => {
      await readMaintenanceChild(
        {
          stdout: failedPipe,
          stderr: sibling.stream,
          exited: Promise.resolve(0),
          kill: () => {
            throw new Error("Unexpected exited-child kill");
          },
        },
        1000,
      );
    }, [
      async () => {
        fixtureCleaned = true;
      },
    ]).catch((error) => {
      settled = true;
      return error;
    });
    try {
      await setTimeout(20);
      expect(sibling.isCancelled()).toBe(true);
      expect(settled).toBe(false);
      sibling.release();
      expect(await Promise.race([outcome.then(() => true), setTimeout(100, false)])).toBe(true);
      const error = await outcome;
      expect(error.message).toBe("Maintenance child harness failed");
      expect(harnessFailures.get(error)?.primary?.error).toBe(readFailure);
      expect(harnessFailures.get(error)?.cleanup).toContain(cancelFailure);
      expect(sibling.isCancelJoined()).toBe(true);
      expect(failedPipe.locked).toBe(false);
      expect(sibling.stream.locked).toBe(false);
      expect(fixtureCleaned).toBe(true);
    } finally {
      sibling.release();
      await outcome;
    }
  });

  test("throwing kill remains secondary while readers and the later exit are joined", async () => {
    const pipe = controlledPipe();
    const exit = Promise.withResolvers<number>();
    const killAttempted = Promise.withResolvers<void>();
    const killFailure = new Error("Controlled kill failure");
    let exitJoined = false;
    let settled = false;
    const outcome = readMaintenanceChild(
      {
        stdout: pipe.stream,
        stderr: new ReadableStream({ start: (controller) => controller.close() }),
        exited: exit.promise.then((code) => {
          exitJoined = true;
          return code;
        }),
        kill: () => {
          killAttempted.resolve();
          throw killFailure;
        },
      },
      10,
    ).catch((error) => {
      settled = true;
      return error;
    });
    try {
      await killAttempted.promise;
      await setTimeout(20);
      expect(pipe.isCancelled()).toBe(true);
      pipe.release();
      await setTimeout(20);
      expect(settled).toBe(false);
      exit.resolve(1);
      expect(await Promise.race([outcome.then(() => true), setTimeout(100, false)])).toBe(true);
      const error = await outcome;
      expect(error.message).toBe("Maintenance child harness failed");
      expect(harnessFailures.get(error)?.primary?.error).toMatchObject({ message: "Maintenance child timeout" });
      expect(harnessFailures.get(error)?.cleanup).toContain(killFailure);
      expect(exitJoined).toBe(true);
      expect(pipe.isCancelJoined()).toBe(true);
      expect(pipe.stream.locked).toBe(false);
    } finally {
      pipe.release();
      exit.resolve(1);
      await outcome;
    }
  });

  test("synchronous second-reader setup failure joins the first owned reader", async () => {
    const pipe = controlledPipe();
    const setupFailure = new Error("Controlled second-reader setup failure");
    let firstOwned = false;
    let settled = false;
    let kills = 0;
    const outcome = readMaintenanceChild(
      {
        stdout: pipe.stream,
        get stderr(): ReadableStream<Uint8Array<ArrayBuffer>> {
          firstOwned = pipe.stream.locked;
          throw setupFailure;
        },
        exited: Promise.resolve(0),
        kill: () => {
          kills++;
          throw new Error("Unexpected exited-child kill");
        },
      },
      1000,
    ).catch((error) => {
      settled = true;
      return error;
    });
    try {
      await setTimeout(20);
      expect(firstOwned).toBe(true);
      expect(pipe.isCancelled()).toBe(true);
      expect(settled).toBe(false);
      pipe.release();
      const error = await outcome;
      expect(error.message).toBe("Maintenance child harness failed");
      expect(harnessFailures.get(error)?.primary?.error).toBe(setupFailure);
      expect(pipe.isCancelJoined()).toBe(true);
      expect(pipe.stream.locked).toBe(false);
      expect(kills).toBe(0);
    } finally {
      pipe.release();
      await outcome;
    }
  });

  test("barrier failure aborts and joins before fixture teardown; secondary teardown failures do not mask it", async () => {
    const events: string[] = [];
    const assertion = new Error("Controlled barrier failure");
    const secondary = new Error("Controlled schema teardown failure");
    const controller = new AbortController();
    const owned = Promise.withResolvers<void>();
    const outcome = owned.promise.then(() => {
      events.push("joined");
    });
    controller.signal.addEventListener("abort", () => {
      events.push("abort");
      queueMicrotask(owned.resolve);
    });
    const error = await withMaintenanceTeardown(
      () =>
        withMaintenanceTeardown(async () => {
          throw assertion;
        }, [
          async () => {
            controller.abort();
            await outcome;
          },
        ]),
      [
        async () => {
          events.push("schema");
          throw secondary;
        },
        async () => {
          events.push("role");
          throw new Error("Controlled role teardown failure");
        },
        async () => {
          events.push("client");
        },
      ],
    ).catch((error) => error);
    expect(error).toBe(assertion);
    expect(events).toEqual(["abort", "joined", "schema", "role", "client"]);
    expect(harnessFailures.get(error)?.cleanup).toHaveLength(2);
    expect(harnessFailures.get(error)?.cleanup[0]).toBe(secondary);
  });

  test("script timeout kills and joins the owned process and both pipes", async () => {
    const child = Bun.spawn(["bun", "-e", "setInterval(() => {}, 1000)"], { stdout: "pipe", stderr: "pipe" });
    let joined = false;
    const exited = child.exited.then((code) => {
      joined = true;
      return code;
    });
    let kills = 0;
    const error = await readMaintenanceChild(
      {
        stdout: child.stdout,
        stderr: child.stderr,
        exited,
        kill: () => {
          kills++;
          child.kill("SIGKILL");
        },
      },
      50,
    ).catch((error) => error);
    expect(error.message).toBe("Maintenance child harness failed");
    expect(joined).toBe(true);
    expect(kills).toBe(1);
    expect(child.stdout.locked).toBe(false);
    expect(child.stderr.locked).toBe(false);
  });

  test("pipe failure kills and joins; normal completion never kills", async () => {
    const exited = Promise.withResolvers<number>();
    let kills = 0;
    let joined = false;
    const pipeFailure = new Error("Controlled pipe failure");
    const failed = await readMaintenanceChild(
      {
        stdout: new ReadableStream({
          start(controller) {
            controller.error(pipeFailure);
          },
        }),
        stderr: new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
        exited: exited.promise.then((code) => {
          joined = true;
          return code;
        }),
        kill: () => {
          kills++;
          exited.resolve(1);
        },
      },
      1000,
    ).catch((error) => error);
    expect(failed.message).toBe("Maintenance child harness failed");
    expect(harnessFailures.get(failed)?.primary?.error).toBe(pipeFailure);
    expect(joined).toBe(true);
    expect(kills).toBe(1);
    const complete = await readMaintenanceChild({
      stdout: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("safe"));
          controller.close();
        },
      }),
      stderr: new ReadableStream({
        start(controller) {
          controller.close();
        },
      }),
      exited: Promise.resolve(0),
      kill: () => {
        throw new Error("Unexpected normal-path kill");
      },
    });
    expect(complete).toEqual([0, "safe", ""]);
    const nonzero = await readMaintenanceChild({
      stdout: new ReadableStream({
        start(controller) {
          const bytes = new TextEncoder().encode("safe €");
          controller.enqueue(bytes.slice(0, -1));
          controller.enqueue(bytes.slice(-1));
          controller.close();
        },
      }),
      stderr: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("safe diagnostic"));
          controller.close();
        },
      }),
      exited: Promise.resolve(2),
      kill: () => {
        throw new Error("Unexpected nonzero-exit kill");
      },
    });
    expect(nonzero).toEqual([2, "safe €", "safe diagnostic"]);
  });
});
