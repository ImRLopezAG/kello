import { createPool as createNeonPool } from "drizzle-orm/postgres/client/neon-ws";
import { createPool as createTcpPool, parseConnectionString } from "drizzle-orm/postgres/client/node";
import type { Pool, PoolConfig } from "drizzle-orm/postgres/client/node";
import { publishRuntimeMetric } from "../observability";

export type RuntimePool = Pool;

export interface RuntimePoolOptions {
  readonly address: URL;
  readonly max: number;
}

/** Neon hosts are reached through Neon's WebSocket proxy; every other host over TCP. */
export function isNeonHost(hostname: string): boolean {
  return hostname.endsWith(".neon.tech");
}

/** TLS over TCP keeps node-postgres' reading of sslmode: none or `disable` is plaintext, an explicit
 * `no-verify` encrypts without verifying, and every other mode verifies the certificate and hostname.
 * Shared with kello-cli's migration sessions, which add a Neon-only override on top. */
export function tcpTls(address: URL): "verify-full" | "require" | false {
  const mode = address.searchParams.get("sslmode") ?? address.searchParams.get("ssl");
  if (mode === null || mode === "disable" || mode === "false" || mode === "0") return false;
  return mode === "no-verify" ? "require" : "verify-full";
}

/** A connection string the driver failed to read would fall back to localhost or PGHOST. */
export function assertResolvableHost(address: URL): void {
  const host = address.hostname.startsWith("[") ? address.hostname.slice(1, -1) : address.hostname;
  if (parseConnectionString(address.href).host !== host)
    throw new Error("Database host could not be resolved from the connection string");
}

/** One pool per connection. The same type backs both transports, so callers have one code path. */
export function createRuntimePool({ address, max }: RuntimePoolOptions): RuntimePool {
  const url = address.href;
  assertResolvableHost(address);
  const shared = {
    url,
    max,
    connectTimeout: 5000,
    acquireTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    // Code inside a function transaction may use the root database on its own connection, as before.
    txGuard: false,
  } satisfies PoolConfig;
  const pool = isNeonHost(address.hostname)
    ? createNeonPool({ ...shared, secure: true })
    : createTcpPool({ ...shared, ssl: tcpTls(address) });
  measureAcquisition(pool);
  return pool;
}

/** Every checked-out connection reports how long it waited and the pool's occupancy. */
function measureAcquisition(pool: Pool): void {
  const acquire = pool.acquire.bind(pool);
  pool.acquire = async () => {
    const started = performance.now();
    const report = (status: "success" | "error") =>
      publishRuntimeMetric({
        type: "database.acquire",
        status,
        durationMs: performance.now() - started,
        total: pool.size,
        idle: pool.idleCount,
        waiting: pool.waiting,
      });
    try {
      const connection = await acquire();
      report("success");
      return connection;
    } catch (error) {
      report("error");
      throw error;
    }
  };
}
