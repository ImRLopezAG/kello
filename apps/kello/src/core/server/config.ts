import * as v from "valibot";
import { jobLimits } from "./jobs/contracts";
import { authConfigValidator } from "./auth/config";

const bounded = (minimum: number, maximum: number) =>
  v.pipe(v.number(), v.integer(), v.minValue(minimum), v.maxValue(maximum));
const milliseconds = (minimumSeconds: number, maximumSeconds: number) =>
  v.pipe(
    bounded(minimumSeconds * 1000, maximumSeconds * 1000),
    v.check((value) => value % 1000 === 0, "Use whole seconds in milliseconds"),
  );

export const runtimeConfigValidator = v.object({
  openapi: v.optional(v.boolean(), false),
  auth: v.optional(authConfigValidator, {}),
  realtime: v.optional(
    v.strictObject({
      mode: v.optional(v.picklist(["polling", "notify"]), "polling"),
      pollIntervalMs: v.optional(bounded(100, 60000), 1000),
      heartbeatMs: v.optional(bounded(1000, 30000), 15000),
      maxSubscriptions: v.optional(bounded(1, 1000), 100),
      maxResultBytes: v.optional(bounded(1024, 10485760), 1048576),
    }),
    {},
  ),
  jobs: v.optional(
    v.strictObject({
      maxAttempts: v.optional(bounded(1, jobLimits.maxAttempts), jobLimits.maxAttempts),
      leaseMs: v.optional(milliseconds(1, jobLimits.maxLeaseSeconds), 60000),
      retryBaseMs: v.optional(milliseconds(0, jobLimits.maxRetryDelaySeconds), 1000),
      retentionDays: v.optional(bounded(1, 365), 30),
    }),
    {},
  ),
});
/** Runtime limits for subscriptions, jobs, storage, and authentication. Values are validated and defaulted before the server accepts requests. */
export type RuntimeConfigInput = v.InferInput<typeof runtimeConfigValidator>;
