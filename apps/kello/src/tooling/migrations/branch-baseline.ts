import { createHash } from "node:crypto";
import type pg from "pg";
import { acquireMigrationLock, assertMigrationConnection, quoteIdentifier } from "./connection";
import { catalogFingerprint } from "./drift";
import { frameworkMigrations } from "./bootstrap";
import { inspectHistory, ormHistoryTable } from "./state";
import type { AppliedMigration, HistoryScope } from "./state";
import type { MigrationArtifact } from "./history";

interface SchemaBaseline {
  readonly initialized: boolean;
  readonly scope: HistoryScope;
  readonly applicationCatalog: string;
  readonly metadataCatalog: string;
  readonly migrations: readonly AppliedMigration[];
  readonly fingerprint: string;
}
// A baseline is usable only while its source's owned session still holds the locks.
const sources = new WeakMap<SchemaBaseline, pg.Client>();

async function snapshot(client: pg.Client, scope: HistoryScope, artifacts: readonly MigrationArtifact[]) {
  const state = await inspectHistory(client, scope, artifacts);
  if (state.issues.length || (state.initialized && !state.applied.length))
    throw new Error("Schema baseline requires consistent, applied source migrations");
  // pg_dump can represent an explicit owner-only table ACL as the identical default ACL.
  const metadataCatalog = await catalogFingerprint(client, scope.metadataNamespace, [], "schema-copy");
  const value = {
    initialized: state.initialized,
    scope,
    applicationCatalog: state.actualCatalog,
    metadataCatalog,
    migrations: state.applied,
  };
  return { ...value, fingerprint: createHash("sha256").update(JSON.stringify(value)).digest("hex") };
}

/** Capture before branch creation. Keep this callback's owned source connection open until adoption finishes. */
export async function captureSchemaBaseline(
  source: pg.Client,
  scope: HistoryScope,
  artifacts: readonly MigrationArtifact[],
): Promise<SchemaBaseline> {
  assertMigrationConnection(source);
  quoteIdentifier(scope.namespace);
  quoteIdentifier(scope.metadataNamespace);
  if (scope.namespace === scope.metadataNamespace) throw new Error("Baseline namespaces must differ");
  await acquireMigrationLock(source, "loom:component-ownership");
  await acquireMigrationLock(source, `loom:migrations:${scope.namespace}`);
  await acquireMigrationLock(source, "loom:bootstrap");
  const baseline = await snapshot(source, Object.freeze({ ...scope }), artifacts);
  for (const migration of baseline.migrations) Object.freeze(migration);
  Object.freeze(baseline.migrations);
  Object.freeze(baseline);
  sources.set(baseline, source);
  return baseline;
}

