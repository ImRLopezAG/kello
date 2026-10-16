import { lockRuntimeActivation } from "../activation";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as v from "valibot";
import { validateIdempotencyOptions } from "../idempotency";
import { IngressRetiredError } from "../ingress";
import {
  storageIntentValidator,
  storageUploadValidator,
  storageOwnerValidator,
  storageObjectCreatedValidator,
  StorageVerificationError,
} from "./contracts";
import type { StorageObjectCreatedEvent } from "./contracts";
import type { createStorageIntents } from "./intents";
import { storageUploadPrefix } from "./keys";

const identifier = v.pipe(v.string(), v.minLength(1), v.maxLength(256));
const deliveryValidator = v.strictObject({
  invocationId: identifier,
  triggerId: identifier,
  triggerName: identifier,
  bucket: storageUploadValidator.entries.bucket,
  key: v.pipe(v.string(), v.minLength(1), v.maxLength(1024)),
});
export type StorageDelivery = v.InferOutput<typeof deliveryValidator>;
export interface DurableStorageEventOptions {
  readonly db: NodePgDatabase;
  readonly metadataNamespace: string;
  readonly deployment: string;
  readonly projectId: string;
  readonly branchId: string;
  readonly intents: Pick<ReturnType<typeof createStorageIntents>, "finalize">;
  readonly handlers: ReadonlyMap<string, StorageEventEnqueue>;
  readonly assertActive: (signal: AbortSignal, database?: NodePgDatabase) => Promise<void>;
  readonly assertIngress?: (signal: AbortSignal, transaction: NodePgDatabase) => Promise<void>;
}
const intentRow = v.object({
  id: storageIntentValidator.entries.id,
  upload: storageUploadValidator,
  owner_identity: storageOwnerValidator,
  state: v.picklist(["pending", "ready", "failed"]),
  event_job_id: v.nullable(storageIntentValidator.entries.id),
  created_ms: v.pipe(v.number(), v.safeInteger()),
});
const receiptRow = v.object({
  fingerprint: v.string(),
  state: v.picklist(["pending", "dispatched", "failed"]),
  job_id: v.nullable(storageIntentValidator.entries.id),
});
export type StorageDeliveryResult =
  | { readonly state: "dispatched"; readonly jobId: string }
  | { readonly state: "failed" };
function terminal(row: v.InferOutput<typeof receiptRow>): StorageDeliveryResult | undefined {
  if (row.state === "failed") return Object.freeze({ state: "failed" });
  if (row.state === "dispatched") {
    if (!row.job_id) throw new Error("Invalid storage receipt");
    return Object.freeze({ state: "dispatched", jobId: row.job_id });
  }
  return undefined;
}

