import * as v from "valibot";
import {
  acquireMigrationLock,
  assertMigrationConnection,
  databaseIdentifier,
  withMigrationConnection,
} from "./connection";
import { readMigrations } from "./history";
import { assessMigration } from "./assessment";
import type { MigrationAssessment } from "./assessment";
import { inspectHistory } from "./state";
import type { HistoryIssue } from "./state";
import type { FrameworkReadiness } from "./framework-history";
import type { MigrationSafety } from "./classifier";
import type pg from "pg";

const statusOptions = v.strictObject({
  connectionString: v.string(),
  root: v.string(),
  migrations: v.string(),
  namespace: databaseIdentifier,
  metadataNamespace: v.optional(v.pipe(databaseIdentifier, v.regex(/^loom_/)), "loom_meta"),
});
export type MigrationStatusOptions = v.InferInput<typeof statusOptions>;
const sessionOptions = v.omit(statusOptions, ["connectionString"]);
export type MigrationStatusOnConnectionOptions = v.InferInput<typeof sessionOptions>;
export interface DatabaseIdentity {
  database: string;
  role: string;
  address: string | null;
  port: number | null;
}
export async function databaseIdentity(client: pg.Client): Promise<DatabaseIdentity> {
  const result = await client.query<DatabaseIdentity>(
    "SELECT current_database() AS database, current_user AS role, inet_server_addr()::text AS address, inet_server_port() AS port",
  );
  const identity = result.rows[0];
  if (!identity) throw new Error("Missing database identity");
  return identity;
}
export interface MigrationStatus {
  readonly target: DatabaseIdentity;
  readonly namespace: string;
  readonly initialized: boolean;
  readonly framework: FrameworkReadiness;
  readonly consistent: boolean;
  readonly issues: readonly HistoryIssue[];
  readonly head: string | null;
  readonly committedHead: string | null;
  readonly applied: readonly string[];
  readonly pending: readonly {
    readonly name: string;
    readonly hash: string;
    readonly safety: MigrationSafety;
    readonly blockingGinOperations: MigrationAssessment["blockingGinOperations"];
    readonly blockingGinTimeout: MigrationAssessment["blockingGinTimeout"];
  }[];
  readonly catalog: { readonly expected: string | null; readonly actual: string };
}

export async function migrationStatus(options: MigrationStatusOptions): Promise<MigrationStatus> {
  const config = v.parse(statusOptions, options);
  const { connectionString, ...scope } = config;
  return withMigrationConnection(connectionString, (client) => migrationStatusOnConnection(client, scope));
}

/** Uses an owned dedicated connection; its shared migration lock lasts until that connection closes. */
export async function migrationStatusOnConnection(
  client: pg.Client,
  options: MigrationStatusOnConnectionOptions,
): Promise<MigrationStatus> {
  assertMigrationConnection(client);
  const config = v.parse(sessionOptions, options);
  await acquireMigrationLock(client, `loom:migrations:${config.namespace}`, true);
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    const artifacts = await readMigrations(config.root, config.migrations);
    const state = await inspectHistory(client, config, artifacts);
    const target = await databaseIdentity(client);
    const pending = await Promise.all(
      artifacts.slice(state.applied.length).map(async (artifact) => {
        const assessment = await assessMigration(artifact.plan);
        return {
          name: artifact.name,
          hash: assessment.artifactHash,
          safety: assessment.safety,
          blockingGinOperations: assessment.blockingGinOperations,
          blockingGinTimeout: assessment.blockingGinTimeout,
        };
      }),
    );
    await client.query("COMMIT");
    return {
      target,
      namespace: config.namespace,
      initialized: state.initialized,
      framework: state.framework,
      consistent: state.issues.length === 0,
      issues: state.issues,
      head: state.applied.at(-1)?.after_hash ?? null,
      committedHead: artifacts.at(-1)?.plan.after ?? null,
      applied: state.applied.map((row) => row.hash),
      pending,
      catalog: { expected: state.expectedCatalog, actual: state.actualCatalog },
    };
  } catch (cause) {
    await client.query("ROLLBACK");
    throw cause;
  }
}
