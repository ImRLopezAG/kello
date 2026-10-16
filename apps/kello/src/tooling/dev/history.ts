import type pg from "pg";
import * as v from "valibot";
import { quoteIdentifier } from "../migrations/connection";
import { planValidator, validateMigration } from "../migrations/history";
import { ormHistoryTable } from "../migrations/state";
import type { DevelopmentTarget } from "./target";

const hash = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/));
const historyValidator = v.array(
  v.object({
    ordinal: v.pipe(v.number(), v.integer(), v.minValue(1)),
    source_version: hash,
    project_id: v.string(),
    branch_id: v.string(),
    endpoint_id: v.string(),
    artifact_hash: hash,
    artifact: planValidator,
    before_catalog_hash: hash,
    after_catalog_hash: hash,
  }),
);

export function developmentOrmTable(namespace: string): string {
  return ormHistoryTable(`development:${namespace}`);
}

export async function readDevelopmentHistory(
  client: pg.Client,
  metadataNamespace: string,
  namespace: string,
  target: DevelopmentTarget,
) {
  const metadata = quoteIdentifier(metadataNamespace);
  const rows = v.parse(
    historyValidator,
    (
      await client.query(
        `SELECT ordinal, source_version, project_id, branch_id, endpoint_id, artifact_hash, artifact,
      before_catalog_hash, after_catalog_hash FROM ${metadata}.development_history WHERE namespace = $1 ORDER BY ordinal`,
        [namespace],
      )
    ).rows,
  );
  for (const [index, row] of rows.entries()) {
    await validateMigration(row.artifact);
    const previous = rows[index - 1];
    if (
      row.artifact.kind !== "generated" ||
      !row.artifact.safety.automatic ||
      !row.artifact.safety.transactional ||
      row.ordinal !== index + 1 ||
      row.artifact_hash !== row.artifact.hash ||
      row.artifact.parent !== (previous?.artifact_hash ?? null) ||
      (previous && row.before_catalog_hash !== previous.after_catalog_hash)
    )
      throw new Error("Development history is inconsistent");
    if (row.project_id !== target.projectId || row.branch_id !== target.branchId)
      throw new Error("Development history belongs to a different provider target");
  }
  const table = `${metadata}.${quoteIdentifier(developmentOrmTable(namespace))}`;
  const exists = await client.query<{ name: string | null }>("SELECT to_regclass($1)::text AS name", [table]);
  const recorded = exists.rows[0]?.name
    ? (await client.query<{ name: string; hash: string }>(`SELECT name, hash FROM ${table} ORDER BY id`)).rows
    : [];
  if (
    recorded.length !== rows.length ||
    recorded.some((row, index) => row.name !== `development_${index + 1}` || row.hash !== rows[index]?.artifact_hash)
  )
    throw new Error("Development ORM history is inconsistent");
  return rows;
}
