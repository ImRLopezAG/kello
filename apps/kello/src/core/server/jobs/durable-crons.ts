import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as v from "valibot";
import { scheduleOptions } from "./contracts";
import { validateIdempotencyOptions } from "../idempotency";
import type { IdempotencyOptions } from "../idempotency";
const deliveryReceipt = v.strictObject({
  invocationId: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
  triggerId: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
  triggerName: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
});
export type TriggerDeliveryReceipt = v.InferOutput<typeof deliveryReceipt>;

const bounds = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
] as const;
function validSchedule(expression: string): boolean {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  return bounds.every(([minimum, maximum], index) => {
    const field = fields[index];
    return (
      field?.split(",").every((part) => {
        const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
        if (!match) return false;
        const step = Number(match[2] ?? 1);
        if (!Number.isSafeInteger(step) || step < 1) return false;
        if (match[1] === "*") return true;
        const range = match[1]?.split("-").map(Number);
        const start = range?.[0];
        const end = range?.[1] ?? start;
        return start !== undefined && end !== undefined && start >= minimum && end <= maximum && start <= end;
      }) ?? false
    );
  });
}
export const cronScheduleValidator = v.pipe(
  v.string(),
  v.maxLength(200),
  v.check(validSchedule, "Invalid five-field UTC cron schedule"),
);
export type CronPolicy = Pick<v.InferInput<typeof scheduleOptions>, "maxAttempts" | "retryDelaySeconds">;
export type CronEnqueue = (transaction: NodePgDatabase, dueAt: Date, deduplicationKey: string) => Promise<string>;
export interface DurableCronDispatcherOptions extends IdempotencyOptions {
  readonly db: NodePgDatabase;
  readonly crons: ReadonlyMap<string, CronEnqueue>;
  readonly assertActive: (signal: AbortSignal) => Promise<void>;
  readonly assertIngress?: (signal: AbortSignal, transaction: NodePgDatabase) => Promise<void>;
}
const cronName = v.pipe(v.string(), v.regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/));
/** Trusted ingress after provider verification. Never infer or backfill occurrences that were not delivered. */
export function createDurableCronDispatcher(options: DurableCronDispatcherOptions) {
  validateIdempotencyOptions(options);
  const { db, assertActive, deployment } = options;
  const receipts = sql`${sql.identifier(options.metadataNamespace)}.${sql.identifier("trigger_receipts")}`;
  async function record(
    transaction: NodePgDatabase,
    delivery: TriggerDeliveryReceipt,
    at: Date,
    kind: "cron" | "wake",
    jobId: string | null,
  ) {
    const fingerprint = createHash("sha256")
      .update(JSON.stringify([delivery.triggerId, delivery.triggerName, at.toISOString(), kind]))
      .digest("hex");
    await transaction.execute(sql`INSERT INTO ${receipts}
      (deployment, invocation_id, trigger_id, trigger_name, scheduled_at, kind, fingerprint, job_id)
      VALUES (${deployment}, ${delivery.invocationId}, ${delivery.triggerId}, ${delivery.triggerName}, ${at.toISOString()}::timestamptz, ${kind}, ${fingerprint}, ${jobId}::uuid)
      ON CONFLICT (deployment, invocation_id) DO NOTHING`);
    // A separate statement observes the winning insert after a concurrent conflict wait.
    const saved = await transaction.execute<{ fingerprint: string; job_id: string | null }>(sql`
      SELECT fingerprint, job_id FROM ${receipts} WHERE deployment = ${deployment} AND invocation_id = ${delivery.invocationId}`);
    if (saved.rows[0]?.fingerprint !== fingerprint || saved.rows[0]?.job_id !== jobId)
      throw new Error("Trigger invocation conflict");
  }
  const crons = new Map([...options.crons].map(([name, enqueue]) => [v.parse(cronName, name), enqueue]));
  return Object.freeze({
    async recordWake(
      input: TriggerDeliveryReceipt,
      scheduledAt: Date,
      signal: AbortSignal = new AbortController().signal,
    ): Promise<void> {
      const delivery = v.parse(deliveryReceipt, structuredClone(input));
      const at = new Date(v.parse(v.date(), scheduledAt).getTime());
      signal.throwIfAborted();
      await assertActive(signal);
      signal.throwIfAborted();
      await db.transaction(async (transaction) => {
        await record(transaction, delivery, at, "wake", null);
      });
    },
    async dispatch(
      name: string,
      scheduledAt: Date,
      signal: AbortSignal = new AbortController().signal,
      input?: TriggerDeliveryReceipt,
    ): Promise<string> {
      signal.throwIfAborted();
      const delivery = input ? v.parse(deliveryReceipt, structuredClone(input)) : undefined;
      const occurrence = new Date(v.parse(v.date(), scheduledAt).getTime());
      const configured = crons.get(name);
      if (!configured) throw new Error("Cron is not configured");
      const key = createHash("sha256")
        .update(JSON.stringify([name, occurrence.toISOString()]))
        .digest("hex");
      await assertActive(signal);
      signal.throwIfAborted();
      const enqueue = async (transaction: NodePgDatabase) => {
        return configured(transaction, occurrence, `cron:${key}`);
      };
      if (!delivery && !options.assertIngress) return enqueue(db);
      return db.transaction(async (transaction) => {
        await options.assertIngress?.(signal, transaction);
        const jobId = await enqueue(transaction);
        signal.throwIfAborted();
        if (delivery) await record(transaction, delivery, occurrence, "cron", jobId);
        return jobId;
      });
    },
  });
}
