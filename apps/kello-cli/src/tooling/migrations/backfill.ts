import { createHash } from "node:crypto";
import type pg from "pg";
import { parse } from "libpg-query";
import * as v from "valibot";
import { acquireMigrationLock, databaseIdentifier, quoteIdentifier, withMigrationConnection } from "./connection";
import { bootstrapSession } from "./bootstrap";
import { inspectHistory } from "./state";
import { readMigrations } from "./history";
import { catalogFingerprint } from "./drift";
import { assertGeneratedVersion } from "../codegen/generate";

const hash = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/));
const inputValidator = v.strictObject({
  name: databaseIdentifier,
  namespace: databaseIdentifier,
  table: databaseIdentifier,
  migrationHash: hash,
  batchSize: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(10000)),
  sql: v.pipe(v.string(), v.minLength(1)),
});
export const backfillPlanValidator = v.strictObject({ format: v.literal(1), ...inputValidator.entries, hash });
export type BackfillPlan = v.InferOutput<typeof backfillPlanValidator>;

/** Reviewed SQL is migration-authority code, not a sandbox. Kello owns transactions and returned-row checks. */
export async function createBackfillPlan(input: v.InferInput<typeof inputValidator>): Promise<BackfillPlan> {
  const config = v.parse(inputValidator, input);
  const statements = (await parse(config.sql)).stmts ?? [];
  const node = statements[0]?.stmt;
  const update = node && "UpdateStmt" in node ? node.UpdateStmt : undefined;
  if (
    statements.length !== 1 ||
    !update ||
    update.withClause ||
    update.relation?.schemaname !== config.namespace ||
    update.relation.relname !== config.table ||
    !update.whereClause ||
    !update.returningClause ||
    update.targetList?.some(
      (entry) => "ResTarget" in entry && (entry.ResTarget.name === "_id" || entry.ResTarget.name === "_createdAt"),
    )
  )
    throw new Error("Backfill requires one UPDATE of its declared table with a batch predicate and RETURNING _id");
  const content = { format: 1 as const, ...config };
  return {
    ...content,
    hash: createHash("sha256").update("loom-backfill-v1\0").update(JSON.stringify(content)).digest("hex"),
  };
}

const runValidator = v.strictObject({
  connectionString: v.string(),
  root: v.string(),
  migrations: v.string(),
  namespace: databaseIdentifier,
  metadataNamespace: v.optional(v.pipe(databaseIdentifier, v.regex(/^loom_/)), "loom_meta"),
  runtimeRole: databaseIdentifier,
  plan: backfillPlanValidator,
  reviewedHash: hash,
  sourceVersion: v.optional(hash),
  maxBatches: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(1))),
});
export type RunBackfillOptions = v.InferInput<typeof runValidator> & Partial<Record<"signal", AbortSignal>>;
export interface BackfillReceipt {
  readonly name: string;
  readonly hash: string;
  readonly state: "running" | "complete";
  readonly total: number;
  readonly processed: number;
  readonly deleted: number;
  readonly lastKey: string | null;
}
interface Checkpoint {
  hash: string;
  catalog_hash: string;
  state: "running" | "complete";
  total: string;
  processed: string;
  deleted: string;
  last_key: string | null;
}
const count = v.pipe(v.string(), v.transform(Number), v.safeInteger(), v.minValue(0));
function receipt(plan: BackfillPlan, checkpoint: Checkpoint): BackfillReceipt {
  return {
    name: plan.name,
    hash: plan.hash,
    state: checkpoint.state,
    total: v.parse(count, checkpoint.total),
    processed: v.parse(count, checkpoint.processed),
    deleted: v.parse(count, checkpoint.deleted),
    lastKey: checkpoint.last_key,
  };
}

async function readCheckpoint(client: pg.Client, metadata: string, plan: BackfillPlan) {
  return (
    await client.query<Checkpoint>(
      `SELECT hash, catalog_hash, state, total, processed, deleted, last_key FROM ${metadata}.backfills WHERE namespace=$1 AND name=$2`,
      [plan.namespace, plan.name],
    )
  ).rows[0];
}

export async function validateBackfillPlan(input: BackfillPlan): Promise<BackfillPlan> {
  const { hash: suppliedHash, format: _format, ...planInput } = v.parse(backfillPlanValidator, input);
  const plan = await createBackfillPlan(planInput);
  if (plan.hash !== suppliedHash) throw new Error("Backfill artifact hash mismatch");
  return plan;
}

const statusValidator = v.pick(runValidator, ["connectionString", "namespace", "metadataNamespace", "plan"]);
export type BackfillStatusOptions = v.InferInput<typeof statusValidator>;
export async function backfillStatus(options: BackfillStatusOptions): Promise<BackfillReceipt | null> {
  const config = v.parse(statusValidator, options);
  const plan = await validateBackfillPlan(config.plan);
  if (plan.namespace !== config.namespace) throw new Error("Backfill namespace differs from target");
  return withMigrationConnection(config.connectionString, async (client) => {
    await acquireMigrationLock(client, `loom:migrations:${config.namespace}`, true);
    const metadata = quoteIdentifier(config.metadataNamespace);
    const exists = await client.query<{ present: boolean }>("SELECT to_regclass($1) IS NOT NULL AS present", [
      `${metadata}.backfills`,
    ]);
    if (!exists.rows[0]?.present) return null;
    const checkpoint = await readCheckpoint(client, metadata, plan);
    if (!checkpoint) return null;
    if (checkpoint.hash !== plan.hash) throw new Error("Backfill checkpoint identity changed");
    return receipt(plan, checkpoint);
  });
}

