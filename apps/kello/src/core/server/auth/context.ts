import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as v from "valibot";

/** Durable job identity and current attempt number for a scheduled invocation. */
export interface JobInvocation {
  readonly id: string;
  readonly attempt: number;
}
const jobInvocation = v.strictObject({
  id: v.pipe(v.string(), v.uuid()),
  attempt: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(10)),
});
export function captureJobInvocation(job: JobInvocation | undefined): JobInvocation | undefined {
  return job ? Object.freeze(v.parse(jobInvocation, job)) : undefined;
}

/** Supplied by a trusted verifier or worker, never derived from function arguments. */
export interface InvocationIdentity {
  readonly issuer: string;
  readonly subject: string;
  readonly tenantId?: string;
}
/** Request-scoped identity, cancellation, and tracing information shared by server handlers. */
export interface InvocationContext {
  readonly identity: InvocationIdentity | null;
  readonly requestId: string;
  readonly signal: AbortSignal;
  /** Stable across lease owners; use id for external idempotency in scheduled actions. */
  readonly job?: JobInvocation | undefined;
}

/** Local to the current transaction. Pool reuse must never inherit a previous request's identity. */
export async function bindDatabaseIdentity(db: NodePgDatabase, identity: InvocationIdentity | null): Promise<void> {
  const value = JSON.stringify(identity);
  // Existing application RLS policies keep reading the original transaction-local key.
  await db.execute(
    sql`SELECT set_config('kello.identity', ${value}, true), set_config('loom.identity', ${value}, true)`,
  );
}
