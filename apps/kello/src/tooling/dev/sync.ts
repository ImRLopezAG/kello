import { projectMigrationScopes, reconcileComponentNamespaces } from "../migrations/component-scopes";
import { assertExternalAuthTables, writeAuthOwnership } from "../migrations/auth-scopes";
import { acquireMigrationLock, databaseIdentifier, quoteIdentifier } from "../migrations/connection";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/pg-core/async";
import * as v from "valibot";
import { loadProject } from "../project/load";
import { prepareProject, assertGeneratedVersion } from "../codegen/generate";
import { bootstrapSession } from "../migrations/bootstrap";
import { catalogFingerprint } from "../migrations/drift";
import { inspectSnapshot } from "../migrations/adapter";
import { planMigration } from "../migrations/planner";
import { assessMigration } from "../migrations/assessment";
import type { MigrationAssessment } from "../migrations/assessment";
import type { MigrationPlan } from "../migrations/planner";
import { readMigrations } from "../migrations/history";
import { inspectHistory } from "../migrations/state";
import { protectApplication } from "../migrations/application";
import { withDevelopmentConnection } from "./connection";
import type { DevelopmentDatabaseProvider } from "./connection";
import type { DevelopmentTarget } from "./target";
import { readDevelopmentHistory, developmentOrmTable } from "./history";

export interface DevelopmentSyncOptions {
  readonly root: string;
  readonly sourceVersion: string;
  readonly databaseName: string;
  readonly migrationRole: string;
  readonly runtimeRole: string;
  readonly signal?: AbortSignal;
}
export interface DevelopmentSyncReceipt {
  readonly target: DevelopmentTarget;
  readonly sourceVersion: string;
  readonly applied: boolean;
  readonly artifactHash: string;
  readonly catalogHash: string;
}
export class DevelopmentReviewRequired extends Error {
  constructor(
    readonly plan: MigrationPlan,
    readonly assessment?: MigrationAssessment,
  ) {
    super("Development schema change requires migration review");
  }
}

