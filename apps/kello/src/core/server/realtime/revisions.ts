import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as v from "valibot";
import { publishRuntimeMetric } from "../observability";

const identifier = v.pipe(v.string(), v.regex(/^[a-z][a-z0-9_]{0,62}$/));
const configuration = v.strictObject({
  namespace: identifier,
  metadataNamespace: v.pipe(identifier, v.regex(/^loom_/)),
  tables: v.pipe(v.array(identifier), v.minLength(1), v.maxLength(1000)),
});
export type RevisionReaderOptions = v.InferInput<typeof configuration>;
/** Decimal strings preserve PostgreSQL bigint values without JavaScript rounding. */
export type TableRevisions = Readonly<Record<string, string>>;
export type RevisionReader = (db: NodePgDatabase) => Promise<TableRevisions>;

/** Include all application and database-backed authorization tables in the generation's tracked set. */
export function createRevisionReader(options: RevisionReaderOptions): RevisionReader {
  const config = v.parse(configuration, structuredClone(options));
  if (config.namespace === config.metadataNamespace) throw new Error("Cannot subscribe to framework metadata");
  const tables = [...new Set(config.tables)].sort();
  return async (db) => {
    const started = performance.now();
    let succeeded = false;
    try {
      const result = await db.execute<{ table_name: string; revision: string }>(sql`
      SELECT table_name, revision::text AS revision
      FROM ${sql.identifier(config.metadataNamespace)}.table_revisions
      WHERE namespace = ${config.namespace} AND table_name IN ${tables}
      ORDER BY table_name
    `);
      if (result.rows.length !== tables.length) throw new Error("Missing tracked table revision");
      const revisions = Object.freeze(Object.fromEntries(result.rows.map((row) => [row.table_name, row.revision])));
      succeeded = true;
      return revisions;
    } finally {
      publishRuntimeMetric({
        type: "revision.read",
        status: succeeded ? "success" : "error",
        durationMs: performance.now() - started,
        tableCount: tables.length,
      });
    }
  };
}
