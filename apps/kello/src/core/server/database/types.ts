import type { AnyRelations } from "drizzle-orm";
import type { PostgresQueryResultHKT, PostgresTransaction } from "drizzle-orm/postgres";
import type { EffectPostgresDatabase } from "drizzle-orm/postgres/effect";
import type { PgAsyncDatabase } from "drizzle-orm/pg-core/async";

/** The database handle Kello passes to application code: the root database or a transaction. */
export type Database<Relations extends AnyRelations = AnyRelations> = PgAsyncDatabase<
  PostgresQueryResultHKT,
  Relations
>;
export type DatabaseTransaction<Relations extends AnyRelations> = PostgresTransaction<Relations>;
/** The Effect form of {@link Database}. Inside a function it runs on the invocation's transaction. */
export type EffectDatabase<Relations extends AnyRelations = AnyRelations> = EffectPostgresDatabase<Relations>;
