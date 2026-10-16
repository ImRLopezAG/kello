import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

/** Call inside a transaction, before its first SELECT establishes the activation snapshot. */
export async function lockRuntimeActivation(database: NodePgDatabase, metadataNamespace: string): Promise<void> {
  await database.execute(
    sql`LOCK TABLE ${sql.identifier(metadataNamespace)}.deployment_activations IN ACCESS SHARE MODE NOWAIT`,
  );
}
