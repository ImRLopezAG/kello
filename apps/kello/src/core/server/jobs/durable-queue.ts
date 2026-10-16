import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as v from "valibot";
import type { JsonValue } from "../../schema/fields";
import { canonical } from "../../validation/canonical";
import { json } from "../../validation/encoding";
import type { InvocationIdentity } from "../auth/context";
import { validateIdempotencyOptions } from "../idempotency";
import type { IdempotencyOptions } from "../idempotency";
import { publishRuntimeMetric } from "../observability";
import {
  jobFailure,
  jobId,
  jobIdentity,
  jobLease,
  jobLimits,
  jobRecord,
  leaseDuration,
  leaseOwner,
  scheduleOptions,
} from "./contracts";
import type { JobFailureCode, JobLease, JobRecord, JobScheduleOptions } from "./contracts";

export interface DurableJob<Call> extends JobLease {
  readonly call: Call;
  readonly identity: InvocationIdentity | null;
  readonly attempt: number;
}
export interface DurableQueueOptions<Call extends { readonly version: string }> extends IdempotencyOptions {
  readonly db: NodePgDatabase;
  readonly version: string;
  readonly parseCall: (input: JsonValue) => Call;
  readonly parseClaim?: (input: JsonValue) => Call | Promise<Call>;
  readonly prepare: (call: Call) => Promise<void>;
  /** Ceiling for explicitly requested attempts. Omitted per-job policy still executes once. */
  readonly maxAttempts?: number;
  /** Default fixed delay for a job that explicitly permits retry and omits its own delay. */
  readonly retryDelaySeconds?: number;
}

