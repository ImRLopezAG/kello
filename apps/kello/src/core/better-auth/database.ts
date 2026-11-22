import type { BetterAuthOptions } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import type { Database } from "../server/database/types";
import { compileBetterAuthSchema } from "./schema";

/** The native adapter receives exactly the tables supplied to Kello migrations. No DDL runs here. */
export function createBetterAuthDatabase(database: Database, namespace: string) {
  return (options: BetterAuthOptions) => {
    const schema = compileBetterAuthSchema(options, namespace);
    return drizzleAdapter(database, { provider: "pg", schema: schema.tables, transaction: true })(options);
  };
}