export async function synchronizeDevelopment(
  options: DevelopmentSyncOptions,
  provider?: DevelopmentDatabaseProvider,
): Promise<DevelopmentSyncReceipt> {
  const runtimeRole = v.parse(databaseIdentifier, options.runtimeRole);
  const candidate = await prepareProject(options.root);
  if (candidate.version !== options.sourceVersion) throw new Error("Development candidate is stale");
  const project = await loadProject(options.root);
  if (project.version !== candidate.version) throw new Error("Development candidate is stale");
  const { metadataNamespace } = project.config.database;
  const scopes = projectMigrationScopes(project);
  const applicationScope = scopes.find((scope) => scope.mountPath === "");
  if (!applicationScope) throw new Error("Missing application migration scope");
  return withDevelopmentConnection(
    { ...options, config: project.config },
    async (client, target) => {
      await assertGeneratedVersion(options.root, options.sourceVersion);
      options.signal?.throwIfAborted();
      await acquireMigrationLock(client, "loom:component-ownership");
      for (const scope of scopes) await acquireMigrationLock(client, `loom:migrations:${scope.namespace}`);
      await assertExternalAuthTables(client, project);
      const artifactsByNamespace = new Map<string, Awaited<ReturnType<typeof readMigrations>>>();
      const developmentHistoryExists = await client.query<{ present: boolean }>(
        "SELECT to_regclass($1) IS NOT NULL AS present",
        [`${quoteIdentifier(metadataNamespace)}.development_history`],
      );
      for (const scope of scopes) {
        const history = developmentHistoryExists.rows[0]?.present
          ? await readDevelopmentHistory(client, metadataNamespace, scope.namespace, target)
          : [];
        const artifacts = await readMigrations(options.root, scope.migrations);
        const release = await inspectHistory(client, { namespace: scope.namespace, metadataNamespace }, artifacts);
        if (release.framework.state === "diverged") throw new Error("Framework migration history is inconsistent");
        if (
          !history.length &&
          release.issues.some((issue) => issue === "HISTORY_DIVERGED" || issue === "ORM_HISTORY_DIVERGED")
        )
          throw new Error("Cannot start development sync from inconsistent release or ORM history");
        artifactsByNamespace.set(scope.namespace, artifacts);
      }
      const applicationArtifacts = artifactsByNamespace.get(applicationScope.namespace);
      if (!applicationArtifacts) throw new Error("Missing application development baseline");
      await bootstrapSession(client, metadataNamespace, runtimeRole);
      // A genuine old prefix is upgraded by bootstrap; never read feature columns until it is current.
      const currentApplication = await inspectHistory(
        client,
        { namespace: applicationScope.namespace, metadataNamespace },
        applicationArtifacts,
      );
      if (currentApplication.framework.state !== "current")
        throw new Error("Framework metadata is not current after bootstrap");
      await reconcileComponentNamespaces(client, metadataNamespace, scopes);
      const db = drizzle({ client });
      return db.transaction(async (tx) => {
        const receipts: DevelopmentSyncReceipt[] = [];
        for (const scope of scopes) {
          const { namespace, migrations, schema } = scope;
          const history = await readDevelopmentHistory(client, metadataNamespace, namespace, target);
          const last = history.at(-1);
          const beforeCatalog = await catalogFingerprint(client, namespace);
          if (last && last.after_catalog_hash !== beforeCatalog)
            throw new Error("Live development database drift detected");
          if (!last) {
            const release = await inspectHistory(
              client,
              { namespace, metadataNamespace },
              await readMigrations(options.root, migrations),
            );
            if (release.issues.length)
              throw new Error("Cannot start development sync from untracked database state or drift");
          }
          const before = await inspectSnapshot(tx, namespace);
          const plan = await planMigration(before, schema, [], last?.artifact_hash ?? null);
          await writeAuthOwnership(project, scope.mountPath, scope.migrations, plan.snapshot);
          await assertGeneratedVersion(options.root, options.sourceVersion);
          options.signal?.throwIfAborted();
          const assessment = await assessMigration(plan);
          if (!assessment.safety.automatic || !assessment.safety.transactional)
            throw new DevelopmentReviewRequired(plan, assessment);
          if (last?.source_version === options.sourceVersion && !plan.statements.length) {
            receipts.push({
              target,
              sourceVersion: options.sourceVersion,
              applied: false,
              artifactHash: last.artifact_hash,
              catalogHash: beforeCatalog,
            });
            continue;
          }
          const ordinal = history.length + 1;
          await migrate(
            [
              {
                sql: [...plan.statements],
                folderMillis: ordinal,
                hash: plan.hash,
                bps: true,
                name: `development_${ordinal}`,
              },
            ],
            tx,
            {
              migrationsFolder: migrations,
              migrationsSchema: metadataNamespace,
              migrationsTable: developmentOrmTable(namespace),
            },
          );
          await protectApplication(client, namespace, runtimeRole, scope.entityTables, metadataNamespace);
          const catalogHash = await catalogFingerprint(client, namespace);
          await client.query(
            `INSERT INTO ${quoteIdentifier(metadataNamespace)}.development_history
        (namespace, ordinal, source_version, project_id, branch_id, endpoint_id, artifact_hash, artifact, before_catalog_hash, after_catalog_hash)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [
              namespace,
              ordinal,
              options.sourceVersion,
              target.projectId,
              target.branchId,
              target.endpointId,
              plan.hash,
              JSON.stringify(plan),
              beforeCatalog,
              catalogHash,
            ],
          );
          await assertGeneratedVersion(options.root, options.sourceVersion);
          options.signal?.throwIfAborted();
          receipts.push({
            target,
            sourceVersion: options.sourceVersion,
            applied: true,
            artifactHash: plan.hash,
            catalogHash,
          });
        }
        const application = receipts[scopes.findIndex((scope) => scope.mountPath === "")];
        if (!application) throw new Error("Missing application development receipt");
        return { ...application, applied: receipts.some((receipt) => receipt.applied) };
      });
    },
    provider,
  );
}
