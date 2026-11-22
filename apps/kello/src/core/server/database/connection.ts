import { AsyncLocalStorage } from "node:async_hooks";
import type { AnyRelations } from "drizzle-orm";
import {
  // oxlint-disable-next-line anti-slop/no-shape-in-symbol-names -- Drizzle's exported name.
  createShapeGenerator,
  drizzle,
  postgresCodecs,
  PostgresSession,
  PostgresTransaction,
} from "drizzle-orm/postgres";
import type { Connection, Pool, TxOptions } from "drizzle-orm/postgres/client/node";
import { DrizzlePostgresClient } from "drizzle-orm/postgres/client/effect";
import { makeWithDefaults } from "drizzle-orm/postgres/effect";
import { Effect, Exit, Layer, Scope } from "effect";
import * as v from "valibot";
import { PgDialect } from "drizzle-orm/pg-core";
import type { PgTable, PgTransactionConfig } from "drizzle-orm/pg-core";
import type { Database, DatabaseTransaction, EffectDatabase } from "./types";
import { rememberDatabaseAdapter, rememberEffectDatabase } from "./context";
import { validateSchemaRelations } from "./relations";
import { createRuntimePool } from "./pool";
import type { RuntimePool } from "./pool";
import { invocationRemainingMs } from "../invocation-deadline";
import type { SchemaMetadata } from "../../schema/compile";

export type { Database, DatabaseTransaction };

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
  readonly db: Database<Relations>;
  readonly pool: RuntimePool;
  readonly transaction: <Result>(
    operation: (tx: DatabaseTransaction<Relations>) => Promise<Result>,
    config?: PgTransactionConfig,
  ) => Promise<Result>;
  readonly close: () => Promise<void>;
}

/** Upper bound for any single statement inside a function transaction. An aborted
 * invocation cannot cancel its statement over every transport, so the server stops it. */
export const transactionStatementCeilingMs = 30_000;

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

function transactionOptions(config: PgTransactionConfig | undefined): TxOptions {
  const options: TxOptions = { readOnly: config?.accessMode === "read only" };
  if (config?.isolationLevel) options.isolation = config.isolationLevel;
  if (config?.deferrable !== undefined) options.deferrable = config.deferrable;
  return options;
}

function statementBoundMs(signal: AbortSignal | undefined): number {
  const remaining = signal ? invocationRemainingMs(signal) : undefined;
  const bound = Math.min(remaining ?? transactionStatementCeilingMs, transactionStatementCeilingMs);
  return Math.max(1, Math.ceil(bound));
}

/* oxlint-disable anti-slop/no-reflect-get, anti-slop/no-reflect-apply, anti-slop/no-runtime-typeof --
 * Proxies forward every member the driver may call, so none can bypass the ownership guard or the pool routing. */
/** Check ownership before any driver call, including paths Drizzle does not log. */
function guardedConnection(connection: Connection, guard: () => void): Connection {
  const proxy: Connection = new Proxy(connection, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        guard();
        // Nested transactions run savepoints on this connection and must stay guarded.
        if ((key === "transaction" || key === "begin") && typeof args.at(-1) === "function") {
          // SAFETY: the last argument of transaction()/begin() is its callback, checked to be a function above.
          const work = args.at(-1) as (connection: Connection) => Promise<void>;
          args[args.length - 1] = () => work(proxy);
        }
        return Reflect.apply(value, target, args);
      };
    },
  });
  return proxy;
}

/** The pinned connection of the function transaction the caller runs in. */
const pinnedConnection = new AsyncLocalStorage<Connection>();

/** A pool-shaped view for the Effect driver that runs every call on the caller's pinned,
 * guarded function connection. Outside a function transaction it refuses to run anything,
 * so the Effect database service never reaches the shared pool. */
interface InvocationPool {
  readonly pool: Pool;
  /** Ends the build-time probe; from then on only pinned connections are reachable. */
  readonly ready: () => void;
}

