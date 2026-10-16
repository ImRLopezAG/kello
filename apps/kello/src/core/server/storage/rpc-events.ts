import * as v from "valibot";
import { createDurableStorageEventDispatcher } from "./durable-events";
import type { DurableStorageEventOptions, StorageEventEnqueue } from "./durable-events";
import { encodeRpcJobCall, rpcJobCall } from "../jobs/rpc-contracts";
import { scheduleOptions } from "../jobs/contracts";
import type { createRpcJobQueue } from "../jobs/rpc-queue";

export const rpcStorageHandlerValidator = v.strictObject({
  path: rpcJobCall.entries.path,
  scope: rpcJobCall.entries.scope,
  maxAttempts: scheduleOptions.entries.maxAttempts,
  retryDelaySeconds: v.optional(scheduleOptions.entries.retryDelaySeconds.wrapped),
});
export type RpcStorageHandler = v.InferOutput<typeof rpcStorageHandlerValidator>;

/** Compiled internal paths use the same durable receipt, intent verification and
 * null service identity as legacy events. Uploaded-by remains explicit event data. */
export function createRpcStorageEventDispatcher(
  options: Omit<DurableStorageEventOptions, "handlers"> & {
    readonly version: string;
    readonly queue: Pick<ReturnType<typeof createRpcJobQueue>, "enqueue">;
    readonly handlers: Readonly<Record<string, RpcStorageHandler>>;
  },
) {
  const { queue, version } = options;
  const handlers = new Map<string, StorageEventEnqueue>();
  for (const [bucket, input] of Object.entries(options.handlers)) {
    const handler = v.parse(rpcStorageHandlerValidator, structuredClone(input));
    handlers.set(bucket, (transaction, event, dueAt, deduplicationKey) =>
      queue.enqueue(transaction, encodeRpcJobCall(version, handler.path, event, handler.scope), null, {
        dueAt,
        deduplicationKey,
        maxAttempts: handler.maxAttempts,
        retryDelaySeconds: handler.retryDelaySeconds,
      }),
    );
  }
  return createDurableStorageEventDispatcher({ ...options, handlers });
}
