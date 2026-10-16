import { sql } from "drizzle-orm";
import type { AnyRelations } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { ORPCError } from "@orpc/server";
import { scopedDatabase } from "../server/database/context";
import { captureInvocationGuard } from "../server/database/connection";

/** Bound the whole search evaluation, using only its already-owned transaction. */
export async function withSearchDeadline<Result>(
  database: NodePgDatabase,
  relations: AnyRelations,
  timeoutMs: number,
  signal: AbortSignal,
  assertCurrent: () => void,
  work: (statement: <Value>(read: () => Promise<Value>) => Promise<Value>) => Promise<Result>,
): Promise<Result> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("Invalid full-text timeout");
  const db = scopedDatabase(database, relations);
  const assertOwned = captureInvocationGuard();
  const deadline = performance.now() + timeoutMs;
  let active = true;
  const exhausted = (cause?: unknown) =>
    new ORPCError("QUERY_BUDGET_EXCEEDED", {
      message: "Search exceeds its configured time budget",
      cause,
    });
  function check() {
    if (!active) throw new Error("Search deadline is inactive");
    signal.throwIfAborted();
    assertOwned();
    assertCurrent();
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw exhausted();
    return Math.max(1, Math.ceil(remaining));
  }
  check();
  const settings = await db.execute<{ milliseconds: number }>(sql`
    select setting::int as milliseconds from pg_catalog.pg_settings where name = 'statement_timeout'`);
  const setting = settings.rows[0]?.milliseconds;
  if (setting === undefined || !Number.isSafeInteger(setting) || setting < 0)
    throw new Error("Invalid PostgreSQL statement timeout");
  const previous: number = setting;
  async function statement<Value>(read: () => Promise<Value>): Promise<Value> {
    const remaining = check();
    const limit = previous === 0 ? remaining : Math.min(previous, remaining);
    await db.execute(sql`select set_config('statement_timeout', ${`${limit}ms`}, true)`);
    check();
    try {
      const result = await read();
      check();
      return result;
    } catch (cause) {
      signal.throwIfAborted();
      assertCurrent();
      let error = cause;
      for (let depth = 0; depth < 8 && error instanceof Error; depth++) {
        if ("code" in error && error.code === "57014") throw exhausted(cause);
        error = error.cause;
      }
      throw cause;
    }
  }
  try {
    const result = await work(statement);
    check();
    // Failed statements leave PostgreSQL aborted. Let the invocation roll back;
    // a reset in finally would mask that original error with an aborted-transaction error.
    await db.execute(sql`select set_config('statement_timeout', ${`${previous}ms`}, true)`);
    check();
    return result;
  } finally {
    active = false;
  }
}
