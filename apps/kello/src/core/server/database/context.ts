import type { AnyRelations } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

type DatabaseAdapterFactory = <Relations extends AnyRelations>(relations: Relations) => NodePgDatabase<Relations>;
const adapters = new WeakMap<object, { readonly relations: AnyRelations; readonly factory: DatabaseAdapterFactory }>();

export function rememberDatabaseAdapter(
  database: NodePgDatabase,
  relations: AnyRelations,
  factory: DatabaseAdapterFactory,
): void {
  adapters.set(database, { relations, factory });
}

/** Rebind only databases whose transaction connection is owned by Kello. */
export function scopedDatabase<Relations extends AnyRelations>(
  database: NodePgDatabase,
  relations: Relations,
): NodePgDatabase<Relations> {
  const adapter = adapters.get(database);
  if (!adapter) throw new Error("Function relations do not match the active database");
  if (adapter.relations === relations) {
    // SAFETY: the exact relation graph was recorded when this adapter was built.
    return database as NodePgDatabase<Relations>;
  }
  return adapter.factory(relations);
}
