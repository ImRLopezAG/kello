import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";
import { test, expect } from "bun:test";
import * as pg from "../fixtures/postgres";
import { sql } from "drizzle-orm";
import { connectDatabase, defineSchema, runFunctionTransaction } from "kello/server";

const ownerUrl = process.env.KELLO_TEST_DATABASE_URL;
const pooledUrl = process.env.KELLO_TEST_POOLED_DATABASE_URL;
// Kello's fixed per-statement ceiling inside function transactions.
const statementCeilingMs = 30_000;

async function waitFor(predicate: () => Promise<boolean>, message: string, timeoutMs = 3000) {
  const expires = performance.now() + timeoutMs;
  while (!(await predicate())) {
    if (performance.now() > expires) throw new Error(message);
    await setTimeout(50);
  }
}

async function bounded<Result>(pending: Promise<Result>, message: string, timeoutMs = 1000): Promise<Result> {
  const timer = new AbortController();
  try {
    return await Promise.race([
      pending,
      setTimeout(timeoutMs, undefined, { signal: timer.signal }).then(() => {
        throw new Error(message);
      }),
    ]);
  } finally {
    timer.abort();
  }
}

function milliseconds(setting: string): number {
  const match = /^(\d+)(ms|s|min)?$/.exec(setting);
  if (!match) throw new Error(`Unexpected statement_timeout ${setting}`);
  const value = Number(match[1]);
  return match[2] === "s" ? value * 1000 : match[2] === "min" ? value * 60_000 : value;
}

