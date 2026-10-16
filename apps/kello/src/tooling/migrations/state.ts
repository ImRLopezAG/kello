import { createHash } from "node:crypto";
import type pg from "pg";
import type { MigrationArtifact } from "./history";
import { quoteIdentifier } from "./connection";
import { catalogFingerprint } from "./drift";
import { frameworkMigrations } from "./bootstrap";
import { classifyFrameworkHistory } from "./framework-history";
import type { FrameworkReadiness } from "./framework-history";

export interface HistoryScope {
  readonly namespace: string;
  readonly metadataNamespace: string;
}
export interface AppliedMigration {
  ordinal: number;
  name: string;
  hash: string;
  before_hash: string;
  after_hash: string;
  catalog_hash: string;
}
export type HistoryIssue =
  | "HISTORY_DIVERGED"
  | "LIVE_DRIFT"
  | "NONTRANSACTIONAL_IN_PROGRESS"
  | "BACKFILL_IN_PROGRESS"
  | "UNTRACKED_NAMESPACE"
  | "ORM_HISTORY_DIVERGED"
  | "FRAMEWORK_HISTORY_DIVERGED"
  | "FRAMEWORK_UPGRADE_REQUIRED";
export interface HistoryState {
  readonly initialized: boolean;
  readonly framework: FrameworkReadiness;
  readonly applied: readonly AppliedMigration[];
  readonly issues: readonly HistoryIssue[];
  readonly expectedCatalog: string | null;
  readonly actualCatalog: string;
}
export function ormHistoryTable(namespace: string): string {
  return `drizzle_${createHash("sha256").update(namespace).digest("hex").slice(0, 48)}`;
}
async function relationExists(client: pg.Client, name: string): Promise<boolean> {
  const result = await client.query<{ relation: string | null }>("SELECT to_regclass($1)::text AS relation", [name]);
  return result.rows[0]?.relation != null;
}

export async function inspectHistory(
  client: pg.Client,
  scope: HistoryScope,
  artifacts: readonly MigrationArtifact[],
): Promise<HistoryState> {
  const metadata = quoteIdentifier(scope.metadataNamespace);
  const initialized = await relationExists(client, `${metadata}.migration_history`);
  const history = initialized
    ? (
        await client.query<AppliedMigration>(
          `SELECT ordinal, name, hash, before_hash, after_hash, catalog_hash FROM ${metadata}.migration_history WHERE namespace = $1 ORDER BY ordinal`,
          [scope.namespace],
        )
      ).rows
    : [];
  const issues: HistoryIssue[] = [];
  if (artifacts.length > history.length && (await relationExists(client, `${metadata}.backfills`))) {
    const pending = await client.query(
      `SELECT 1 FROM ${metadata}.backfills WHERE namespace=$1 AND state='running' LIMIT 1`,
      [scope.namespace],
    );
    if (pending.rows.length) issues.push("BACKFILL_IN_PROGRESS");
  }
  if (await relationExists(client, `${metadata}.nontransactional_migrations`)) {
    const recovery = await client.query(`SELECT 1 FROM ${metadata}.nontransactional_migrations WHERE namespace = $1`, [
      scope.namespace,
    ]);
    if (recovery.rows.length) issues.push("NONTRANSACTIONAL_IN_PROGRESS");
  }
  const frameworkHistoryExists = await relationExists(client, `${metadata}.framework_migrations`);
  const versions = frameworkHistoryExists
    ? (
        await client.query<{ version: number; hash: string }>(
          `SELECT version, hash FROM ${metadata}.framework_migrations ORDER BY version`,
        )
      ).rows
    : [];
  const namespace = await client.query("SELECT 1 FROM pg_namespace WHERE nspname = $1", [scope.metadataNamespace]);
  const framework = classifyFrameworkHistory({
    metadataExists: namespace.rows.length > 0,
    frameworkHistoryExists,
    migrationHistoryExists: initialized,
    applied: versions,
    expected: frameworkMigrations(scope.metadataNamespace),
  });
  if (framework.state === "diverged") issues.push("FRAMEWORK_HISTORY_DIVERGED");
  if (framework.state === "upgrade-required") issues.push("FRAMEWORK_UPGRADE_REQUIRED");
  if (
    history.some((applied, index) => {
      const artifact = artifacts[index];
      return (
        !artifact ||
        applied.ordinal !== index + 1 ||
        artifact.name !== applied.name ||
        artifact.plan.hash !== applied.hash ||
        artifact.plan.before !== applied.before_hash ||
        artifact.plan.after !== applied.after_hash
      );
    })
  )
    issues.push("HISTORY_DIVERGED");
  const last = history.at(-1);
  const actualCatalog = await catalogFingerprint(client, scope.namespace);
  if (last) {
    if (actualCatalog !== last.catalog_hash) issues.push("LIVE_DRIFT");
  } else {
    const existing = await client.query("SELECT 1 FROM pg_namespace WHERE nspname = $1", [scope.namespace]);
    if (existing.rows.length) issues.push("UNTRACKED_NAMESPACE");
  }
  const drizzleName = `${metadata}.${quoteIdentifier(ormHistoryTable(scope.namespace))}`;
  if (await relationExists(client, drizzleName)) {
    const recorded = await client.query<{ name: string; hash: string }>(
      `SELECT name, hash FROM ${drizzleName} ORDER BY id`,
    );
    if (
      recorded.rows.length !== history.length ||
      recorded.rows.some((row, index) => row.name !== history[index]?.name || row.hash !== history[index]?.hash)
    )
      issues.push("ORM_HISTORY_DIVERGED");
  } else if (history.length) issues.push("ORM_HISTORY_DIVERGED");
  return {
    initialized,
    framework,
    applied: history,
    issues,
    expectedCatalog: last?.catalog_hash ?? null,
    actualCatalog,
  };
}
