import type pg from "pg";
import { parse } from "libpg-query";
import * as v from "valibot";
import { databaseIdentifier, quoteIdentifier } from "./connection";
import { catalogFingerprint } from "./drift";
import type { MigrationArtifact } from "./history";

const indexStatement = v.strictObject({
  idxname: databaseIdentifier,
  relation: v.strictObject({
    schemaname: databaseIdentifier,
    relname: databaseIdentifier,
    inh: v.literal(true),
    relpersistence: v.literal("p"),
    location: v.number(),
  }),
  accessMethod: v.literal("btree"),
  indexParams: v.pipe(
    v.array(
      v.strictObject({
        IndexElem: v.strictObject({
          name: v.pipe(v.string(), v.minLength(1)),
          ordering: v.picklist(["SORTBY_DEFAULT", "SORTBY_ASC"]),
          nulls_ordering: v.picklist(["SORTBY_NULLS_DEFAULT", "SORTBY_NULLS_LAST"]),
        }),
      }),
    ),
    v.minLength(1),
  ),
  unique: v.optional(v.boolean(), false),
  concurrent: v.optional(v.boolean(), false),
});

async function indexDefinition(statement: string, concurrent: boolean) {
  const parsed = await parse(statement);
  const nodes = parsed.stmts ?? [];
  const node = nodes[0]?.stmt;
  if (nodes.length !== 1 || !node || Object.keys(node).length !== 1 || !("IndexStmt" in node))
    throw new Error("Recovery supports only concurrent column B-tree index creation");
  const result = v.safeParse(indexStatement, node.IndexStmt);
  if (!result.success || result.output.concurrent !== concurrent)
    throw new Error("Recovery supports only concurrent column B-tree index creation");
  const spec = result.output;
  return {
    name: spec.idxname,
    namespace: spec.relation.schemaname,
    table: spec.relation.relname,
    unique: spec.unique,
    columns: spec.indexParams.map((column) => column.IndexElem.name),
  };
}

/** Derive recoverable operations only when reviewed SQL and the declared structural change agree. */
export async function concurrentIndexOperations(artifact: MigrationArtifact, namespace: string) {
  if (artifact.plan.kind !== "custom" || artifact.plan.safety.transactional || !artifact.plan.statements.length)
    throw new Error("Expected a nontransactional custom index artifact");
  const operations = await Promise.all(
    artifact.plan.statements.map(async (statement) => ({
      statement,
      spec: await indexDefinition(statement, true),
    })),
  );
  const names = operations.map((operation) => operation.spec.name);
  if (new Set(names).size !== names.length || operations.some((operation) => operation.spec.namespace !== namespace))
    throw new Error("Concurrent indexes must have unique names in the application namespace");
  const added = artifact.plan.snapshot.ddl.filter(
    (entity) => entity.entityType === "indexes" && names.includes(entity.name),
  );
  const remaining = artifact.plan.snapshot.ddl.filter(
    (entity) => !(entity.entityType === "indexes" && names.includes(entity.name)),
  );
  if (JSON.stringify(remaining) !== JSON.stringify(artifact.plan.baseline.ddl) || added.length !== operations.length)
    throw new Error("Concurrent recovery requires an index-only expansion");
  for (const { spec } of operations) {
    const entry = added.find((entity) => entity.name === spec.name);
    if (
      !entry ||
      entry.entityType !== "indexes" ||
      entry.schema !== namespace ||
      entry.table !== spec.table ||
      entry.isUnique !== spec.unique ||
      entry.method !== "btree" ||
      entry.where !== null ||
      entry.with !== "" ||
      JSON.stringify(entry.columns.map((column) => column.value)) !== JSON.stringify(spec.columns) ||
      entry.columns.some((column) => column.isExpression || !column.asc || column.nullsFirst || column.opclass !== null)
    )
      throw new Error("Concurrent index SQL differs from the declared snapshot");
  }
  return operations;
}

export interface ConcurrentRecoveryScope {
  readonly namespace: string;
  readonly metadataNamespace: string;
}
export async function readConcurrentRecovery(client: pg.Client, scope: ConcurrentRecoveryScope) {
  return (
    await client.query<{ ordinal: number; hash: string; before_catalog_hash: string }>(
      `SELECT ordinal, hash, before_catalog_hash FROM ${quoteIdentifier(scope.metadataNamespace)}.nontransactional_migrations WHERE namespace=$1`,
      [scope.namespace],
    )
  ).rows[0];
}

export async function verifyConcurrentBaseline(
  client: pg.Client,
  scope: ConcurrentRecoveryScope,
  artifact: MigrationArtifact,
  beforeCatalog: string,
  ordinal: number,
) {
  const operations = await concurrentIndexOperations(artifact, scope.namespace);
  const journal = await readConcurrentRecovery(client, scope);
  if (
    journal &&
    (journal.hash !== artifact.plan.hash ||
      journal.ordinal !== ordinal ||
      journal.before_catalog_hash !== beforeCatalog)
  )
    throw new Error("Concurrent migration recovery identity changed");
  const ignored = journal ? operations.map((operation) => operation.spec.name) : [];
  if ((await catalogFingerprint(client, scope.namespace, ignored)) !== beforeCatalog)
    throw new Error("Live database drift detected during concurrent migration recovery");
  return { operations, journal };
}

/** Caller owns the migration lock; DDL runs outside a transaction and the journal survives every failed step. */
export async function executeConcurrentIndexes(
  client: pg.Client,
  scope: ConcurrentRecoveryScope,
  artifact: MigrationArtifact,
  beforeCatalog: string,
  ordinal: number,
) {
  const { operations, journal } = await verifyConcurrentBaseline(client, scope, artifact, beforeCatalog, ordinal);
  if (!journal)
    await client.query(
      `INSERT INTO ${quoteIdentifier(scope.metadataNamespace)}.nontransactional_migrations(namespace,ordinal,hash,before_catalog_hash) VALUES($1,$2,$3,$4)`,
      [scope.namespace, ordinal, artifact.plan.hash, beforeCatalog],
    );
  for (const { statement, spec } of operations) {
    await verifyConcurrentBaseline(client, scope, artifact, beforeCatalog, ordinal);
    const existing = await client.query<{ definition: string | null; valid: boolean; ready: boolean; owned: boolean }>(
      `SELECT CASE WHEN c.relkind='i' THEN pg_get_indexdef(c.oid) END AS definition,
        i.indisvalid AS valid, i.indisready AS ready, c.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AS owned
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_index i ON i.indexrelid=c.oid
        WHERE n.nspname=$1 AND c.relname=$2`,
      [scope.namespace, spec.name],
    );
    const current = existing.rows[0];
    if (current) {
      if (
        !current.owned ||
        !current.definition ||
        JSON.stringify(await indexDefinition(current.definition, false)) !== JSON.stringify(spec)
      )
        throw new Error("Existing index differs from the reviewed concurrent operation");
      if (current.valid && current.ready) continue;
      await client.query(`DROP INDEX CONCURRENTLY ${quoteIdentifier(scope.namespace)}.${quoteIdentifier(spec.name)}`);
    }
    await client.query(statement);
  }
  await verifyConcurrentBaseline(client, scope, artifact, beforeCatalog, ordinal);
}
