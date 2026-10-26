import type pg from "pg";
import * as v from "valibot";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/pg-core/async";
import { protectApplication } from "./application";
import { bootstrapSession } from "./bootstrap";
import {
  acquireMigrationLock,
  assertMigrationConnection,
  databaseIdentifier,
  quoteIdentifier,
  withMigrationConnection,
  withBlockingGinTimeout,
} from "./connection";
import { catalogFingerprint } from "./drift";
import { readMigrations } from "./history";
import { assessMigration } from "./assessment";
import { inspectHistory, ormHistoryTable } from "./state";
import { assertGeneratedVersion } from "../codegen/generate";
import { databaseIdentity } from "./status";
import type { DatabaseIdentity } from "./status";
import { assertRuntimeCompatibility } from "./runtime-compatibility";
import {
  concurrentIndexOperations,
  executeConcurrentIndexes,
  readConcurrentRecovery,
  verifyConcurrentBaseline,
} from "./nontransactional";

export const runnerOptions = v.strictObject({
  connectionString: v.string(),
  root: v.string(),
  migrations: v.string(),
  runtimeRole: databaseIdentifier,
  namespace: v.pipe(
    databaseIdentifier,
    v.check(
      (name) =>
        name !== "public" && name !== "information_schema" && !name.startsWith("pg_") && !name.startsWith("loom_"),
      "Application migrations require an isolated namespace",
    ),
  ),
  metadataNamespace: v.optional(v.pipe(databaseIdentifier, v.regex(/^loom_/)), "loom_meta"),
  sourceVersion: v.optional(v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/))),
  reviewedHashes: v.optional(v.array(v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/))), []),
  expectedHashes: v.optional(v.array(v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)))),
  recoverNontransactional: v.optional(v.boolean(), false),
  blockingGinTimeouts: v.optional(
    v.pipe(
      v.array(
        v.strictObject({
          artifactHash: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
          statementTimeoutMs: v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(900000)),
        }),
      ),
      v.check(
        (entries) => new Set(entries.map((entry) => entry.artifactHash)).size === entries.length,
        "Duplicate blocking GIN timeout artifact hash",
      ),
    ),
    [],
  ),
});
const connectionOptions = v.omit(runnerOptions, ["connectionString"]);
export type ApplyMigrationsOnConnectionOptions = v.InferInput<typeof connectionOptions>;
export type ApplyMigrationsOptions = v.InferInput<typeof runnerOptions>;
export interface MigrationReceipt {
  readonly target: DatabaseIdentity;
  readonly namespace: string;
  readonly applied: readonly string[];
  readonly head: string | null;
}

export async function applyMigrations(options: ApplyMigrationsOptions): Promise<MigrationReceipt> {
  const config = v.parse(runnerOptions, options);
  const { connectionString, ...migrationOptions } = config;
  return withMigrationConnection(connectionString, (client) => applyMigrationsOnConnection(client, migrationOptions));
}

