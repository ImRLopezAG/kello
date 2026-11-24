import { sql } from "drizzle-orm";
import type { Database } from "./database/types";

/** Call inside a transaction, before its first SELECT establishes the activation snapshot. */
export async function lockRuntimeActivation(database: Database, metadataNamespace: string): Promise<void> {
  await database.execute(
    sql`LOCK TABLE ${sql.identifier(metadataNamespace)}.deployment_activations IN ACCESS SHARE MODE NOWAIT`,
  );
}
