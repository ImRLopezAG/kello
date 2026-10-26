import type pg from "pg";
import * as v from "valibot";
import { assertMigrationConnection, quoteIdentifier } from "./connection";
import type { ReleaseSchemaInspection } from "../deploy/compatibility";

interface Scope {
  readonly namespace: string;
  readonly metadataNamespace: string;
}
interface RuntimeCompatibility extends Scope {
  readonly deployment: string;
  readonly version: string;
  readonly sourceSchema: string;
  readonly inspection: ReleaseSchemaInspection;
}
const hashes = v.array(v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)));
export class RuntimeCompatibilityError extends Error {
  constructor() {
    super("Active runtime, queued job or client session lacks compatibility with the pending migration range");
  }
}

/** Called only after the release source and declared range have been validated under deployment ownership. */
export async function recordRuntimeCompatibility(client: pg.Client, options: RuntimeCompatibility): Promise<void> {
  assertMigrationConnection(client);
  if (!options.inspection.schemas.includes(options.sourceSchema))
    throw new Error("Runtime schema range excludes its source");
  const meta = quoteIdentifier(options.metadataNamespace);
  const current = await client.query<{ ordinal: number; active: boolean }>(
    `SELECT COALESCE((SELECT max(ordinal) FROM ${meta}.migration_history WHERE namespace=$1),0) AS ordinal,
      EXISTS (SELECT 1 FROM ${meta}.deployment_activations WHERE deployment=$2 AND version=$3 AND state='active') AS active`,
    [options.namespace, options.deployment, options.version],
  );
  const observed = current.rows[0];
  if (
    !observed ||
    (observed.active &&
      (observed.ordinal < options.inspection.minimumOrdinal || observed.ordinal > options.inspection.maximumOrdinal))
  )
    throw new Error("Active runtime compatibility must include the current database");
  const existing = await client.query<{ source_schema: string; migration_hashes: string[] }>(
    `SELECT source_schema,migration_hashes FROM ${meta}.runtime_compatibility WHERE namespace=$1 AND deployment=$2 AND version=$3`,
    [options.namespace, options.deployment, options.version],
  );
  const previous = existing.rows[0];
  if (
    previous &&
    (previous.source_schema !== options.sourceSchema ||
      v
        .parse(hashes, previous.migration_hashes)
        .some((hash, index) => hash !== options.inspection.migrationHashes[index]))
  )
    throw new Error("Runtime compatibility history changed");
  await client.query(
    `INSERT INTO ${meta}.runtime_scopes(deployment,version,namespace) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
    [options.deployment, options.version, options.namespace],
  );
  await client.query(
    `INSERT INTO ${meta}.runtime_compatibility(namespace,deployment,version,source_schema,minimum_ordinal,maximum_ordinal,migration_hashes)
      VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)
      ON CONFLICT(namespace,deployment,version) DO UPDATE SET minimum_ordinal=EXCLUDED.minimum_ordinal, maximum_ordinal=EXCLUDED.maximum_ordinal, migration_hashes=EXCLUDED.migration_hashes`,
    [
      options.namespace,
      options.deployment,
      options.version,
      options.sourceSchema,
      options.inspection.minimumOrdinal,
      options.inspection.maximumOrdinal,
      JSON.stringify(options.inspection.migrationHashes),
    ],
  );
}

/** Check declared dependencies from active grants, queued/running jobs and unexpired client sessions. */
export async function assertRuntimeCompatibility(
  client: pg.Client,
  scope: Scope,
  migrationHashes: readonly string[],
  appliedCount: number,
  proposed?: Pick<RuntimeCompatibility, "deployment" | "version" | "inspection">,
): Promise<void> {
  assertMigrationConnection(client);
  if (appliedCount === migrationHashes.length) return;
  const meta = quoteIdentifier(scope.metadataNamespace);
  const dependencies = await client.query<{
    deployment: string;
    version: string | null;
    active: boolean;
    minimum_ordinal: number | null;
    maximum_ordinal: number | null;
    migration_hashes: string[] | null;
  }>(
    `WITH dependencies AS (
      SELECT deployment,version,true AS active FROM ${meta}.deployment_activations WHERE state='active'
      UNION ALL SELECT deployment,COALESCE(claim_version,call->>'version'),false FROM ${meta}.jobs WHERE state IN ('pending','running')
      UNION ALL SELECT deployment,version,true FROM ${meta}.client_sessions cs WHERE expires_at>clock_timestamp() AND (namespace=$1 OR EXISTS (SELECT 1 FROM ${meta}.runtime_scopes s WHERE s.namespace=$1 AND s.deployment=cs.deployment AND s.version=cs.version))
    ), grouped AS (SELECT deployment,version,bool_or(active) AS active FROM dependencies GROUP BY deployment,version)
    SELECT d.deployment,d.version,d.active,c.minimum_ordinal,c.maximum_ordinal,c.migration_hashes FROM grouped d
      LEFT JOIN ${meta}.runtime_compatibility c ON c.namespace=$1 AND c.deployment=d.deployment AND c.version=d.version
      WHERE NOT EXISTS (SELECT 1 FROM ${meta}.component_namespaces n WHERE n.namespace=$1)
        OR EXISTS (SELECT 1 FROM ${meta}.runtime_scopes s WHERE s.namespace=$1 AND s.deployment=d.deployment AND s.version=d.version)`,
    [scope.namespace],
  );
  const expectedHashes = JSON.stringify(migrationHashes);
  for (const dependency of dependencies.rows) {
    const proof =
      proposed && dependency.deployment === proposed.deployment && dependency.version === proposed.version
        ? {
            minimum_ordinal: proposed.inspection.minimumOrdinal,
            maximum_ordinal: proposed.inspection.maximumOrdinal,
            migration_hashes: proposed.inspection.migrationHashes,
          }
        : dependency;
    if (
      !dependency.version ||
      proof.minimum_ordinal === null ||
      proof.maximum_ordinal === null ||
      proof.minimum_ordinal > (dependency.active ? appliedCount : appliedCount + 1) ||
      proof.maximum_ordinal < migrationHashes.length ||
      !proof.migration_hashes ||
      JSON.stringify(v.parse(hashes, proof.migration_hashes)) !== expectedHashes
    )
      throw new RuntimeCompatibilityError();
  }
}
