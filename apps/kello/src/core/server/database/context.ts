import type { AnyRelations } from "drizzle-orm";
import type { Database, EffectDatabase } from "./types";

type DatabaseAdapterFactory = <Relations extends AnyRelations>(relations: Relations) => Database<Relations>;
const adapters = new WeakMap<object, { readonly relations: AnyRelations; readonly factory: DatabaseAdapterFactory }>();

export function rememberDatabaseAdapter(
  database: Database,
  relations: AnyRelations,
  factory: DatabaseAdapterFactory,
): void {
  adapters.set(database, { relations, factory });
}

/** Rebind only databases whose transaction connection is owned by Kello. */
export function scopedDatabase<Relations extends AnyRelations>(
  database: Database,
  relations: Relations,
): Database<Relations> {
  const adapter = adapters.get(database);
  if (!adapter) throw new Error("Function relations do not match the active database");
  if (adapter.relations === relations) {
    // SAFETY: the exact relation graph was recorded when this adapter was built.
    return database as Database<Relations>;
  }
  return adapter.factory(relations);
}

type EffectDatabaseFactory = <Relations extends AnyRelations>(relations: Relations) => EffectDatabase<Relations>;
const effectDatabases = new WeakMap<object, EffectDatabaseFactory>();

export function rememberEffectDatabase(database: Database, factory: EffectDatabaseFactory): void {
  effectDatabases.set(database, factory);
}

/** The Effect database that runs on the same Kello-owned transaction as `database`, never the shared pool. */
export function scopedEffectDatabase<Relations extends AnyRelations>(
  database: Database,
  relations: Relations,
): EffectDatabase<Relations> {
  const factory = effectDatabases.get(database);
  if (!factory) throw new Error("Function relations do not match the active database");
  return factory(relations);
}