/** Captures a finite work list, then commits each bounded row update and checkpoint together. */
export async function runBackfill(options: RunBackfillOptions): Promise<BackfillReceipt> {
  const { signal, ...input } = options;
  const config = v.parse(runValidator, input);
  const plan = await validateBackfillPlan(config.plan);
  if (config.reviewedHash !== plan.hash) throw new Error("Backfill requires review of its exact artifact hash");
  if (plan.namespace !== config.namespace) throw new Error("Backfill namespace differs from target");
  signal?.throwIfAborted();
  return withMigrationConnection(config.connectionString, async (client) => {
    await acquireMigrationLock(client, `loom:migrations:${config.namespace}`, false, signal);
    if (config.sourceVersion) await assertGeneratedVersion(config.root, config.sourceVersion);
    await bootstrapSession(client, config.metadataNamespace, config.runtimeRole);
    const artifacts = await readMigrations(config.root, config.migrations);
    const state = await inspectHistory(client, config, artifacts);
    const head = artifacts[state.applied.length - 1];
    if (
      state.issues.some((issue) => issue !== "BACKFILL_IN_PROGRESS") ||
      head?.plan.hash !== plan.migrationHash ||
      !state.expectedCatalog
    )
      throw new Error("Backfill requires its fully applied migration history without catalog drift");
    if (
      !head.plan.snapshot.ddl.some(
        (entity) => entity.entityType === "tables" && entity.schema === plan.namespace && entity.name === plan.table,
      )
    )
      throw new Error("Backfill table is absent from the applied schema");
    const metadata = quoteIdentifier(config.metadataNamespace);
    const table = `${quoteIdentifier(plan.namespace)}.${quoteIdentifier(plan.table)}`;
    let checkpoint = await readCheckpoint(client, metadata, plan);
    if (checkpoint && (checkpoint.hash !== plan.hash || checkpoint.catalog_hash !== state.expectedCatalog))
      throw new Error("Backfill checkpoint identity changed");
    if (!checkpoint) {
      await client.query("BEGIN");
      try {
        await client.query(`INSERT INTO ${metadata}.backfills(namespace,name,hash,catalog_hash) VALUES($1,$2,$3,$4)`, [
          plan.namespace,
          plan.name,
          plan.hash,
          state.expectedCatalog,
        ]);
        await client.query(
          `INSERT INTO ${metadata}.backfill_rows(namespace,name,row_id) SELECT $1,$2,"_id" FROM ${table}`,
          [plan.namespace, plan.name],
        );
        await client.query(
          `UPDATE ${metadata}.backfills SET total=(SELECT count(*) FROM ${metadata}.backfill_rows WHERE namespace=$1 AND name=$2) WHERE namespace=$1 AND name=$2`,
          [plan.namespace, plan.name],
        );
        signal?.throwIfAborted();
        await client.query("COMMIT");
      } catch (cause) {
        await client.query("ROLLBACK");
        throw cause;
      }
      checkpoint = await readCheckpoint(client, metadata, plan);
    }
    if (!checkpoint) throw new Error("Missing backfill checkpoint");
    for (
      let batches = 0;
      checkpoint.state !== "complete" && (config.maxBatches === undefined || batches < config.maxBatches);
      batches++
    ) {
      signal?.throwIfAborted();
      if ((await catalogFingerprint(client, plan.namespace)) !== checkpoint.catalog_hash)
        throw new Error("Live database drift detected during backfill");
      await client.query("BEGIN");
      try {
        const keys = (
          await client.query<{ row_id: string }>(
            `SELECT row_id FROM ${metadata}.backfill_rows WHERE namespace=$1 AND name=$2 ORDER BY row_id LIMIT $3`,
            [plan.namespace, plan.name, plan.batchSize],
          )
        ).rows.map((row) => row.row_id);
        const live = (
          await client.query<{ _id: string }>(
            `SELECT "_id" FROM ${table} WHERE "_id"=ANY($1::uuid[]) ORDER BY "_id" FOR UPDATE`,
            [keys],
          )
        ).rows.map((row) => row._id);
        if (live.length) {
          const updated = await client.query<{ _id: string }>(plan.sql, [live]);
          const returned = v
            .parse(v.array(v.strictObject({ _id: v.pipe(v.string(), v.uuid()) })), updated.rows)
            .map((row) => row._id)
            .sort();
          if (JSON.stringify(returned) !== JSON.stringify(live))
            throw new Error("Backfill UPDATE must return exactly the selected row IDs");
        }
        if ((await catalogFingerprint(client, plan.namespace)) !== checkpoint.catalog_hash)
          throw new Error("Live database drift detected during backfill");
        await client.query(
          `DELETE FROM ${metadata}.backfill_rows WHERE namespace=$1 AND name=$2 AND row_id=ANY($3::uuid[])`,
          [plan.namespace, plan.name, keys],
        );
        await client.query(
          `UPDATE ${metadata}.backfills SET processed=processed+$3, deleted=deleted+$4, last_key=COALESCE($5::uuid,last_key), state=CASE WHEN NOT EXISTS (SELECT 1 FROM ${metadata}.backfill_rows WHERE namespace=$1 AND name=$2) THEN 'complete' ELSE 'running' END, updated_at=clock_timestamp() WHERE namespace=$1 AND name=$2`,
          [plan.namespace, plan.name, live.length, keys.length - live.length, keys.at(-1) ?? null],
        );
        signal?.throwIfAborted();
        await client.query("COMMIT");
      } catch (cause) {
        await client.query("ROLLBACK");
        throw cause;
      }
      checkpoint = await readCheckpoint(client, metadata, plan);
      if (!checkpoint) throw new Error("Missing backfill checkpoint");
    }
    return receipt(plan, checkpoint);
  });
}
