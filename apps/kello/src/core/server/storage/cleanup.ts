import { sql } from "drizzle-orm";
import * as v from "valibot";
import { lockRuntimeActivation } from "../activation";
import { validateIdempotencyOptions } from "../idempotency";
import { storageIntentValidator, storageUploadValidator } from "./contracts";
import type { StorageIntentsOptions } from "./intents";

export type StorageCleanupOptions = Omit<StorageIntentsOptions, "authorize">;
const identifier = v.pipe(v.string(), v.minLength(1), v.maxLength(1024));
const rowValidator = v.object({
  id: storageIntentValidator.entries.id,
  upload: storageUploadValidator,
  state: v.picklist(["pending", "ready", "failed"]),
});

/** Internal maintenance capability. Object deletion is retryable; database history remains intact. */
export function createStorageCleanup(options: StorageCleanupOptions) {
  validateIdempotencyOptions(options);
  const { db, deployment, storage, assertActive, metadataNamespace } = options;
  const projectId = v.parse(identifier, options.projectId);
  const branchId = v.parse(identifier, options.branchId);
  if (storage.target.projectId !== projectId || storage.target.branchId !== branchId)
    throw new Error("Storage provider target mismatch");
  const buckets = v.parse(v.array(storageUploadValidator.entries.bucket), [...options.buckets]);
  const table = sql`${sql.identifier(options.metadataNamespace)}.${sql.identifier("storage_intents")}`;
  const scope = sql`deployment = ${deployment} AND project_id = ${projectId} AND branch_id = ${branchId}`;
  async function active(signal: AbortSignal, database = db) {
    signal.throwIfAborted();
    await assertActive(signal, database);
    signal.throwIfAborted();
  }
  return Object.freeze({
    async run(limit = 25, signal: AbortSignal = new AbortController().signal) {
      const count = v.parse(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100)), limit);
      const current = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
      let processed = 0;
      let failed = 0;
      await active(current);
      if (!buckets.length) return Object.freeze({ processed, failed });
      for (let index = 0; index < count; index++) {
        const result = await db.transaction(async (tx) => {
          await lockRuntimeActivation(tx, metadataNamespace);
          await active(current, tx);
          const selected = await tx.execute(sql`SELECT id, upload, state FROM ${table}
            WHERE ${scope} AND upload->>'bucket' IN (${sql.join(
              buckets.map((bucket) => sql`${bucket}`),
              sql`, `,
            )})
              AND cleanup_after <= clock_timestamp()
              AND upload_expires_at <= clock_timestamp() - interval '24 hours'
            ORDER BY cleanup_after, id LIMIT 1 FOR UPDATE SKIP LOCKED`);
          if (!selected.rows.length) return null;
          const row = v.parse(rowValidator, selected.rows[0]);
          await active(current, tx);
          if (row.state === "pending")
            await tx.execute(sql`UPDATE ${table} SET state = 'failed', error_code = 'EXPIRED', updated_at = clock_timestamp()
              WHERE ${scope} AND id = ${row.id}::uuid`);
          const intent = { id: row.id, ...row.upload };
          let removed = true;
          try {
            await storage.remove(intent, "pending", current);
            if (row.state !== "ready") await storage.remove(intent, "ready", current);
          } catch {
            current.throwIfAborted();
            removed = false;
          }
          await active(current, tx);
          // Revisit successful deletions too: an upload started before URL expiry can finish late.
          const retrySeconds = removed ? 86_400 : 300;
          await tx.execute(sql`UPDATE ${table} SET cleanup_after = clock_timestamp() + ${retrySeconds} * interval '1 second'
            WHERE ${scope} AND id = ${row.id}::uuid`);
          return removed;
        });
        if (result === null) break;
        processed++;
        if (!result) failed++;
      }
      return Object.freeze({ processed, failed });
    },
  });
}
