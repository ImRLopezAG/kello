import type { Connection, Pool } from "drizzle-orm/postgres/client/node";

/** Calls `observe` with every connection the pool checks out. */
export function observeConnections(pool: Pool, observe: (client: Connection) => void): void {
  const acquire = pool.acquire.bind(pool);
  pool.acquire = async () => {
    const client = await acquire();
    observe(client);
    return client;
  };
}
