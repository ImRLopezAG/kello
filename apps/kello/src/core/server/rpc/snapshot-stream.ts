import { AsyncIteratorClass, ORPCError } from "@orpc/server";
import type { createRevisionCoordinator, RevisionEvaluation } from "../realtime/coordinator";

/** Subscribe lazily and retain only the newest authorized snapshot per client. */
export function createSnapshotStream<Value>(options: {
  readonly signal: AbortSignal;
  readonly expiresAt: number | undefined;
  readonly coordinator: ReturnType<typeof createRevisionCoordinator>;
  readonly evaluate: (signal: AbortSignal) => Promise<RevisionEvaluation<Value>>;
}) {
  const { signal } = options;
  let pending: { value: Value } | undefined;
  let failure: Error | undefined;
  let closed = false;
  let wake: (() => void) | undefined;
  let subscription: ReturnType<typeof options.coordinator.subscribe> | undefined;
  const abort = () => {
    void subscription?.unsubscribe();
  };

  function start() {
    signal.throwIfAborted();
    if (!options.expiresAt) throw new ORPCError("UNAUTHORIZED");
    subscription = options.coordinator.subscribe(
      { expiresAt: options.expiresAt },
      {
        evaluate: options.evaluate,
        publish(value) {
          if (closed || signal.aborted) return false;
          pending = { value };
          wake?.();
          return true;
        },
        close(reason, error) {
          closed = true;
          pending = undefined;
          if (reason !== "UNSUBSCRIBED" && reason !== "STOPPED")
            failure =
              error instanceof ORPCError
                ? error
                : new ORPCError(reason === "AUTH_EXPIRED" ? "UNAUTHORIZED" : "INTERNAL_SERVER_ERROR");
          wake?.();
        },
      },
    );
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  }
  return new AsyncIteratorClass<Value, void, void>(
    async () => {
      if (!subscription) start();
      while (!closed && !pending)
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      wake = undefined;
      if (failure) throw failure;
      if (closed || signal.aborted) return { done: true, value: undefined };
      const next = pending;
      pending = undefined;
      if (!next) throw new Error("Missing live snapshot");
      return { done: false, value: next.value };
    },
    async () => {
      closed = true;
      pending = undefined;
      signal.removeEventListener("abort", abort);
      await subscription?.unsubscribe();
      wake?.();
    },
  );
}
