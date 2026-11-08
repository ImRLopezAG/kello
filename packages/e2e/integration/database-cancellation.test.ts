import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";
import { test, expect } from "bun:test";
import pg from "pg";
import { sql } from "drizzle-orm";
import { connectDatabase, defineSchema, runFunctionTransaction } from "kello/server";

const ownerUrl = process.env.KELLO_TEST_DATABASE_URL;
const pooledUrl = process.env.KELLO_TEST_POOLED_DATABASE_URL;

async function waitFor(predicate: () => Promise<boolean>, message: string) {
  const expires = performance.now() + 3000;
  while (!(await predicate())) {
    if (performance.now() > expires) throw new Error(message);
    await setTimeout(25);
  }
}

async function bounded<Result>(pending: Promise<Result>, message: string): Promise<Result> {
  const timer = new AbortController();
  try {
    return await Promise.race([
      pending,
      setTimeout(1500, undefined, { signal: timer.signal }).then(() => {
        throw new Error(message);
      }),
    ]);
  } finally {
    timer.abort();
  }
}

for (const [transport, runtimeUrl] of [
  ["direct", ownerUrl],
  ["pooler", pooledUrl],
] as const) {
  test.skipIf(!ownerUrl || !runtimeUrl)(
    `abort stops PostgreSQL statements and releases retained locks through ${transport}`,
    async () => {
      if (!ownerUrl || !runtimeUrl) throw new Error("Missing database URL");
      const role = `kello_cancel_${crypto.randomUUID().replaceAll("-", "")}`;
      const password = crypto.randomUUID();
      const owner = new pg.Client({ connectionString: ownerUrl });
      const schema = defineSchema(() => ({}));
      let connection: Awaited<ReturnType<typeof connectDatabase>> | undefined;
      const ownedPids = new Set<number>();
      const activity = async (pid: number) =>
        (
          await owner.query<{
            state: string;
            active: boolean;
            transaction_open: boolean;
            wait_event: string;
            wait_event_type: string;
          }>(
            "SELECT state, state = 'active' AS active, xact_start IS NOT NULL AS transaction_open, wait_event, wait_event_type FROM pg_stat_activity WHERE pid = $1 AND usename = $2",
            [pid, role],
          )
        ).rows[0];
      try {
        await owner.connect();
        await owner.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}'`);
        await owner.query(`GRANT "${role}" TO CURRENT_USER`);
        const restricted = await owner.query(
          "SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = $1",
          [role],
        );
        expect(restricted.rows[0]).toEqual({
          rolsuper: false,
          rolcreatedb: false,
          rolcreaterole: false,
          rolreplication: false,
          rolbypassrls: false,
        });
        const address = new URL(runtimeUrl);
        address.username = role;
        address.password = password;
        connection = await connectDatabase({
          connectionString: address.href,
          schema,
          relations: {},
          maxConnections: 1,
        });
        for (const variant of ["sleep-zero", "lock-zero", "sleep-default", "lock-default"] as const) {
          const lock = variant.startsWith("lock");
          const blocker = new pg.Client({ connectionString: ownerUrl });
          const key = Number.parseInt(crypto.randomUUID().slice(0, 8), 16);
          const controller = new AbortController();
          const reason = new Error(`Cancelled ${variant}`);
          const entered = Promise.withResolvers<number>();
          const callbackSettled = Promise.withResolvers<void>();
          let published = false;
          let pid: number | undefined;
          let pending: Promise<unknown> | undefined;
          try {
            await blocker.connect();
            await blocker.query("BEGIN");
            if (lock) await blocker.query("SELECT pg_advisory_xact_lock($1::bigint)", [key]);
            pending = runFunctionTransaction(
              connection,
              lock ? "mutation" : "query",
              async (tx) => {
                try {
                  if (variant.endsWith("zero")) await tx.execute(sql`SET LOCAL client_connection_check_interval = 0`);
                  const rows = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
                  const backend = rows.rows[0]?.pid;
                  if (backend === undefined) throw new Error("Missing transaction backend");
                  ownedPids.add(backend);
                  if (lock) await tx.execute(sql`SELECT pg_advisory_xact_lock(${key + 1}::bigint)`);
                  entered.resolve(backend);
                  if (lock) await tx.execute(sql`SELECT pg_advisory_xact_lock(${key}::bigint)`);
                  else await tx.execute(sql`SELECT pg_sleep(20)`);
                  published = true;
                } finally {
                  callbackSettled.resolve();
                }
              },
              { signal: controller.signal },
            );
            // Own rejection before waiting for the observer's server barrier.
            const outcome = pending.then(
              () => ({ resolved: true, error: undefined }),
              (error: Error) => ({ resolved: false, error }),
            );
            const serverPid = await bounded(entered.promise, "Transaction did not enter");
            pid = serverPid;
            await waitFor(async () => {
              const row = await activity(serverPid);
              return !!row?.active && (lock ? row.wait_event_type === "Lock" : row.wait_event === "PgSleep");
            }, "Native statement did not block");
            if (lock) {
              const held = await owner.query(
                "SELECT count(*)::int AS count FROM pg_locks WHERE pid = $1 AND locktype = 'advisory' AND granted",
                [pid],
              );
              expect(held.rows[0]?.count).toBe(1);
            }
            controller.abort(reason);
            const result = await bounded(outcome, "Caller did not reject promptly");
            expect(result.resolved).toBe(false);
            expect(result.error).toBe(reason);
            await waitFor(async () => {
              const row = await activity(serverPid);
              return !row || (!row.active && !row.transaction_open && !row.state.startsWith("idle in transaction"));
            }, "Aborted transaction remained open");
            if (lock) {
              // Assert before observer cleanup or releasing the blocking lock.
              const held = await owner.query(
                "SELECT count(*)::int AS count FROM pg_locks WHERE pid = $1 AND locktype = 'advisory' AND granted",
                [pid],
              );
              expect(held.rows[0]?.count).toBe(0);
            }
            await bounded(callbackSettled.promise, "Native query did not settle");
            expect(published).toBe(false);
          } finally {
            if (pid && (await activity(pid))?.transaction_open) {
              await owner.query("SELECT pg_cancel_backend($1) FROM pg_stat_activity WHERE pid = $1 AND usename = $2", [
                pid,
                role,
              ]);
            }
            await blocker.query("ROLLBACK");
            await blocker.end();
            await pending?.catch(() => {});
          }
          expect(published).toBe(false);
          const fresh = await runFunctionTransaction(connection, "query", async (tx) =>
            tx.execute<{ value: number }>(sql`SELECT 1 AS value`),
          );
          expect(fresh.rows[0]?.value).toBe(1);
          expect(connection.pool.waitingCount).toBe(0);
          expect(connection.pool.idleCount).toBe(connection.pool.totalCount);
        }
        // Disposal must finish even when application JavaScript never resumes.
        const entered = Promise.withResolvers<number>();
        const resume = Promise.withResolvers<void>();
        const callbackSettled = Promise.withResolvers<void>();
        const controller = new AbortController();
        const reason = new Error("Cancelled suspended callback");
        let lateQueryRejected = false;
        const pending = runFunctionTransaction(
          connection,
          "query",
          async (tx) => {
            try {
              const rows = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
              const pid = rows.rows[0]?.pid;
              if (pid === undefined) throw new Error("Missing callback backend");
              ownedPids.add(pid);
              entered.resolve(pid);
              await resume.promise;
              await assert.rejects(tx.execute(sql`SELECT 1`), /inactive/i);
              lateQueryRejected = true;
            } finally {
              callbackSettled.resolve();
            }
          },
          { signal: controller.signal },
        );
        try {
          const pid = await bounded(entered.promise, "Callback did not enter");
          controller.abort(reason);
          await assert.rejects(bounded(pending, "Suspended callback did not reject"), (error) => error === reason);
          await waitFor(async () => {
            const row = await activity(pid);
            return !row || (!row.active && !row.transaction_open && !row.state.startsWith("idle in transaction"));
          }, "Suspended callback retained transaction");
          const fresh = await runFunctionTransaction(connection, "query", async (tx) =>
            tx.execute<{ value: number }>(sql`SELECT 1 AS value`),
          );
          expect(fresh.rows[0]?.value).toBe(1);
          expect(connection.pool.idleCount).toBe(connection.pool.totalCount);
        } finally {
          resume.resolve();
          await pending.catch(() => {});
          await callbackSettled.promise;
        }
        expect(lateQueryRejected).toBe(true);
      } finally {
        for (const pid of ownedPids) {
          if ((await activity(pid))?.transaction_open) {
            await owner.query("SELECT pg_cancel_backend($1) FROM pg_stat_activity WHERE pid = $1 AND usename = $2", [
              pid,
              role,
            ]);
          }
        }
        await connection?.close();
        await owner.query(`DROP OWNED BY "${role}"`);
        await owner.query(`DROP ROLE "${role}"`);
        await owner.end();
      }
    },
    60_000,
  );
}
