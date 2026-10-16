import type { BetterAuthOptions } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { compileBetterAuthSchema } from "./schema";

/** The native adapter receives exactly the tables supplied to Kello migrations. No DDL runs here. */
export function createBetterAuthDatabase(database: NodePgDatabase, namespace: string) {
  return (options: BetterAuthOptions) => {
    const schema = compileBetterAuthSchema(options, namespace);
    return drizzleAdapter(database, { provider: "pg", schema: schema.tables, transaction: true })(options);
  };
}
