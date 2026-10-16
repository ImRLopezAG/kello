import type pg from "pg";
import { quoteIdentifier } from "./connection";

/** Migration authority only. Caller must hold the migration lock and own the DDL transaction. */
export async function installRevisionTracking(
  client: pg.Client,
  namespace: string,
  metadataNamespace: string,
  tables: readonly string[],
): Promise<void> {
  const application = quoteIdentifier(namespace);
  const metadata = quoteIdentifier(metadataNamespace);
  if (namespace === metadataNamespace) throw new Error("Cannot track framework metadata as application tables");
  for (const name of [...new Set(tables)].sort()) {
    const table = quoteIdentifier(name);
    // Match the trigger DDL lock before touching the revision row, so a writer cannot hold
    // the table lock while waiting for a revision lock owned by this installer.
    await client.query(`LOCK TABLE ${application}.${table} IN ACCESS EXCLUSIVE MODE`);
    await client.query(
      `INSERT INTO ${metadata}.table_revisions (namespace, table_name, revision) VALUES ($1, $2, 1)
      ON CONFLICT (namespace, table_name) DO UPDATE SET revision = ${metadata}.table_revisions.revision + 1`,
      [namespace, name],
    );
    await client.query(`CREATE OR REPLACE TRIGGER loom_table_revision
      AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON ${application}.${table}
      FOR EACH STATEMENT EXECUTE FUNCTION ${metadata}.advance_table_revision()`);
  }
}
