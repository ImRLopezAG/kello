import { channel } from "node:diagnostics_channel";

/** Bounded operational labels; never include identities, arguments, SQL or credentials. */
interface TransactionRetryMetric {
  readonly type: "transaction.retry";
  readonly kind: "query" | "mutation";
  /** The attempt about to start, including the original attempt in the count. */
  readonly attempt: number;
}

interface RevisionReadMetric {
  readonly type: "revision.read";
  readonly status: "success" | "error";
  /** Wall time for the database read and result validation, including pool wait if any. */
  readonly durationMs: number;
  readonly tableCount: number;
}

interface JobClaimMetric {
  readonly type: "job.claim";
  /** Database-clock milliseconds since initial creation and the current due time. */
  readonly ageMs: number;
  readonly dueLagMs: number;
  readonly attempt: number;
  readonly recovered: boolean;
}

interface JobLeaseReapedMetric {
  readonly type: "job.lease.reaped";
  readonly count: number;
}

interface JobLeaseLostMetric {
  readonly type: "job.lease.lost";
  readonly reason: "deadline" | "ownership" | "activation" | "queue";
}

interface DatabaseAcquireMetric {
  readonly type: "database.acquire";
  readonly status: "success" | "error";
  readonly durationMs: number;
  readonly total: number;
  readonly idle: number;
  readonly waiting: number;
}

export type RuntimeMetric =
  | {
      readonly type: "rpc.procedure";
      readonly mode: "finite" | "live" | "mutation";
      readonly status: "success" | "error";
      readonly durationMs: number;
    }
  | { readonly type: "realtime.listener"; readonly status: "connected" | "degraded" | "idle" }
  | {
      readonly type: "realtime.coordinator";
      readonly subscriptions: number;
      readonly evaluating: number;
      /** Remaining entries in the current bounded evaluation batch. */
      readonly queued: number;
    }
  | TransactionRetryMetric
  | RevisionReadMetric
  | JobClaimMetric
  | JobLeaseReapedMetric
  | JobLeaseLostMetric
  | DatabaseAcquireMetric;

const metrics = channel("kello.runtime.metric");

export function publishRuntimeMetric(metric: RuntimeMetric): void {
  metrics.publish(metric);
}
