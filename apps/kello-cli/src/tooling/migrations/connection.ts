import { createPool } from "drizzle-orm/postgres/client/node";
import type { Connection, Pool, PoolConfig } from "drizzle-orm/postgres/client/node";
import * as v from "valibot";
import { assertResolvableHost, isNeonHost, tcpTls } from "kello/internal/tooling";
import { setTimeout } from "node:timers/promises";

/** A decoded column: driver scalars, arrays of them, or JSON documents. */
export type SessionValue =
  | string
  | number
  | boolean
  | bigint
  | null
  | Date
  | Uint8Array
  | readonly SessionValue[]
  | { readonly [key: string]: SessionValue };
export type SessionRow = Readonly<Record<string, SessionValue>>;
export interface SessionResult<R> {
  readonly rows: R[];
  readonly rowCount: number | null;
}
export interface SessionQueryOptions {
  /** Sends a CancelRequest for the running statement when it fires. */
  readonly signal?: AbortSignal;
}

/** One dedicated, unpooled server session. Session locks and settings stay with it until it closes. */
export interface DatabaseSession {
  /** The driver connection, for building a Drizzle database on this same session. */
  readonly connection: Connection<{ pooled: true }>;
  readonly inTransaction: boolean;
  query<R extends object = SessionRow>(
    text: string,
    values?: readonly unknown[],
    options?: SessionQueryOptions,
  ): Promise<SessionResult<R>>;
}

export function createDatabaseSession(connection: Connection<{ pooled: true }>): DatabaseSession {
  return {
    connection,
    get inTransaction() {
      return connection.inTransaction;
    },
    async query<R extends object = SessionRow>(
      text: string,
      values: readonly unknown[] = [],
      options: SessionQueryOptions = {},
    ): Promise<SessionResult<R>> {
      const result = options.signal
        ? await connection.query(text, values, { mode: "object", signal: options.signal })
        : await connection.query(text, values, { mode: "object" });
      // SAFETY: object mode returns one record per row; callers name the columns they select.
      return { rows: result.rows as R[], rowCount: result.rowCount };
    },
  };
}

const ownedConnections = new WeakSet<DatabaseSession>();

/** Neon hosts always verify the certificate and hostname, overriding any URL sslmode (the driver reads
 * Neon's default `sslmode=require` as encrypt-only). Other hosts keep node-postgres' reading: no sslmode
 * or `disable` is plaintext, an explicit `no-verify` encrypts without verifying, and every other mode
 * verifies the certificate and hostname. */
export function sessionTls(address: URL): "verify-full" | "require" | false {
  const tls = tcpTls(address);
  if (!isNeonHost(address.hostname)) return tls;
  const mode = address.searchParams.get("sslmode") ?? address.searchParams.get("ssl");
  if (mode !== null && tls === false) throw new Error("Neon connections require TLS");
  return "verify-full";
}

export interface SessionPoolOptions {
  readonly applicationName: string;
  readonly connectTimeout: number;
  readonly options?: string;
}

/** A single-connection pool: only pooled connections can send a CancelRequest. Never reconnects, because a
 * replacement session would silently drop the locks and settings of the one it replaces. */
export function createSessionPool(connectionString: string, settings: SessionPoolOptions): Pool {
  const url = new URL(connectionString);
  if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error("Expected a PostgreSQL migration URL");
  assertResolvableHost(url);
  const config: PoolConfig = {
    url: url.href,
    max: 1,
    ssl: sessionTls(url),
    applicationName: settings.applicationName,
    connectTimeout: settings.connectTimeout,
    acquireTimeoutMillis: settings.connectTimeout,
    reconnect: false,
    // Match the text values the tooling compares and passes back as parameters.
    int8: "string",
    txGuard: false,
  };
  if (settings.options) config.options = settings.options;
  return createPool(config);
}

/** Closes the session's socket itself, so a connection left mid-transaction is never returned to the pool. */
export async function closeSession(pool: Pool, session: DatabaseSession | undefined): Promise<void> {
  try {
    await session?.connection.end();
  } finally {
    await pool.end();
  }
}

/** Session-level stages must not retain locks on arbitrary or pooled clients. */
export function assertMigrationConnection(client: DatabaseSession): void {
  if (!ownedConnections.has(client)) throw new Error("Stage requires an active owned migration connection");
}

export const databaseIdentifier = v.pipe(v.string(), v.regex(/^[a-z][a-z0-9_]{0,62}$/));
export function quoteIdentifier(name: string): string {
  return `"${v.parse(databaseIdentifier, name)}"`;
}

/** Blocking advisory-lock SELECTs can deadlock concurrent index builds waiting for older snapshots. */
export async function acquireMigrationLock(
  client: DatabaseSession,
  key: string,
  shared = false,
  signal?: AbortSignal,
): Promise<void> {
  assertMigrationConnection(client);
  const deadline = performance.now() + 5000;
  const operation = shared ? "pg_try_advisory_lock_shared" : "pg_try_advisory_lock";
  for (;;) {
    signal?.throwIfAborted();
    const result = await client.query<{ acquired: boolean }>(
      `SELECT ${operation}(hashtextextended($1, 0)) AS acquired`,
      [key],
    );
    if (result.rows[0]?.acquired) return;
    if (performance.now() >= deadline) throw new Error("Timed out waiting for the migration lock");
    await setTimeout(25, undefined, signal ? { signal } : undefined);
  }
}

/** Always owns a dedicated session: session locks must never return to a pool. */
export async function withMigrationConnection<T>(
  connectionString: string,
  operation: (client: DatabaseSession) => Promise<T>,
): Promise<T> {
  const pool = createSessionPool(connectionString, { applicationName: "kello-migrations", connectTimeout: 5000 });
  let result: T;
  let client: DatabaseSession | undefined;
  try {
    const checkout = await pool.connect();
    client = createDatabaseSession(checkout.client);
    const version = await client.query<{ server_version_num: string }>("SHOW server_version_num");
    if (Math.floor(Number(version.rows[0]?.server_version_num) / 10000) !== 18)
      throw new Error("Kello migrations require PostgreSQL 18");
    await client.query("SET lock_timeout = '5s'");
    await client.query("SET statement_timeout = '60s'");
    await client.query("SET search_path = pg_catalog");
    ownedConnections.add(client);
    result = await operation(client);
  } catch (error) {
    if (client) ownedConnections.delete(client);
    try {
      await closeSession(pool, client);
    } catch {
      // Preserve the original connection or migration failure when cleanup also fails.
    }
    throw error;
  }
  ownedConnections.delete(client);
  await closeSession(pool, client);
  return result;
}

/** Caller owns the outer transaction. Rollback restores SET LOCAL on failure. */
export async function withBlockingGinTimeout<T>(
  client: DatabaseSession,
  statementTimeoutMs: number,
  operation: () => Promise<T>,
): Promise<T> {
  assertMigrationConnection(client);
  if (!Number.isSafeInteger(statementTimeoutMs) || statementTimeoutMs < 1 || statementTimeoutMs > 900000)
    throw new Error("Blocking GIN statement timeout must be an integer in 1..900000 ms");
  const setting = await client.query<{ timeout: string }>("SELECT current_setting('statement_timeout') AS timeout");
  const previous = setting.rows[0]?.timeout;
  if (previous === undefined) throw new Error("Missing PostgreSQL statement timeout");
  await client.query("SELECT set_config('statement_timeout', $1, true)", [`${statementTimeoutMs}ms`]);
  const result = await operation();
  await client.query("SELECT set_config('statement_timeout', $1, true)", [previous]);
  return result;
}
