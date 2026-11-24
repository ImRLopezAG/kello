import { drizzle } from "drizzle-orm/postgres";
import { createPool } from "drizzle-orm/postgres/client/node";
import type { DatabaseConnection } from "kello/server";

/** A database connection over a pool that points at a closed port. Any query is a test failure. */
export function unusedDatabaseConnection() {
  const pool = createPool({ url: "postgresql://unused:unused@127.0.0.1:1/unused", max: 1 });
  const db = drizzle({ client: pool });
  const connection: DatabaseConnection<typeof db._.relations> = {
    db,
    pool,
    transaction: db.transaction.bind(db),
    close: () => pool.end(),
  };
  return connection;
}
