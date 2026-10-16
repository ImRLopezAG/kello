import * as v from "valibot";
import { json } from "../../validation/encoding";

/** These bounds match the durable queue schema and supported worker lease policy. */
export const jobLimits = Object.freeze({ maxAttempts: 10, maxLeaseSeconds: 300, maxRetryDelaySeconds: 3600 });

const identifier = v.pipe(v.string(), v.minLength(1), v.maxLength(1024));
export const jobIdentity = v.nullable(
  v.strictObject({
    issuer: identifier,
    subject: identifier,
    tenantId: v.exactOptional(identifier),
  }),
);
export const jobCall = v.strictObject({
  name: v.pipe(v.string(), v.regex(/^[a-zA-Z0-9][a-zA-Z0-9_/-]*:[a-zA-Z][a-zA-Z0-9_]*$/), v.maxLength(512)),
  kind: v.picklist(["mutation", "action"]),
  version: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
  args: json,
});
export const scheduleOptions = v.strictObject({
  deduplicationKey: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
  dueAt: v.date(),
  maxAttempts: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(jobLimits.maxAttempts)), 1),
  retryDelaySeconds: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(jobLimits.maxRetryDelaySeconds)),
    1,
  ),
});
/** Durable schedule settings validated at enqueue time: due date, deduplication key, retry limit, and retry delay. */
export type JobScheduleOptions = v.InferInput<typeof scheduleOptions>;
export const jobId = v.pipe(v.string(), v.uuid());
export const leaseOwner = v.pipe(v.string(), v.minLength(1), v.maxLength(128));
export const leaseDuration = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(jobLimits.maxLeaseSeconds));
export const jobLease = v.strictObject({
  id: jobId,
  owner: leaseOwner,
  token: v.pipe(v.string(), v.regex(/^[1-9][0-9]*$/)),
});
/** Worker ownership and fencing token for one claimed job. A stale lease cannot authorize completion. */
export type JobLease = v.InferOutput<typeof jobLease>;
export const jobState = v.picklist(["pending", "running", "succeeded", "failed", "cancelled"]);
export const jobRecord = v.object({
  id: jobId,
  fencingToken: v.pipe(v.string(), v.regex(/^(0|[1-9][0-9]*)$/)),
  state: jobState,
  attempts: v.number(),
  cancelRequested: v.boolean(),
  errorCode: v.nullable(v.string()),
  result: json,
});
/** Durable job status, attempts, cancellation, and result metadata. */
export type JobRecord = v.InferOutput<typeof jobRecord>;
export const jobFailure = v.picklist([
  "INTERNAL",
  "FORBIDDEN",
  "CANCELLED",
  "INVALID_ARGUMENTS",
  "NOT_FOUND",
  "VERSION_MISMATCH",
  "INVALID_IDEMPOTENCY_KEY",
  "IDEMPOTENCY_CONFLICT",
  "IDEMPOTENCY_EXPIRED",
  "TRANSACTION_CONFLICT",
  "LEASE_EXPIRED",
]);
export type JobFailureCode = v.InferOutput<typeof jobFailure>;

/** Optional retry and deduplication settings for scheduling helpers; the helper supplies the due date. */
export type SchedulingPolicy = Partial<Omit<JobScheduleOptions, "dueAt">>;