export type StorageEventEnqueue = (
  transaction: NodePgDatabase,
  event: StorageObjectCreatedEvent,
  dueAt: Date,
  deduplicationKey: string,
) => Promise<string>;
/** Trusted provider ingress. Saved intent ownership is event data, never the queued job's identity. */
export function createDurableStorageEventDispatcher(options: DurableStorageEventOptions) {
  validateIdempotencyOptions(options);
  const { db, deployment, intents, assertActive, assertIngress, metadataNamespace } = options;
  const projectId = v.parse(identifier, options.projectId);
  const branchId = v.parse(identifier, options.branchId);
  const handlers = new Map(
    [...options.handlers].map(([bucket, enqueue]) => [v.parse(storageUploadValidator.entries.bucket, bucket), enqueue]),
  );
  const prefix = storageUploadPrefix(projectId, branchId);
  const uploads = sql`${sql.identifier(options.metadataNamespace)}.${sql.identifier("storage_intents")}`;
  const receipts = sql`${sql.identifier(options.metadataNamespace)}.${sql.identifier("storage_receipts")}`;
  const scope = sql`deployment = ${deployment} AND project_id = ${projectId} AND branch_id = ${branchId}`;
  const columns = sql`id, upload, owner_identity, state, event_job_id, floor(extract(epoch FROM created_at) * 1000)::float8 AS created_ms`;
  async function active(signal: AbortSignal, database?: NodePgDatabase) {
    signal.throwIfAborted();
    await assertActive(signal, database);
    signal.throwIfAborted();
  }
  async function receive(
    input: StorageDelivery,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<StorageDeliveryResult> {
    const delivery = v.parse(deliveryValidator, input);
    const configured = handlers.get(delivery.bucket);
    if (!configured || !delivery.key.startsWith(prefix)) throw new Error("Unbound storage event");
    const id = v.parse(storageIntentValidator.entries.id, delivery.key.slice(prefix.length));
    if (delivery.key !== `${prefix}${id}`) throw new Error("Unbound storage event");
    const fingerprint = createHash("sha256")
      .update(JSON.stringify([delivery.triggerId, delivery.triggerName, delivery.bucket, delivery.key]))
      .digest("hex");
    await active(signal);
    const { upload, receipt } = await db.transaction(async (transaction) => {
      await lockRuntimeActivation(transaction, metadataNamespace);
      await active(signal, transaction);
      await assertIngress?.(signal, transaction);
      const found = await transaction.execute(
        sql`SELECT ${columns} FROM ${uploads} WHERE ${scope} AND id = ${id}::uuid`,
      );
      const upload = v.parse(intentRow, found.rows[0]);
      if (upload.upload.bucket !== delivery.bucket) throw new Error("Unbound storage event");
      await transaction.execute(sql`INSERT INTO ${receipts} (deployment, project_id, branch_id, invocation_id, trigger_id, trigger_name, bucket, object_key, intent_id, fingerprint)
        VALUES (${deployment}, ${projectId}, ${branchId}, ${delivery.invocationId}, ${delivery.triggerId}, ${delivery.triggerName}, ${delivery.bucket}, ${delivery.key}, ${id}::uuid, ${fingerprint})
        ON CONFLICT (deployment, project_id, branch_id, invocation_id) DO NOTHING`);
      const recorded = await transaction.execute(
        sql`SELECT fingerprint, state, job_id FROM ${receipts} WHERE ${scope} AND invocation_id = ${delivery.invocationId}`,
      );
      const receipt = v.parse(receiptRow, recorded.rows[0]);
      if (receipt.fingerprint !== fingerprint) throw new Error("Storage invocation conflict");
      return { upload, receipt };
    });
    const complete = terminal(receipt);
    if (complete) return complete;
    if (upload.state !== "failed") {
      try {
        await intents.finalize(upload.owner_identity, id, signal);
      } catch (cause) {
        if (!(cause instanceof StorageVerificationError)) throw cause;
      }
    }
    await active(signal);
    return db.transaction(async (transaction) => {
      await lockRuntimeActivation(transaction, metadataNamespace);
      await active(signal, transaction);
      await assertIngress?.(signal, transaction);
      // Lock order is always intent then receipt, including different invocations for the same object.
      const locked = await transaction.execute(
        sql`SELECT ${columns} FROM ${uploads} WHERE ${scope} AND id = ${id}::uuid FOR UPDATE`,
      );
      const current = v.parse(intentRow, locked.rows[0]);
      const saved = await transaction.execute(
        sql`SELECT fingerprint, state, job_id FROM ${receipts} WHERE ${scope} AND invocation_id = ${delivery.invocationId} FOR UPDATE`,
      );
      const currentReceipt = v.parse(receiptRow, saved.rows[0]);
      if (currentReceipt.fingerprint !== fingerprint) throw new Error("Storage invocation conflict");
      const done = terminal(currentReceipt);
      if (done) return done;
      await active(signal, transaction);
      if (current.state === "failed") {
        await transaction.execute(
          sql`UPDATE ${receipts} SET state = 'failed' WHERE ${scope} AND invocation_id = ${delivery.invocationId}`,
        );
        return Object.freeze({ state: "failed" as const });
      }
      if (current.state !== "ready") throw new Error("Storage object is not verified");
      let jobId = current.event_job_id;
      if (!jobId) {
        const args = v.parse(storageObjectCreatedValidator, {
          intentId: id,
          ...current.upload,
          uploadedBy: current.owner_identity,
        });
        jobId = await configured(transaction, args, new Date(current.created_ms), `storage:${id}`);
        await transaction.execute(
          sql`UPDATE ${uploads} SET event_job_id = ${jobId}::uuid WHERE ${scope} AND id = ${id}::uuid`,
        );
      }
      await transaction.execute(
        sql`UPDATE ${receipts} SET state = 'dispatched', job_id = ${jobId}::uuid WHERE ${scope} AND invocation_id = ${delivery.invocationId}`,
      );
      signal.throwIfAborted();
      return Object.freeze({ state: "dispatched" as const, jobId });
    });
  }
  async function reconcile(limit = 25, signal: AbortSignal = new AbortController().signal) {
    v.parse(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(1000)), limit);
    const result = { claimed: 0, dispatched: 0, failed: 0, pending: 0, inactive: false };
    await active(signal);
    if (handlers.size === 0) return Object.freeze(result);
    let deliveries: StorageDelivery[];
    try {
      deliveries = await db.transaction(async (transaction) => {
        await lockRuntimeActivation(transaction, metadataNamespace);
        await assertIngress?.(signal, transaction);
        await active(signal, transaction);
        const claimed = await transaction.execute(sql`
          WITH due AS (
            SELECT invocation_id FROM ${receipts} WHERE ${scope} AND state='pending'
              AND bucket IN (${sql.join(
                [...handlers.keys()].map((bucket) => sql`${bucket}`),
                sql`,`,
              )})
              AND reconcile_after <= clock_timestamp()
            ORDER BY reconcile_after, invocation_id LIMIT ${limit} FOR UPDATE SKIP LOCKED
          )
          UPDATE ${receipts} SET reconcile_after=clock_timestamp() + interval '1 minute'
          WHERE ${scope} AND invocation_id IN (SELECT invocation_id FROM due)
          RETURNING invocation_id AS "invocationId", trigger_id AS "triggerId",
            trigger_name AS "triggerName", bucket, object_key AS key`);
        signal.throwIfAborted();
        return v.parse(v.array(deliveryValidator), claimed.rows);
      });
    } catch (cause) {
      signal.throwIfAborted();
      if (!(cause instanceof IngressRetiredError)) throw cause;
      return Object.freeze({ ...result, inactive: true });
    }
    result.claimed = deliveries.length;
    for (const delivery of deliveries) {
      try {
        const received = await receive(delivery, signal);
        result[received.state] += 1;
      } catch (cause) {
        signal.throwIfAborted();
        // The durable receipt remains pending and becomes eligible after its retry delay.
        result.pending += 1;
        if (cause instanceof IngressRetiredError) result.inactive = true;
      }
    }
    return Object.freeze(result);
  }
  return Object.freeze({ receive, reconcile });
}
