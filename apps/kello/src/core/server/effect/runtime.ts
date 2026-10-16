import { Context, Effect, Exit, Layer, ManagedRuntime, Scope } from "effect";
import type { InvocationContext } from "../auth/context";
import { captureJobInvocation } from "../auth/context";
import { publishRuntimeMetric } from "../observability";
import { composeInvocationSignals } from "../invocation-deadline";

export class Invocation extends Context.Service<Invocation, InvocationContext>()("kello/Invocation") {}
export class Diagnostics extends Context.Service<Diagnostics, typeof publishRuntimeMetric>()("kello/Diagnostics") {}
export type InvocationInput = Omit<InvocationContext, "signal">;
class GenerationScope extends Context.Service<GenerationScope, Scope.Closeable>()("kello/GenerationScope") {}

/** Owns shared services; every call receives an isolated, scoped invocation. */
export function createEffectRuntime<Services, Failure>(layer: Layer.Layer<Services, Failure>) {
  const generation = Layer.effect(
    GenerationScope,
    Effect.acquireRelease(Scope.make(), (scope) => Scope.close(scope, Exit.void)),
  );
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(layer, generation, Layer.succeed(Diagnostics, publishRuntimeMetric)),
  );
  const shutdown = new AbortController();
  const pending = new Set<Promise<unknown>>();
  let stopped = false;
  let stopping: Promise<void> | undefined;

  function assertActive(): void {
    if (stopped) throw new Error("Runtime stopped");
  }

  /** Acquisition is generation-owned, never interrupted by an individual waiter. */
  function acquireShared<Value, Failure>(
    operation: Effect.Effect<Value, Failure, Scope.Scope>,
  ): Promise<Exit.Exit<Value, Failure>> {
    if (stopped) return Promise.reject(new Error("Runtime stopped"));
    const work = runtime
      .runPromise(
        Effect.gen(function* () {
          const parent = yield* GenerationScope;
          const scope = yield* Scope.fork(parent);
          const result = yield* Effect.exit(Effect.provideService(operation, Scope.Scope, scope));
          if (Exit.isFailure(result)) yield* Scope.close(scope, result);
          return result;
        }),
        { signal: shutdown.signal },
      )
      .finally(() => pending.delete(work));
    pending.add(work);
    return work;
  }

  function run<Value, Error>(
    input: InvocationInput,
    operation: Effect.Effect<Value, Error, Services | Invocation | Diagnostics | Scope.Scope>,
    signal?: AbortSignal,
  ): Promise<Value> {
    if (stopped) return Promise.reject(new globalThis.Error("Runtime stopped"));
    const current = signal ? composeInvocationSignals([signal, shutdown.signal]) : shutdown.signal;
    const context: InvocationContext = Object.freeze({
      identity: input.identity ? Object.freeze({ ...input.identity }) : null,
      requestId: input.requestId,
      job: captureJobInvocation(input.job),
      signal: current,
    });
    const work = runtime
      .runPromise(Effect.scoped(Effect.provideService(operation, Invocation, context)), { signal: current })
      .finally(() => pending.delete(work));
    pending.add(work);
    return work;
  }

  function promise<Value>(
    input: InvocationInput,
    operation: (context: InvocationContext) => Promise<Value>,
    signal?: AbortSignal,
  ): Promise<Value> {
    return run(
      input,
      Effect.gen(function* () {
        const context = yield* Invocation;
        // pg cannot abort every in-flight query. Wait for the operation's rollback and
        // client release before interruption completes or shared resources are disposed.
        return yield* Effect.uninterruptible(
          Effect.tryPromise({
            try: async () => {
              context.signal.throwIfAborted();
              const value = await operation(context);
              context.signal.throwIfAborted();
              return value;
            },
            catch: (cause) => cause,
          }),
        );
      }),
      signal,
    );
  }

  function stop(): Promise<void> {
    if (stopping) return stopping;
    stopped = true;
    shutdown.abort();
    stopping = Promise.resolve().then(async () => {
      await Promise.allSettled(pending);
      await runtime.dispose();
    });
    return stopping;
  }
  return Object.freeze({ run, promise, acquireShared, assertActive, stop });
}
