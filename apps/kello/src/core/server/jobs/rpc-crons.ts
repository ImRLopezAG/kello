import * as v from "valibot";
import { cronScheduleValidator, createDurableCronDispatcher } from "./durable-crons";
import type { DurableCronDispatcherOptions, CronEnqueue } from "./durable-crons";
import { rpcJobCall } from "./rpc-contracts";
import { scheduleOptions } from "./contracts";
import type { createRpcJobQueue } from "./rpc-queue";

export const rpcCronValidator = v.strictObject({
  schedule: cronScheduleValidator,
  call: rpcJobCall,
  maxAttempts: scheduleOptions.entries.maxAttempts,
  retryDelaySeconds: v.optional(scheduleOptions.entries.retryDelaySeconds.wrapped),
});
export type RpcCronDefinition = v.InferOutput<typeof rpcCronValidator>;

/** Provider-verified native cron work retains the existing delivery receipts and
 * occurrence deduplication. The queue verifies the compiled internal path. */
export function createRpcCronDispatcher(
  options: Omit<DurableCronDispatcherOptions, "crons"> & {
    readonly queue: Pick<ReturnType<typeof createRpcJobQueue>, "enqueue">;
    readonly crons: Readonly<Record<string, RpcCronDefinition>>;
  },
) {
  const queue = options.queue;
  const crons = new Map<string, CronEnqueue>();
  for (const [name, input] of Object.entries(options.crons)) {
    const configured = v.parse(rpcCronValidator, structuredClone(input));
    crons.set(name, (transaction, dueAt, deduplicationKey) =>
      queue.enqueue(transaction, configured.call, null, {
        dueAt,
        deduplicationKey,
        maxAttempts: configured.maxAttempts,
        retryDelaySeconds: configured.retryDelaySeconds,
      }),
    );
  }
  return createDurableCronDispatcher({ ...options, crons });
}