/** Runs on a connection owned by Kello. The migration lock remains held until its owning callback ends. */
export async function applyMigrationsOnConnection(
  client: pg.Client,
  options: ApplyMigrationsOnConnectionOptions,
): Promise<MigrationReceipt> {
  assertMigrationConnection(client);
  const config = v.parse(connectionOptions, options);
  // Session lifetime bounds this lock, including failure paths and nested ORM transactions.
  await acquireMigrationLock(client, `loom:migrations:${config.namespace}`);
  if (config.sourceVersion) await assertGeneratedVersion(config.root, config.sourceVersion);
  const artifacts = await readMigrations(config.root, config.migrations);
  if (
    config.expectedHashes &&
    JSON.stringify(artifacts.map((artifact) => artifact.plan.hash)) !== JSON.stringify(config.expectedHashes)
  )
    throw new Error("Release migration history changed");
  for (const artifact of artifacts) {
    for (const snapshot of [artifact.plan.baseline, artifact.plan.snapshot]) {
      if (
        snapshot.ddl.some((entity) =>
          entity.entityType === "schemas"
            ? entity.name !== config.namespace
            : !("schema" in entity) || entity.schema !== config.namespace,
        )
      ) {
        throw new Error("Migration artifact escapes the selected application namespace");
      }
    }
  }
  let state = await inspectHistory(client, config, artifacts);
  const pending = artifacts.slice(state.applied.length);
  const assessments = new Map(
    await Promise.all(
      pending.map(async (artifact) => [artifact.plan.hash, await assessMigration(artifact.plan)] as const),
    ),
  );
  for (const entry of config.blockingGinTimeouts) {
    const assessment = assessments.get(entry.artifactHash);
    if (!assessment) throw new Error("Blocking GIN timeout requires a pending artifact hash");
    if (!config.reviewedHashes.includes(entry.artifactHash))
      throw new Error("Blocking GIN timeout requires exact artifact review");
    if (!assessment.blockingGinTimeout.eligible)
      throw new Error(`Blocking GIN timeout ineligible: ${assessment.blockingGinTimeout.reason}`);
  }
  for (const artifact of pending) {
    if (!assessments.get(artifact.plan.hash)!.safety.automatic && !config.reviewedHashes.includes(artifact.plan.hash))
      throw new Error(`Migration requires review of artifact ${artifact.plan.hash}`);
  }
  // An authenticated framework prefix cannot authorize repair of unrelated history.
  // Explicit concurrent recovery retains its existing, later journal/baseline validation.
  const recovering = config.recoverNontransactional && state.issues.includes("NONTRANSACTIONAL_IN_PROGRESS");
  if (state.issues.includes("BACKFILL_IN_PROGRESS"))
    throw new Error("Complete running backfills before applying further migrations");
  if ((!recovering && state.issues.includes("LIVE_DRIFT")) || state.issues.includes("UNTRACKED_NAMESPACE"))
    throw new Error("Live database drift detected; migration stopped");
  if (
    state.issues.some(
      (issue) =>
        issue !== "FRAMEWORK_UPGRADE_REQUIRED" &&
        !(recovering && (issue === "LIVE_DRIFT" || issue === "NONTRANSACTIONAL_IN_PROGRESS")),
    )
  )
    throw new Error("Applied migration history differs from committed artifacts or ORM history");
  await bootstrapSession(client, config.metadataNamespace, config.runtimeRole);
  state = await inspectHistory(client, config, artifacts);
  if (state.framework.state !== "current") throw new Error("Framework metadata is not current after bootstrap");
  const metadata = quoteIdentifier(config.metadataNamespace);
  if (state.issues.includes("BACKFILL_IN_PROGRESS"))
    throw new Error("Complete running backfills before applying further migrations");
  const recovery = await readConcurrentRecovery(client, config);
  for (const artifact of artifacts.slice(state.applied.length)) {
    if (!assessments.get(artifact.plan.hash)!.safety.transactional) {
      if (!config.recoverNontransactional)
        throw new Error("Nontransactional migration requires explicit recovery mode");
      await concurrentIndexOperations(artifact, config.namespace);
    }
  }
  if (recovery) {
    const pending = artifacts[state.applied.length];
    if (!config.recoverNontransactional || !pending || !state.expectedCatalog)
      throw new Error("Concurrent migration requires explicit recovery of its pending artifact");
    await verifyConcurrentBaseline(client, config, pending, state.expectedCatalog, state.applied.length + 1);
  }
  if ((!recovery && state.issues.includes("LIVE_DRIFT")) || state.issues.includes("UNTRACKED_NAMESPACE"))
    throw new Error("Live database drift detected; migration stopped");
  if (state.issues.some((issue) => !(recovery && (issue === "LIVE_DRIFT" || issue === "NONTRANSACTIONAL_IN_PROGRESS"))))
    throw new Error("Applied migration history differs from committed artifacts or ORM history");
  const drizzleTable = ormHistoryTable(config.namespace);
  await assertRuntimeCompatibility(
    client,
    config,
    artifacts.map((artifact) => artifact.plan.hash),
    state.applied.length,
  );
  const applied: string[] = [];
  const db = drizzle({ client });
  let expectedCatalog = state.expectedCatalog;
  for (const [index, artifact] of artifacts.entries()) {
    if (index < state.applied.length) continue;
    if (!assessments.get(artifact.plan.hash)!.safety.transactional) {
      if (!expectedCatalog) throw new Error("Concurrent recovery requires an applied structural baseline");
      await executeConcurrentIndexes(client, config, artifact, expectedCatalog, index + 1);
    }
    let migrationFailure: { error: unknown } | undefined;
    try {
      await db.transaction(async (tx) => {
        try {
          // The exported ORM migrator nests a savepoint within this outer transaction.
          const nativeMigration = async () => {
            const originalTransaction = tx.transaction.bind(tx);
            // Capture the callback error before pinned Drizzle attempts savepoint rollback.
            // This transaction instance belongs only to this native call.
            tx.transaction = async (operation) =>
              originalTransaction(async (nested) => {
                try {
                  return await operation(nested);
                } catch (error) {
                  migrationFailure ??= { error };
                  throw error;
                }
              });
            try {
              await migrate(
                [
                  {
                    sql: assessments.get(artifact.plan.hash)!.safety.transactional ? [...artifact.plan.statements] : [],
                    folderMillis: index + 1,
                    hash: artifact.plan.hash,
                    bps: true,
                    name: artifact.name,
                  },
                ],
                tx,
                {
                  migrationsFolder: config.migrations,
                  migrationsSchema: config.metadataNamespace,
                  migrationsTable: drizzleTable,
                },
              );
            } catch (error) {
              migrationFailure ??= { error };
              throw error;
            } finally {
              tx.transaction = originalTransaction;
            }
          };
          const timeout = config.blockingGinTimeouts.find((entry) => entry.artifactHash === artifact.plan.hash);
          if (timeout) await withBlockingGinTimeout(client, timeout.statementTimeoutMs, nativeMigration);
          else await nativeMigration();
          const tables = artifact.plan.snapshot.ddl
            .filter((entity) => entity.entityType === "tables")
            .map((entity) => entity.name)
            .filter((table) =>
              ["_id", "_createdAt"].every((name) =>
                artifact.plan.snapshot.ddl.some(
                  (entity) => entity.entityType === "columns" && entity.table === table && entity.name === name,
                ),
              ),
            );
          await protectApplication(client, config.namespace, config.runtimeRole, tables, config.metadataNamespace);
          const catalogHash = await catalogFingerprint(client, config.namespace);
          await client.query(
            `INSERT INTO ${metadata}.migration_history (namespace, ordinal, name, hash, before_hash, after_hash, catalog_hash) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [
              config.namespace,
              index + 1,
              artifact.name,
              artifact.plan.hash,
              artifact.plan.before,
              artifact.plan.after,
              catalogHash,
            ],
          );
          if (!assessments.get(artifact.plan.hash)!.safety.transactional) {
            const removed = await client.query(
              `DELETE FROM ${metadata}.nontransactional_migrations WHERE namespace=$1 AND hash=$2`,
              [config.namespace, artifact.plan.hash],
            );
            if (removed.rowCount !== 1) throw new Error("Concurrent migration journal changed before completion");
          }
          expectedCatalog = catalogHash;
        } catch (error) {
          migrationFailure ??= { error };
          throw error;
        }
      });
    } catch (error) {
      throw migrationFailure ? migrationFailure.error : error;
    }
    applied.push(artifact.plan.hash);
  }
  return {
    target: await databaseIdentity(client),
    namespace: config.namespace,
    applied,
    head: artifacts.at(-1)?.plan.after ?? null,
  };
}
