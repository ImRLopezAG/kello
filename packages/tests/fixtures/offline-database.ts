import type { AnyRelations, EmptyRelations } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres";
import { createPool } from "drizzle-orm/postgres/client/node";
import type { PoolQuery } from "drizzle-orm/postgres/client/node";
import type { DatabaseConnection } from "../../../apps/kello/src/core/server/database/connection";

/** A connection over a pool that points at a closed port. It never connects unless a
 * test queries it; tests that need rows replace `pool.query`. */
export function offlineConnection<Relations extends AnyRelations = EmptyRelations>(
  relations?: Relations,
  transaction?: DatabaseConnection<Relations>["transaction"],
): DatabaseConnection<Relations> {
  const pool = createPool({ url: "postgresql://unused:unused@127.0.0.1:1/unused", max: 1 });
  // SAFETY: an omitted relation graph is Drizzle's empty graph.
  const db = drizzle({ client: pool, relations: (relations ?? {}) as Relations });
  return {
    db,
    pool,
    transaction: transaction ?? db.transaction.bind(db),
    close: () => pool.end(),
  };
}

/** A stubbed `pool.query` result. */
export function poolQueryResult(result: { rows: unknown[]; columns: string[]; rowCount: number; command: string }) {
  // SAFETY: Drizzle's session only awaits the query; it calls none of the lazy query's own methods.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- a test double for the driver's lazy query
  return Promise.resolve(result) as unknown as PoolQuery;
}