/** Trusted server capability. Enqueue with the mutation's transaction; never expose queue methods to clients. */
export function createDurableJobQueue<Call extends { readonly version: string }>(options: DurableQueueOptions<Call>) {
  validateIdempotencyOptions(options);
  const { db, deployment, version } = options;
  const maxAttempts = v.parse(scheduleOptions.entries.maxAttempts, options.maxAttempts ?? jobLimits.maxAttempts);
  const retryDelaySeconds = v.parse(scheduleOptions.entries.retryDelaySeconds, options.retryDelaySeconds);
  if (!/^[a-f0-9]{64}$/.test(version)) throw new Error("Invalid job registry version");
  const table = sql`${sql.identifier(options.metadataNamespace)}.${sql.identifier("jobs")}`;
  const history = sql`${sql.identifier(options.metadataNamespace)}.${sql.identifier("job_replays")}`;

  async function fenced(lease: JobLease, update: SQL, condition: SQL = sql`TRUE`): Promise<boolean> {
    const captured = v.parse(jobLease, { id: lease.id, owner: lease.owner, token: lease.token });
    // Lock first, then check the clock: time spent waiting for a row lock cannot revive an expired lease.
    const result = await db.execute(sql`
      WITH locked AS MATERIALIZED (
        SELECT id, state, lease_owner, fencing_token, lease_expires_at, cancel_requested
        FROM ${table} WHERE deployment = ${deployment} AND id = ${captured.id}::uuid FOR UPDATE
      ), eligible AS MATERIALIZED (
        SELECT job.id FROM locked AS job WHERE job.state = 'running'
          AND job.lease_owner = ${captured.owner} AND job.fencing_token = ${captured.token}::bigint
          AND job.lease_expires_at > clock_timestamp() AND ${condition}
      )
      UPDATE ${table} AS job SET ${update} FROM eligible
      WHERE job.id = eligible.id AND job.deployment = ${deployment}
      RETURNING job.id
    `);
    return result.rows.length === 1;
  }

  return {
    async enqueue(
      transaction: NodePgDatabase,
      input: Call,
      identity: InvocationIdentity | null,
      scheduling: JobScheduleOptions,
    ): Promise<string> {
      const call = options.parseCall(v.parse(json, structuredClone(input)));
      const principal = v.parse(jobIdentity, structuredClone(identity));
      const captured = structuredClone(scheduling);
      const policy = v.parse(scheduleOptions, {
        ...captured,
        retryDelaySeconds: captured.retryDelaySeconds === undefined ? retryDelaySeconds : captured.retryDelaySeconds,
      });
      if (policy.maxAttempts > maxAttempts) throw new Error("Job exceeds the configured attempt limit");
      if (call.version !== version) throw new Error("Job function version does not match registry");
      const payload = JSON.stringify(call);
      if (Buffer.byteLength(payload) > 65536) throw new Error("Job arguments exceed 64 KiB");
      await options.prepare(call);
      const fingerprint = createHash("sha256")
        .update(
          canonical({
            call: v.parse(json, call),
            identity: principal,
            dueAt: policy.dueAt.toISOString(),
            maxAttempts: policy.maxAttempts,
            retryDelaySeconds: policy.retryDelaySeconds,
          }),
        )
        .digest("hex");
      const saved = await transaction.execute<{ id: string; fingerprint: string }>(sql`
        INSERT INTO ${table} (id, deployment, deduplication_key, fingerprint, call, identity, due_at, max_attempts, retry_delay_seconds)
        VALUES (${crypto.randomUUID()}::uuid, ${deployment}, ${policy.deduplicationKey}, ${fingerprint},
          ${payload}::jsonb, ${JSON.stringify(principal)}::jsonb, ${policy.dueAt.toISOString()}::timestamptz,
          ${policy.maxAttempts}, ${policy.retryDelaySeconds})
        ON CONFLICT (deployment, deduplication_key) DO UPDATE SET deduplication_key = EXCLUDED.deduplication_key
        RETURNING id, fingerprint
      `);
      const row = saved.rows[0];
      if (!row || row.fingerprint !== fingerprint) throw new Error("Job deduplication conflict");
      return row.id;
    },
    async claim(owner: string, seconds: number): Promise<DurableJob<Call> | null> {
      v.parse(leaseOwner, owner);
      v.parse(leaseDuration, seconds);
      // Reap at most 100 abandoned terminal attempts per call; no unbounded sweep or process-local recovery state.
      const reaped = await db.execute(sql`
        WITH expired AS (
          SELECT id FROM ${table} WHERE deployment = ${deployment} AND COALESCE(claim_version, call->>'version') = ${version} AND state = 'running'
            AND lease_expires_at <= clock_timestamp() AND (cancel_requested OR attempts >= max_attempts)
          ORDER BY lease_expires_at, id LIMIT 100 FOR UPDATE SKIP LOCKED
        )
        UPDATE ${table} AS job SET state = CASE WHEN job.cancel_requested THEN 'cancelled' ELSE 'failed' END,
          error_code = CASE WHEN job.cancel_requested THEN 'CANCELLED' ELSE 'LEASE_EXPIRED' END,
          lease_owner = NULL, lease_expires_at = NULL
        FROM expired WHERE job.id = expired.id
        RETURNING job.id
      `);
      if (reaped.rows.length > 0) publishRuntimeMetric({ type: "job.lease.reaped", count: reaped.rows.length });
      const result = await db.execute(sql`
        WITH authority AS MATERIALIZED (
          SELECT set_config('loom.worker_version', ${version}, true)
        ), candidate AS (
          SELECT id, state FROM ${table} CROSS JOIN authority WHERE deployment = ${deployment} AND COALESCE(claim_version, call->>'version') = ${version}
            AND NOT cancel_requested AND attempts < max_attempts
            AND ((state = 'pending' AND due_at <= clock_timestamp()) OR (state = 'running' AND lease_expires_at <= clock_timestamp()))
          ORDER BY due_at, id LIMIT 1 FOR UPDATE SKIP LOCKED
        )
        UPDATE ${table} AS job SET state = 'running', lease_owner = ${owner},
          lease_expires_at = clock_timestamp() + ${seconds} * interval '1 second',
          fencing_token = job.fencing_token + 1, attempts = job.attempts + 1, lease_version = ${version}
        FROM candidate WHERE job.id = candidate.id
        RETURNING job.id, job.lease_owner AS owner, job.fencing_token::text AS token, job.call, job.identity, job.attempts AS attempt,
          GREATEST(0, EXTRACT(EPOCH FROM (clock_timestamp() - job.created_at)) * 1000)::double precision AS "ageMs",
          GREATEST(0, EXTRACT(EPOCH FROM (clock_timestamp() - job.due_at)) * 1000)::double precision AS "dueLagMs",
          candidate.state = 'running' AS recovered
      `);
      const row = result.rows[0];
      if (!row) return null;
      const saved = v.parse(
        v.object({ ...jobLease.entries, call: json, identity: jobIdentity, attempt: v.number() }),
        row,
      );
      const timing = v.parse(
        v.object({
          ageMs: v.pipe(v.number(), v.finite(), v.minValue(0)),
          dueLagMs: v.pipe(v.number(), v.finite(), v.minValue(0)),
          recovered: v.boolean(),
        }),
        row,
      );
      publishRuntimeMetric({ type: "job.claim", ...timing, attempt: saved.attempt });
      return { ...saved, call: await (options.parseClaim ?? options.parseCall)(saved.call) };
    },
    renew(lease: JobLease, seconds: number): Promise<boolean> {
      v.parse(leaseDuration, seconds);
      return fenced(
        lease,
        sql`lease_expires_at = clock_timestamp() + ${seconds} * interval '1 second'`,
        sql`NOT job.cancel_requested`,
      );
    },
    complete(lease: JobLease, result: JsonValue): Promise<boolean> {
      const payload = JSON.stringify(v.parse(json, result));
      if (Buffer.byteLength(payload) > 1048576) throw new Error("Job result exceeds 1 MiB");
      return fenced(
        lease,
        sql`state = 'succeeded', result = ${payload}::jsonb, error_code = NULL, lease_owner = NULL, lease_expires_at = NULL`,
      );
    },
    fail(lease: JobLease, errorCode: JobFailureCode): Promise<boolean> {
      v.parse(jobFailure, errorCode);
      return fenced(
        lease,
        sql`
        state = CASE WHEN job.cancel_requested THEN 'cancelled' WHEN job.attempts >= job.max_attempts THEN 'failed' ELSE 'pending' END,
        due_at = clock_timestamp() + job.retry_delay_seconds * interval '1 second',
        error_code = ${errorCode}, lease_owner = NULL, lease_expires_at = NULL
      `,
      );
    },
    async cancel(id: string): Promise<"cancelled" | "requested" | "finished" | "missing"> {
      v.parse(jobId, id);
      const result = await db.execute<{ state: string }>(sql`
        UPDATE ${table} SET cancel_requested = CASE WHEN state IN ('pending', 'running') THEN TRUE ELSE cancel_requested END,
          state = CASE WHEN state = 'pending' THEN 'cancelled' ELSE state END
        WHERE deployment = ${deployment} AND id = ${id}::uuid RETURNING state
      `);
      const row = result.rows[0];
      if (!row) return "missing";
      if (row.state === "running") return "requested";
      return row.state === "cancelled" ? "cancelled" : "finished";
    },
    async inspect(id: string): Promise<JobRecord | null> {
      v.parse(jobId, id);
      const result = await db.execute(sql`
        SELECT id, fencing_token::text AS "fencingToken", state, attempts, cancel_requested AS "cancelRequested", error_code AS "errorCode", result
        FROM ${table} WHERE deployment = ${deployment} AND id = ${id}::uuid
      `);
      return result.rows[0] ? v.parse(jobRecord, result.rows[0]) : null;
    },
    /** Operator capability: replay the inspected failure without changing the job identity or build. */
    async replay(id: string, expectedToken: string, dueAt: Date): Promise<boolean> {
      v.parse(jobId, id);
      v.parse(jobRecord.entries.fencingToken, expectedToken);
      const due = v.parse(v.date(), dueAt).toISOString();
      const result = await db.execute(sql`
        WITH locked AS MATERIALIZED (
          SELECT id, fencing_token, attempts, error_code, result FROM ${table}
          WHERE deployment = ${deployment} AND id = ${id}::uuid FOR UPDATE
        ), replayed AS (
          UPDATE ${table} AS job SET state = 'pending', attempts = 0, due_at = ${due}::timestamptz,
            fencing_token = job.fencing_token + 1, cancel_requested = FALSE, error_code = NULL, result = 'null'::jsonb
          FROM locked WHERE job.id = locked.id AND job.deployment = ${deployment}
            AND job.state = 'failed' AND job.fencing_token = ${expectedToken}::bigint
          RETURNING job.id, locked.fencing_token, locked.attempts, locked.error_code, locked.result
        )
        INSERT INTO ${history} (job_id, deployment, fencing_token, attempts, error_code, result, due_at)
        SELECT id, ${deployment}, fencing_token, attempts, error_code, result, ${due}::timestamptz FROM replayed
        RETURNING job_id
      `);
      return result.rows.length === 1;
    },
  };
}