function invocationPool(pool: Pool): InvocationPool {
  let probing = true;
  const probed = new WeakSet<Connection>();
  const current = (): Connection => {
    const connection = pinnedConnection.getStore();
    if (!connection) throw new Error("Database invocation is inactive");
    return connection;
  };
  const routed = new Proxy(pool, {
    get(target, key) {
      // The driver opens and returns one connection while it is built, only to read its address.
      if (key === "acquire")
        return async () => {
          if (pinnedConnection.getStore() || !probing) return current();
          const connection = await target.acquire();
          probed.add(connection);
          return connection;
        };
      if (key === "release")
        return (connection: Connection) => {
          if (probed.delete(connection)) target.release(connection);
        };
      if (key === "outsideTransaction") return <T>(work: () => T | Promise<T>) => Promise.resolve().then(work);
      const value: unknown = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const connection = current();
        const method: unknown = Reflect.get(connection, key, connection);
        if (typeof method !== "function") throw new Error("Unsupported database operation in a function transaction");
        return Reflect.apply(method, connection, args);
      };
    },
  });
  return { pool: routed, ready: () => (probing = false) };
}
/* oxlint-enable anti-slop/no-reflect-get, anti-slop/no-reflect-apply, anti-slop/no-runtime-typeof */

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
  const pool = createRuntimePool({ address, max });
  try {
    const version = await pool.execute("SHOW server_version_num", [], { mode: "object" });
    const reported = v.safeParse(v.object({ server_version_num: v.string() }), version.rows[0]);
    const versionNumber = reported.success ? reported.output.server_version_num : "0";
    if (Math.floor(Number(versionNumber) / 10000) !== 18) throw new Error("Kello requires PostgreSQL 18");
    const db = drizzle({ client: pool, relations: options.relations });
    // oxlint-disable-next-line anti-slop/no-shape-in-symbol-names -- Drizzle's dialect option and export names.
    const dialect = new PgDialect({ codecs: postgresCodecs, shapeGenerator: createShapeGenerator(postgresCodecs) });
    const effectScope = Effect.runSync(Scope.make());
    const routed = invocationPool(pool);
    const effectServices = await Effect.runPromise(
      Layer.buildWithScope(DrizzlePostgresClient.layerFromPool(routed.pool), effectScope),
    );
    routed.ready();
    const effectDatabases = new Map<AnyRelations, EffectDatabase>();
    // One Effect database per relation graph. It owns no connection: each call runs on
    // the caller's pinned function connection and passes that connection's guard.
    const effectDatabase = <ScopeRelations extends AnyRelations>(
      relations: ScopeRelations,
    ): EffectDatabase<ScopeRelations> => {
      let cached = effectDatabases.get(relations);
      if (!cached) {
        cached = Effect.runSync(makeWithDefaults({ relations }).pipe(Effect.provideContext(effectServices)));
        effectDatabases.set(relations, cached);
      }
      // SAFETY: each cache key is the exact relation graph used by its database.
      return cached as EffectDatabase<ScopeRelations>;
    };

    const transaction: DatabaseConnection<Relations>["transaction"] = async (operation, config) => {
      const signal = transactionSignal.getStore();
      signal?.throwIfAborted();
      let state: "starting" | "active" | "closed" = "starting";
      const owner = { active: false };
      let lease: Awaited<ReturnType<RuntimePool["connect"]>> | undefined;
      let discarded: Promise<void> | undefined;
      // End the connection before releasing it, so the pool drops it instead of reusing it.
      const discard = () => {
        if (!lease) return;
        const { client, release } = lease;
        discarded ??= client
          .end()
          .catch(() => {})
          .finally(release);
      };
      let rejectAbort = () => {};
      const aborted = new Promise<never>((_resolve, reject) => {
        rejectAbort = () => reject(signal?.reason);
      });
      const abort = () => {
        owner.active = false;
        state = "closed";
        discard();
        rejectAbort();
      };
      const guard = () => {
        if (state !== "active" || !owner.active) throw new Error("Database invocation is inactive");
        if (invocation.getStore() !== owner) throw new Error("Database belongs to a different invocation");
      };
      const run = async () => {
        const acquired = await pool.connect();
        if (signal?.aborted) {
          // Nothing was sent on this connection, so it is still clean.
          acquired.release();
          signal.throwIfAborted();
        }
        lease = acquired;
        let entered = false;
        try {
          const client = guardedConnection(acquired.client, guard);
          const logger = { logQuery: guard };
          const scopedAdapters = new Map<AnyRelations, Database>();
          const adapter = <ScopeRelations extends AnyRelations>(
            relations: ScopeRelations,
          ): Database<ScopeRelations> => {
            const cached = scopedAdapters.get(relations);
            if (cached) {
              // SAFETY: each cache key is the exact relation graph used by its adapter.
              return cached as Database<ScopeRelations>;
            }
            const child = new PostgresTransaction(
              dialect,
              new PostgresSession(client, dialect, relations, { logger }),
              relations,
              undefined,
              false,
            );
            rememberDatabaseAdapter(child, relations, adapter);
            rememberEffectDatabase(child, effectDatabase);
            scopedAdapters.set(relations, child);
            return child;
          };
          return await acquired.client.transaction(transactionOptions(config), async () => {
            entered = true;
            // The statement bound is the first statement in the transaction.
            await acquired.client.query("SELECT set_config('statement_timeout', $1, true)", [
              `${statementBoundMs(signal)}ms`,
            ]);
            signal?.throwIfAborted();
            const tx = new PostgresTransaction(
              dialect,
              new PostgresSession(client, dialect, options.relations, { logger }),
              options.relations,
              undefined,
              false,
            );
            rememberDatabaseAdapter(tx, options.relations, adapter);
            rememberEffectDatabase(tx, effectDatabase);
            scopedAdapters.set(options.relations, tx);
            state = "active";
            owner.active = true;
            try {
              const result = await invocation.run(owner, () => pinnedConnection.run(client, () => operation(tx)));
              signal?.throwIfAborted();
              return result;
            } finally {
              owner.active = false;
              state = "closed";
            }
          });
        } catch (cause) {
          // A connection whose BEGIN failed is in an unknown state.
          if (!entered) discard();
          throw cause;
        } finally {
          if (signal?.aborted) discard();
          if (discarded) await discarded;
          else acquired.release();
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
        // The abort race can settle before run() does. Drop the connection
        // before the caller's invocation scope closes.
        await discarded;
      }
    };
    return {
      db,
      pool,
      transaction,
      close: async () => {
        await Effect.runPromise(Scope.close(effectScope, Exit.void));
        await pool.end();
      },
    };
  } catch (cause) {
    await pool.end();
    throw cause;
  }
}
