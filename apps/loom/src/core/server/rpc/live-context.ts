import { AsyncLocalStorage } from "node:async_hooks";
import type { RpcValue } from "./serialization";

interface LiveInvocation {
  readonly snapshot: boolean;
  readonly start: () => AsyncIteratorObject<RpcValue, void>;
  used: boolean;
}
const invocation = new AsyncLocalStorage<LiveInvocation>();
const evaluation = new AsyncLocalStorage<symbol>();

export function evaluateLiveSnapshot<Result>(target: symbol, work: () => Result): Result {
  return evaluation.run(target, work);
}

export async function withLiveInvocation<Result>(
  start: LiveInvocation["start"],
  work: () => Promise<Result>,
): Promise<Result> {
  // Nested generated live reads share the already-owned evaluation. They must
  // not start a second subscription with unrelated transaction evidence.
  const scope: LiveInvocation = { snapshot: evaluation.getStore() !== undefined, start, used: false };
  const result = await invocation.run(scope, work);
  if (scope.snapshot && !scope.used) throw new Error("Live reevaluation must return context.live's snapshot");
  return result;
}

/** The callback runs inside each fresh, authorized database snapshot. The full
 * handler is reevaluated so its input and middleware context cannot become stale. */
export function createLiveContext<Context extends object>(context: Context) {
  return async function live<Value extends RpcValue>(
    read: (context: Context) => Value | Promise<Value>,
  ): Promise<AsyncIteratorObject<Value, void>> {
    return liveSnapshot(() => read(context));
  };
}

/** Shared by context.live and generated search.watch; each evaluation invokes
 * the handler again before reading within its newly authorized snapshot. */
export async function liveSnapshot<Value>(
  read: () => Value | Promise<Value>,
): Promise<AsyncIteratorObject<Value, void>> {
  const scope = invocation.getStore();
  if (!scope) throw new Error("context.live requires an explicit streaming contract");
  if (scope.used) throw new Error("Use one context.live call per streaming handler");
  scope.used = true;
  if (!scope.snapshot) {
    // SAFETY: reevaluation invokes this same handler and validates every yielded
    // snapshot against its native contract before publication.
    return scope.start() as AsyncIteratorObject<Value, void>;
  }
  const value = await read();
  return (async function* () {
    yield value;
  })();
}
