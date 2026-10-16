import { isAsyncIteratorObject, wrapAsyncIterator } from "@orpc/shared";
import type { RpcOutput } from "./stream";
import type { RpcValue } from "./serialization";

/** Own iterators until completion, cancellation or runtime shutdown. The native
 * wrapper serializes next/return and restores the application's environment. */
export function createStreamLifetime() {
  const active = new Set<AsyncIteratorObject<RpcValue, RpcValue>>();
  const pending = new Set<Promise<unknown>>();
  let stopped = false;
  let stopping: Promise<void> | undefined;

  async function own(
    output: RpcOutput,
    signal: AbortSignal,
    run: <Result>(work: () => Result) => Result,
  ): Promise<RpcOutput> {
    if (!isAsyncIteratorObject(output)) return output;
    if (stopped || signal.aborted) {
      await run(() => output.return?.());
      throw new Error("Stream invocation stopped");
    }
    const stream = wrapAsyncIterator(output, {
      runWith(work) {
        const result = run(work).finally(() => pending.delete(result));
        pending.add(result);
        return result;
      },
      mapResult(result) {
        signal.throwIfAborted();
        return result;
      },
      onFinish() {
        signal.removeEventListener("abort", abort);
        active.delete(stream);
      },
    });
    const abort = () => {
      // The transport already observes cancellation. Cleanup failures must not
      // become unhandled rejections or expose their private causes.
      void stream.return().catch(() => undefined);
    };
    active.add(stream);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    return stream;
  }

  function stop(): Promise<void> {
    if (stopping) return stopping;
    stopped = true;
    stopping = Promise.allSettled([...active].map(async (stream) => stream.return?.())).then(async () => {
      // Native return can finish while a prior next/return still owns cleanup.
      await Promise.allSettled(pending);
    });
    return stopping;
  }
  return Object.freeze({ own, stop });
}