/** Adopt all scopes in one transaction: metadata is shared, so per-scope emptiness checks are unsafe. */
export async function establishSchemaBaselines(
  source: pg.Client,
  target: pg.Client,
  entries: readonly { readonly baseline: SchemaBaseline; readonly artifacts: readonly MigrationArtifact[] }[],
  ownership: readonly { readonly mount_path: string; readonly namespace: string; readonly state: string }[] = [],
): Promise<void> {
  assertMigrationConnection(source);
  assertMigrationConnection(target);
  const first = entries[0];
  if (!first || source === target) throw new Error("Missing or invalid baseline source");
  const metadataNamespace = first.baseline.scope.metadataNamespace;
  const metadata = quoteIdentifier(metadataNamespace);
  await acquireMigrationLock(target, "loom:component-ownership");
  const sorted = [...entries].sort((a, b) => a.baseline.scope.namespace.localeCompare(b.baseline.scope.namespace));
  for (const { baseline } of sorted) {
    if (sources.get(baseline) !== source || baseline.scope.metadataNamespace !== metadataNamespace)
      throw new Error("Baseline source session changed");
    await acquireMigrationLock(target, `loom:migrations:${baseline.scope.namespace}`);
  }
  await acquireMigrationLock(target, "loom:bootstrap");
  async function verifySource() {
    const ledger = await source.query<{ present: boolean }>("SELECT to_regclass($1) IS NOT NULL AS present", [
      `${metadata}.component_namespaces`,
    ]);
    const observed = ledger.rows[0]?.present
      ? (
          await source.query<{ mount_path: string; namespace: string; state: string }>(
            `SELECT mount_path,namespace,state FROM ${metadata}.component_namespaces ORDER BY mount_path`,
          )
        ).rows
      : [];
    if (
      JSON.stringify(observed) !== JSON.stringify(ownership) ||
      observed.some((row) => !sorted.some(({ baseline }) => baseline.scope.namespace === row.namespace))
    )
      throw new Error("Source component ownership differs from baseline scopes");
    for (const { baseline, artifacts } of sorted)
      if ((await snapshot(source, baseline.scope, artifacts)).fingerprint !== baseline.fingerprint)
        throw new Error("Source schema changed during branch provisioning");
  }
  await verifySource();
  await target.query("BEGIN");
  try {
    const tables = await target.query<{ name: string }>(
      "SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind IN ('r','p') ORDER BY c.relname",
      [metadataNamespace],
    );
    for (const { name } of tables.rows)
      await target.query(`LOCK TABLE ${metadata}.${quoteIdentifier(name)} IN ACCESS EXCLUSIVE MODE`);
    if ((await catalogFingerprint(target, metadataNamespace, [], "schema-copy")) !== first.baseline.metadataCatalog)
      throw new Error("Copied branch catalog differs from its source baseline");
    for (const { baseline } of sorted)
      if ((await catalogFingerprint(target, baseline.scope.namespace)) !== baseline.applicationCatalog)
        throw new Error("Copied branch catalog differs from its source baseline");
    const allowed = new Set([
      "framework_migrations",
      "migration_history",
      "table_revisions",
      "component_namespaces",
      ...sorted.map(({ baseline }) => ormHistoryTable(baseline.scope.namespace)),
    ]);
    for (const { name } of tables.rows) {
      if (allowed.has(name)) continue;
      if ((await target.query(`SELECT 1 FROM ${metadata}.${quoteIdentifier(name)} LIMIT 1`)).rowCount)
        throw new Error("Schema baseline refuses inherited runtime records");
    }
    const initialized = sorted.some(({ baseline }) => baseline.initialized);
    if (initialized) {
      const history = await target.query(`SELECT 1 FROM ${metadata}.migration_history LIMIT 1`);
      if (history.rowCount) {
        const count = await target.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM ${metadata}.migration_history`,
        );
        if (count.rows[0]?.count !== sorted.reduce((total, { baseline }) => total + baseline.migrations.length, 0))
          throw new Error("Existing branch baseline is partial or differs");
        for (const { baseline, artifacts } of sorted) {
          const observed = await inspectHistory(target, baseline.scope, artifacts);
          if (observed.issues.length || JSON.stringify(observed.applied) !== JSON.stringify(baseline.migrations))
            throw new Error("Existing branch baseline is partial or differs");
        }
        const observed = await target.query<{ mount_path: string; namespace: string; state: string }>(
          `SELECT mount_path,namespace,state FROM ${metadata}.component_namespaces ORDER BY mount_path`,
        );
        if (JSON.stringify(observed.rows) !== JSON.stringify(ownership))
          throw new Error("Existing component ownership differs");
      } else {
        for (const name of allowed) {
          if (!tables.rows.some((entry) => entry.name === name)) continue;
          if ((await target.query(`SELECT 1 FROM ${metadata}.${quoteIdentifier(name)} LIMIT 1`)).rowCount)
            throw new Error("Existing branch baseline is partial or differs");
        }
        for (const migration of frameworkMigrations(metadataNamespace))
          await target.query(`INSERT INTO ${metadata}.framework_migrations(version,hash) VALUES($1,$2)`, [
            migration.version,
            migration.hash,
          ]);
        for (const row of ownership)
          await target.query(
            `INSERT INTO ${metadata}.component_namespaces(mount_path,namespace,state) VALUES($1,$2,$3)`,
            [row.mount_path, row.namespace, row.state],
          );
        for (const { baseline, artifacts } of sorted) {
          const namespace = baseline.scope.namespace;
          const orm = `${metadata}.${quoteIdentifier(ormHistoryTable(namespace))}`;
          for (const migration of baseline.migrations) {
            await target.query(
              `INSERT INTO ${metadata}.migration_history(namespace,ordinal,name,hash,before_hash,after_hash,catalog_hash) VALUES($1,$2,$3,$4,$5,$6,$7)`,
              [
                namespace,
                migration.ordinal,
                migration.name,
                migration.hash,
                migration.before_hash,
                migration.after_hash,
                migration.catalog_hash,
              ],
            );
            await target.query(`INSERT INTO ${orm}(hash,created_at,name) VALUES($1,$2,$3)`, [
              migration.hash,
              migration.ordinal,
              migration.name,
            ]);
          }
          const latest = artifacts[baseline.migrations.length - 1];
          for (const entity of latest?.plan.snapshot.ddl ?? []) {
            if (entity.entityType !== "tables") continue;
            await target.query(
              `INSERT INTO ${metadata}.table_revisions(namespace,table_name,revision) VALUES($1,$2,1)`,
              [namespace, entity.name],
            );
          }
        }
      }
      for (const { baseline, artifacts } of sorted)
        if ((await inspectHistory(target, baseline.scope, artifacts)).issues.length)
          throw new Error("Branch baseline failed migration verification");
    }
    await verifySource();
    await target.query("COMMIT");
  } catch (cause) {
    await target.query("ROLLBACK").catch(() => {});
    throw cause;
  }
}

/** Compatibility entrypoint for a single application scope. */
export async function establishSchemaBaseline(
  source: pg.Client,
  target: pg.Client,
  baseline: SchemaBaseline,
  artifacts: readonly MigrationArtifact[],
): Promise<void> {
  return establishSchemaBaselines(source, target, [{ baseline, artifacts }]);
}
