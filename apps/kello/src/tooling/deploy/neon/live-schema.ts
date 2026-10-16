import type pg from "pg";
import { migrationStatusOnConnection } from "../../migrations/status";
import { inspectReleaseSchema } from "../compatibility";
import type { ReleaseSchemaOptions, ReleaseSchemaInspection } from "../compatibility";
import { deploymentConnectionContext } from "./connection";
import type { DeploymentDatabaseIdentity } from "./connection";
import type { DeploymentTarget } from "./target";

export interface ReleaseDatabaseInspection extends ReleaseSchemaInspection {
  readonly target: DeploymentTarget;
  readonly database: DeploymentDatabaseIdentity;
  readonly namespace: string;
  readonly metadataNamespace: string;
  readonly catalogHash: string;
}

/** Observes the live target under the caller's deployment lock without changing its schema or grants. */
export async function inspectReleaseDatabase(
  client: pg.Client,
  root: string,
  input: ReleaseSchemaOptions,
): Promise<ReleaseDatabaseInspection> {
  const context = deploymentConnectionContext(client);
  const options = structuredClone(input);
  context.signal?.throwIfAborted();
  if (options.namespace !== context.namespace) throw new Error("Release namespace differs from the locked target");
  const schema = await inspectReleaseSchema(root, options);
  context.signal?.throwIfAborted();
  const status = await migrationStatusOnConnection(client, {
    root,
    migrations: options.migrations,
    namespace: context.namespace,
    metadataNamespace: context.metadataNamespace,
  });
  context.signal?.throwIfAborted();
  if (!status.consistent) throw new Error("Release database history or catalog is inconsistent");
  const head = status.head ?? (schema.migrationHashes.length === 0 ? schema.head : null);
  if (
    !status.initialized ||
    status.pending.length ||
    head !== schema.head ||
    JSON.stringify(status.applied) !== JSON.stringify(schema.migrationHashes)
  )
    throw new Error("Database is not at the release schema");
  return Object.freeze({
    ...schema,
    target: context.target,
    database: context.database,
    namespace: context.namespace,
    metadataNamespace: context.metadataNamespace,
    catalogHash: status.catalog.actual,
  });
}
