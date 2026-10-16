import { channel } from "node:diagnostics_channel";
import { AsyncLocalStorage } from "node:async_hooks";
import type { AnyRelations } from "drizzle-orm";
import { drizzle, NodePgSession, NodePgTransaction, nodePgCodecs } from "drizzle-orm/node-postgres";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { PgDialect } from "drizzle-orm/pg-core";
import type { PgTable } from "drizzle-orm/pg-core";
import { rememberDatabaseAdapter } from "./context";
import { validateSchemaRelations } from "./relations";
import type pg from "pg";
import { RuntimePool } from "./pool";
import { cancelDatabaseStatement } from "./cancel";
import type { SchemaMetadata } from "../../schema/compile";

export interface DatabaseSchema {
  readonly tables: Readonly<Record<string, PgTable>>;
  readonly metadata: SchemaMetadata;
}
export interface DatabaseOptions<Relations extends AnyRelations> {
  readonly schema: DatabaseSchema;
  readonly relations: Relations;
  readonly connectionString: string;
  readonly maxConnections?: number;
}
export interface DatabaseConnection<Relations extends AnyRelations> {
  readonly db: NodePgDatabase<Relations>;
  readonly pool: pg.Pool;
  readonly transaction: NodePgDatabase<Relations>["transaction"];
  readonly close: () => Promise<void>;
}
const poolErrors = channel("kello.database.pool.error");
const invocation = new AsyncLocalStorage<{ active: boolean }>();
const transactionSignal = new AsyncLocalStorage<AbortSignal>();

/** Detect transaction ownership without exposing a capability or its token. */
export function hasDatabaseInvocation(): boolean {
  return invocation.getStore() !== undefined;
}

/** Carry cancellation to the native connection without changing Drizzle's API. */
export function withTransactionSignal<Result>(signal: AbortSignal | undefined, work: () => Result): Result {
  return signal ? transactionSignal.run(signal, work) : work();
}

/** Capture ownership without exposing the token to application contexts. */
export function captureInvocationGuard(): () => void {
  const owner = invocation.getStore();
  if (!owner?.active) throw new Error("Database invocation is inactive");
  return () => {
    if (!owner.active) throw new Error("Database invocation is inactive");
    if (invocation.getStore() !== owner) throw new Error("Database belongs to a different invocation");
  };
}

/** Runtime credentials only. Schema installation belongs to the migration adapter. */
export async function connectDatabase<Relations extends AnyRelations>(
  options: DatabaseOptions<Relations>,
): Promise<DatabaseConnection<Relations>> {
  validateSchemaRelations(options.schema, options.relations);
  const address = URL.parse(options.connectionString);
  if (!address || !["postgres:", "postgresql:"].includes(address.protocol))
    throw new Error("Expected a PostgreSQL URL");
  const max = options.maxConnections ?? 4;
  if (!Number.isInteger(max) || max < 1 || max > 20) throw new Error("maxConnections must be an integer from 1 to 20");
  const pool = new RuntimePool({
    connectionString: options.connectionString,
    max,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
  });
  pool.on("error", () => poolErrors.publish({ code: "DATABASE_POOL_ERROR" }));
  try {
    const version = await pool.query<{ server_version_num: string }>("SHOW server_version_num");
    const majorVersion = Math.floor(Number(version.rows[0]?.server_version_num) / 10000);
    if (majorVersion !== 18) throw new Error("Kello requires PostgreSQL 18");
    const db = drizzle({ client: pool, relations: options.relations });
    const transaction: NodePgDatabase<Relations>["transaction"] = async (operation, config) => {
      const signal = transactionSignal.getStore();
      signal?.throwIfAborted();
      let state: "starting" | "active" | "finishing" | "closed" = "starting";
      const owner = { active: false };
      let client: pg.PoolClient | undefined;
      let released = false;
      let abortCleanup: Promise<void> | undefined;
      const release = (destroy: boolean) => {
        if (!client || released) return;
        released = true;
        client.release(destroy);
      };
      let rejectAbort = () => {};
      const aborted = new Promise<never>((_resolve, reject) => {
        rejectAbort = () => reject(signal?.reason);
      });
      const abort = () => {
        owner.active = false;
        state = "closed";
        // A transaction pooler can keep disconnected SQL running. Send its
        // BackendKeyData cancellation before closing the original mapping.
        if (client && !released) {
          abortCleanup ??= cancelDatabaseStatement(client)
            .catch(() => poolErrors.publish({ code: "DATABASE_CANCEL_ERROR" }))
            .finally(() => release(true));
        }
        rejectAbort();
      };
      const run = async () => {
        const acquired = await pool.connect();
        client = acquired;
        try {
          // Acquisition may complete after the caller has already aborted.
          if (signal?.aborted) {
            // No BEGIN was sent, so this connection is still safe to reuse.
            release(false);
            signal.throwIfAborted();
          }
          const logger = {
            logQuery(query: string) {
              if (state === "starting" && (query === "begin" || query.startsWith("begin "))) return;
              if (state === "active") {
                if (invocation.getStore() !== owner) throw new Error("Database belongs to a different invocation");
                return;
              }
              // Drizzle commits or rolls back after the application callback has settled.
              if (state === "finishing" && (query === "commit" || query === "rollback")) return;
              throw new Error("Database invocation is inactive");
            },
          };
          const scoped = drizzle({ client: acquired, relations: options.relations, logger });
          const dialect = new PgDialect({ codecs: nodePgCodecs });
          const scopedAdapters = new Map<AnyRelations, NodePgDatabase>();
          const adapter = <ScopeRelations extends AnyRelations>(
            relations: ScopeRelations,
          ): NodePgDatabase<ScopeRelations> => {
            const cached = scopedAdapters.get(relations);
            if (cached) {
              // SAFETY: each cache key is the exact relation graph used by its adapter.
              return cached as NodePgDatabase<ScopeRelations>;
            }
            const child = new NodePgTransaction(
              dialect,
              new NodePgSession(acquired, dialect, relations, { logger }),
              relations,
              undefined,
              false,
            );
            rememberDatabaseAdapter(child, relations, adapter);
            scopedAdapters.set(relations, child);
            return child;
          };
          return await scoped.transaction(async (tx) => {
            signal?.throwIfAborted();
            state = "active";
            owner.active = true;
            rememberDatabaseAdapter(tx, options.relations, adapter);
            scopedAdapters.set(options.relations, tx);
            try {
              const result = await invocation.run(owner, () => operation(tx));
              signal?.throwIfAborted();
              return result;
            } finally {
              owner.active = false;
              if (!signal?.aborted) state = "finishing";
            }
          }, config);
        } finally {
          // Cancellation also owns cleanup when a suspended callback never
          // settles. A settling callback must not disconnect ahead of it.
          await abortCleanup;
          release(signal?.aborted ?? false);
        }
      };
      signal?.addEventListener("abort", abort, { once: true });
      try {
        // Own both outcomes: the callback can settle after cancellation, but
        // cannot publish a result or retain transaction/database authority.
        return await Promise.race([run(), aborted]);
      } catch (cause) {
        signal?.throwIfAborted();
        throw cause;
      } finally {
        signal?.removeEventListener("abort", abort);
        owner.active = false;
        state = "closed";
        // The abort race can settle before run() does. Finish cancellation and
        // release its connection before the caller's invocation scope closes.
        await abortCleanup;
      }
    };
    return { db, pool, transaction, close: () => pool.end() };
  } catch (cause) {
    await pool.end();
    throw cause;
  }
}