for (const [transport, runtimeUrl] of [
  ["direct", ownerUrl],
  ["pooler", pooledUrl],
] as const) {
  test.skipIf(!ownerUrl || !runtimeUrl)(
    `abort ends the transaction connection and the server bounds its statement through ${transport}`,
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
          await owner.query<{ active: boolean; transaction_open: boolean; wait_event: string | null }>(
            "SELECT state = 'active' AS active, xact_start IS NOT NULL AS transaction_open, wait_event FROM pg_stat_activity WHERE pid = $1 AND usename = $2",
            [pid, role],
          )
        ).rows[0];
      try {
        await owner.connect();
        await owner.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}'`);
        await owner.query(`GRANT "${role}" TO CURRENT_USER`);
        const address = new URL(runtimeUrl);
        address.username = role;
        address.password = password;
        connection = await connectDatabase({
          connectionString: address.href,
          schema,
          relations: {},
          maxConnections: 1,
        });
        const pool = connection.pool;

        // The statement bound is in place for every function transaction.
        for (const kind of ["query", "mutation"] as const) {
          const bound = await runFunctionTransaction(connection, kind, (tx) =>
            tx.execute<{ value: string }>(sql`SELECT current_setting('statement_timeout') AS value`),
          );
          const value = milliseconds(bound.rows[0]?.value ?? "");
          expect(value).toBeGreaterThan(0);
          expect(value).toBeLessThanOrEqual(statementCeilingMs);
        }
        const outside = await connection.db.execute<{ value: string }>(
          sql`SELECT current_setting('statement_timeout') AS value`,
        );
        expect(outside.rows[0]?.value).toBe("0");

        // Abort during a long statement.
        const controller = new AbortController();
        const reason = new Error("Cancelled sleep");
        const entered = Promise.withResolvers<number>();
        let published = false;
        const pending = runFunctionTransaction(
          connection,
          "query",
          async (tx) => {
            const rows = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
            const backend = rows.rows[0]?.pid;
            if (backend === undefined) throw new Error("Missing transaction backend");
            ownedPids.add(backend);
            entered.resolve(backend);
            await tx.execute(sql`SELECT pg_sleep(45)`);
            published = true;
          },
          { signal: controller.signal },
        );
        const outcome = pending.then(
          () => ({ resolved: true, error: undefined }),
          (error: Error) => ({ resolved: false, error }),
        );
        const pid = await bounded(entered.promise, "Transaction did not enter", 3000);
        await waitFor(async () => (await activity(pid))?.wait_event === "PgSleep", "Statement did not start");
        expect(pool.size).toBe(1);
        const abortedAt = performance.now();
        controller.abort(reason);
        const result = await bounded(outcome, "Caller did not reject within 1s");
        expect(result.resolved).toBe(false);
        expect(result.error).toBe(reason);
        // The aborted connection left the pool instead of returning to it.
        expect(pool.size).toBe(0);
        expect(pool.idleCount).toBe(0);
        expect(published).toBe(false);

        // The next transaction gets a fresh connection.
        const fresh = await runFunctionTransaction(connection, "query", (tx) =>
          tx.execute<{ value: number }>(sql`SELECT 1 AS value`),
        );
        expect(fresh.rows[0]?.value).toBe(1);
        expect(pool.size).toBe(1);
        expect(pool.idleCount).toBe(1);

        // The server stops the statement within the ceiling, even though no cancel was sent.
        await waitFor(
          async () => {
            const row = await activity(pid);
            return !row || (!row.active && !row.transaction_open);
          },
          "Aborted statement outlived the statement ceiling",
          statementCeilingMs + 5000,
        );
        expect(performance.now() - abortedAt).toBeLessThan(statementCeilingMs + 5000);

        // A suspended callback cannot keep using the transaction after abort.
        const suspendedEntered = Promise.withResolvers<void>();
        const resume = Promise.withResolvers<void>();
        const callbackSettled = Promise.withResolvers<void>();
        const suspendedController = new AbortController();
        const suspendedReason = new Error("Cancelled suspended callback");
        let lateQueryRejected = false;
        const suspended = runFunctionTransaction(
          connection,
          "query",
          async (tx) => {
            const rows = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
            const backend = rows.rows[0]?.pid;
            if (backend !== undefined) ownedPids.add(backend);
            suspendedEntered.resolve();
            try {
              await resume.promise;
              await assert.rejects(tx.execute(sql`SELECT 1`), /inactive/i);
              lateQueryRejected = true;
            } finally {
              callbackSettled.resolve();
            }
          },
          { signal: suspendedController.signal },
        );
        try {
          await bounded(suspendedEntered.promise, "Callback did not enter", 3000);
          suspendedController.abort(suspendedReason);
          await assert.rejects(
            bounded(suspended, "Suspended callback did not reject"),
            (error) => error === suspendedReason,
          );
          expect(pool.size).toBe(0);
        } finally {
          resume.resolve();
          await suspended.catch(() => {});
          await bounded(callbackSettled.promise, "Suspended callback did not settle", 3000);
        }
        expect(lateQueryRejected).toBe(true);

        // An abort while waiting for a connection leaves the pool clean.
        const held = await pool.connect();
        const waitingController = new AbortController();
        const waitingReason = new Error("Cancelled before acquisition");
        let ran = false;
        const queued = runFunctionTransaction(
          connection,
          "mutation",
          async () => {
            ran = true;
          },
          { signal: waitingController.signal },
        );
        try {
          await waitFor(async () => pool.waiting === 1, "Transaction did not wait for a connection");
          waitingController.abort(waitingReason);
          await assert.rejects(
            bounded(queued, "Queued transaction did not reject"),
            (error) => error === waitingReason,
          );
        } finally {
          held.release();
        }
        await waitFor(async () => pool.waiting === 0 && pool.idleCount === pool.size, "Pool did not settle");
        expect(ran).toBe(false);
        const clean = await runFunctionTransaction(connection, "query", (tx) =>
          tx.execute<{ value: number }>(sql`SELECT 1 AS value`),
        );
        expect(clean.rows[0]?.value).toBe(1);
        expect(pool.idleCount).toBe(pool.size);
      } finally {
        for (const pid of ownedPids) {
          if ((await activity(pid))?.transaction_open) {
            await owner.query("SELECT pg_terminate_backend($1) FROM pg_stat_activity WHERE pid = $1 AND usename = $2", [
              pid,
              role,
            ]);
          }
        }
        await connection?.close();
        await waitFor(
          async () =>
            (await owner.query("SELECT 1 FROM pg_stat_activity WHERE usename = $1", [role])).rowCount === 0 ||
            (await owner
              .query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = $1", [role])
              .then(() => false)),
          "Role sessions did not close",
          5000,
        ).catch(() => {});
        await owner.query(`DROP OWNED BY "${role}"`);
        await owner.query(`DROP ROLE "${role}"`);
        await owner.end();
      }
    },
    120_000,
  );
}
