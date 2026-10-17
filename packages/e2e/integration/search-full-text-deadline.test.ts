import { expect, test } from "bun:test";
import { defineRelations, sql } from "drizzle-orm";
import { defineSchema } from "../../../apps/kello/src/core/schema/define-schema";
import { connectDatabase, captureInvocationGuard } from "../../../apps/kello/src/core/server/database/connection";
import { runFunctionTransaction } from "../../../apps/kello/src/core/server/transactions";
import { withSearchDeadline } from "../../../apps/kello/src/core/search/deadline";

test("full-text deadlines retain owned read snapshots and restore only on success", async () => {
  const connectionString = process.env.LOOM_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("LOOM_TEST_DATABASE_URL is required for full-text acceptance");
  const schema = defineSchema(() => ({}));
  const relations = defineRelations(schema.tables);
  const connection = await connectDatabase({ schema, relations, connectionString, maxConnections: 1 });
  const signal = new AbortController().signal;
  try {
    const version = await connection.db.execute<{ version: number }>(
      sql`select current_setting('server_version_num')::int as version`,
    );
    expect(version.rows[0]!.version).toBeGreaterThanOrEqual(180000);
    expect(version.rows[0]!.version).toBeLessThan(190000);
    await expect(
      withSearchDeadline(
        connection.db,
        relations,
        100,
        signal,
        () => {},
        async () => null,
      ),
    ).rejects.toThrow();
    await runFunctionTransaction(connection, "query", async (tx) => {
      await tx.execute(sql`select set_config('statement_timeout', '250ms', true)`);
      await withSearchDeadline(tx, relations, 1000, signal, captureInvocationGuard(), async (statement) => {
        const preflight = await statement(() =>
          tx.execute<{ query: string; mode: string; timeout: string }>(sql`
          select plainto_tsquery('pg_catalog.english'::regconfig, ${"ranking proof"})::text as query,
          current_setting('transaction_read_only') as mode, current_setting('statement_timeout') as timeout`),
        );
        expect(preflight.rows[0]).toEqual({ query: "'rank' & 'proof'", mode: "on", timeout: "250ms" });
        await statement(() => tx.execute(sql`select pg_sleep(0.01)`));
        const count = await statement(() =>
          tx.execute<{ count: string }>(sql`select count(*)::text as count from (values(1),(2)) items`),
        );
        expect(count.rows[0]?.count).toBe("2");
      });
      const restored = await tx.execute<{ timeout: string }>(
        sql`select current_setting('statement_timeout') as timeout`,
      );
      expect(restored.rows[0]?.timeout).toBe("250ms");
    });
    let reachedCount = false;
    const started = performance.now();
    await expect(
      runFunctionTransaction(connection, "query", async (tx) => {
        await withSearchDeadline(tx, relations, 180, signal, captureInvocationGuard(), async (statement) => {
          await statement(() =>
            tx.execute(sql`select pg_sleep(0.06), plainto_tsquery('pg_catalog.simple', ${"proof"})`),
          );
          await statement(() => tx.execute(sql`select pg_sleep(0.06)`));
          reachedCount = true;
          await statement(() => tx.execute(sql`select pg_sleep(0.15), count(*) from (values(1)) items`));
        });
      }),
    ).rejects.toMatchObject({ code: "QUERY_BUDGET_EXCEEDED" });
    expect(reachedCount).toBe(true);
    expect(performance.now() - started).toBeLessThan(1500);
    expect(connection.pool.waitingCount).toBe(0);
    expect(connection.pool.idleCount).toBe(1);
    for (const phase of [0, 1, 2]) {
      await expect(
        runFunctionTransaction(connection, "query", (tx) =>
          withSearchDeadline(tx, relations, 100, signal, captureInvocationGuard(), async (statement) => {
            for (let current = 0; current <= phase; current++)
              await statement(() => tx.execute(sql`select pg_sleep(${current === phase ? 0.2 : 0.005})`));
          }),
        ),
      ).rejects.toMatchObject({ code: "QUERY_BUDGET_EXCEEDED" });
    }
    await expect(
      runFunctionTransaction(connection, "query", async (tx) => {
        await tx.execute(sql`select set_config('statement_timeout', '25ms', true)`);
        await withSearchDeadline(tx, relations, 500, signal, captureInvocationGuard(), (statement) =>
          statement(() => tx.execute(sql`select pg_sleep(0.1)`)),
        );
      }),
    ).rejects.toMatchObject({ code: "QUERY_BUDGET_EXCEEDED" });
    await expect(
      runFunctionTransaction(connection, "query", (tx) =>
        withSearchDeadline(tx, relations, 500, signal, captureInvocationGuard(), (statement) =>
          statement(() => tx.execute(sql`select 1 / 0`)),
        ),
      ),
    ).rejects.toMatchObject({ cause: { code: "22012" } });
    await runFunctionTransaction(connection, "query", async (tx) => {
      const restored = await tx.execute<{ timeout: string }>(
        sql`select current_setting('statement_timeout') as timeout`,
      );
      expect(restored.rows[0]?.timeout).toBe("0");
    });
    // Independent finite calls each enter a fresh owned transaction and deadline.
    for (let event = 0; event < 2; event++) {
      const result = await runFunctionTransaction(connection, "query", (tx) =>
        withSearchDeadline(tx, relations, 150, signal, captureInvocationGuard(), async (statement) => {
          await statement(() => tx.execute(sql`select pg_sleep(0.08)`));
          return event;
        }),
      );
      expect(result).toBe(event);
    }
    const expired = new Error("Identity expired");
    await expect(
      runFunctionTransaction(connection, "query", (tx) =>
        withSearchDeadline(
          tx,
          relations,
          500,
          signal,
          () => {
            throw expired;
          },
          async () => null,
        ),
      ),
    ).rejects.toBe(expired);
    const abort = new AbortController();
    const cancelled = new Error("Caller cancelled");
    const cancellation = runFunctionTransaction(
      connection,
      "query",
      (tx) =>
        withSearchDeadline(tx, relations, 500, abort.signal, captureInvocationGuard(), async (statement) => {
          const timer = setTimeout(() => abort.abort(cancelled), 20);
          try {
            return await statement(() => tx.execute(sql`select pg_sleep(2)`));
          } finally {
            clearTimeout(timer);
          }
        }),
      { signal: abort.signal },
    );
    await expect(cancellation).rejects.toBe(cancelled);
  } finally {
    await connection.close();
  }
}, 15000);
