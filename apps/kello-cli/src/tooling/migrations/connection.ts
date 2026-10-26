import pg from "pg";
import * as v from "valibot";
import { channel } from "node:diagnostics_channel";
import { setTimeout } from "node:timers/promises";

const ownedConnections = new WeakSet<pg.Client>();

/** Session-level stages must not retain locks on arbitrary or pooled clients. */
export function assertMigrationConnection(client: pg.Client): void {
  if (!ownedConnections.has(client)) throw new Error("Stage requires an active owned migration connection");
}

export const databaseIdentifier = v.pipe(v.string(), v.regex(/^[a-z][a-z0-9_]{0,62}$/));
export function quoteIdentifier(name: string): string {
  return `"${v.parse(databaseIdentifier, name)}"`;
}

/** Blocking advisory-lock SELECTs can deadlock concurrent index builds waiting for older snapshots. */
export async function acquireMigrationLock(
  client: pg.Client,
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
  operation: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const url = new URL(connectionString);
  if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error("Expected a PostgreSQL migration URL");
  // Preserve certificate verification explicitly for provider-returned Neon URLs across pg upgrades.
  if (url.hostname.endsWith(".neon.tech")) url.searchParams.set("sslmode", "verify-full");
  const client = new pg.Client({
    connectionString: url.href,
    connectionTimeoutMillis: 5000,
    application_name: "loom-migrations",
  });
  let result: T;
  try {
    client.on("error", () => channel("kello.migrations.connection_error").publish({ code: "CONNECTION_LOST" }));
    await client.connect();
    const version = await client.query<{ server_version_num: string }>("SHOW server_version_num");
    if (Math.floor(Number(version.rows[0]?.server_version_num) / 10000) !== 18)
      throw new Error("Kello migrations require PostgreSQL 18");
    await client.query("SET lock_timeout = '5s'");
    await client.query("SET statement_timeout = '60s'");
    await client.query("SET search_path = pg_catalog");
    ownedConnections.add(client);
    result = await operation(client);
  } catch (error) {
    ownedConnections.delete(client);
    try {
      await client.end();
    } catch {
      // Preserve the original connection or migration failure when cleanup also fails.
    }
    throw error;
  }
  ownedConnections.delete(client);
  await client.end();
  return result;
}

/** Caller owns the outer transaction. Rollback restores SET LOCAL on failure. */
export async function withBlockingGinTimeout<T>(
  client: pg.Client,
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
