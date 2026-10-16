import { AsyncLocalStorage } from "node:async_hooks";
import { Effect, Exit } from "effect";
import * as v from "valibot";
import type { Scope } from "effect";
import type { createEffectRuntime } from "../effect/runtime";
import type { ResolvedComponentServices } from "./definition";

const serviceObject = v.union([v.object({}), v.function()]);

export type ComponentServiceFactory = () => object | Promise<object> | Effect.Effect<object, unknown, Scope.Scope>;
export type ComponentServiceValue<Factory extends ComponentServiceFactory> = ResolvedComponentServices<
  ReturnType<Factory>
>;
export type ComponentServiceFailure<Factory extends ComponentServiceFactory> =
  ReturnType<Factory> extends Effect.Effect<object, infer Failure, Scope.Scope> ? Failure : unknown;
export type ComponentServiceOverrides<Factories extends Record<string, ComponentServiceFactory>> = {
  readonly [Key in keyof Factories]?: ComponentServiceValue<Factories[Key]>;
};
export type ComponentServicePolicy = "allowed" | "retryable" | "live";
export class ComponentServiceAccessError extends Error {
  constructor() {
    super("Component services require a non-retryable invocation");
    this.name = "ComponentServiceAccessError";
  }
}

/** Construct outside invocation context, once for each active runtime generation. */
export function createComponentServiceRegistry<const Factories extends Record<string, ComponentServiceFactory>>(
  runtime: Pick<ReturnType<typeof createEffectRuntime<never, never>>, "acquireShared" | "assertActive">,
  factories: Factories,
  overrides: ComponentServiceOverrides<Factories> = {},
) {
  const initialization = AsyncLocalStorage.snapshot();
  const policy = new AsyncLocalStorage<{ readonly policy: ComponentServicePolicy; active: boolean }>();
  const ready = new Map<string, object>();
  const pending = new Map<string, Promise<Exit.Exit<object, unknown>>>();
  const declarations = Object.freeze({ ...factories });
  const replacements = Object.freeze({ ...overrides });

  function assertAccess() {
    runtime.assertActive();
    const current = policy.getStore();
    if (!current?.active || current.policy !== "allowed") throw new ComponentServiceAccessError();
  }

  function acquire(name: string): Promise<Exit.Exit<object, unknown>> {
    assertAccess();
    const cached = pending.get(name);
    if (cached) return cached;
    if (!Object.hasOwn(declarations, name)) throw new Error("Unknown component service");
    const factory = declarations[name];
    if (!factory) throw new Error("Unknown component service");
    const work = initialization(() =>
      runtime.acquireShared(
        Effect.suspend(() => {
          if (Object.hasOwn(replacements, name)) {
            const replacement = replacements[name];
            if (!v.is(serviceObject, replacement)) return Effect.die(new Error("Invalid component service override"));
            return Effect.succeed(replacement);
          }
          const result = factory();
          // SAFETY: ComponentServiceFactory permits only Scope as an Effect requirement.
          const acquisition = Effect.isEffect(result)
            ? (result as Effect.Effect<object, unknown, Scope.Scope>)
            : Effect.tryPromise({ try: () => Promise.resolve(result), catch: (error) => error });
          return acquisition.pipe(
            Effect.flatMap((value) =>
              v.is(serviceObject, value)
                ? Effect.succeed(value)
                : Effect.die(new Error("Component service factory must return an object")),
            ),
          );
        }),
      ),
    );
    pending.set(name, work);
    void work.then(
      (result) => {
        if (Exit.isFailure(result)) pending.delete(name);
        else ready.set(name, result.value);
      },
      () => pending.delete(name),
    );
    return work;
  }

  function getEffect<Key extends keyof Factories & string>(
    name: Key,
  ): Effect.Effect<
    ComponentServiceValue<Factories[Key]>,
    ComponentServiceFailure<Factories[Key]> | ComponentServiceAccessError
  > {
    // SAFETY: each cache entry comes only from the factory or typed override at this key.
    return Effect.suspend(() => {
      try {
        const work = acquire(name);
        return Effect.promise(() => work).pipe(
          Effect.flatMap((result) =>
            Exit.isSuccess(result) ? Effect.succeed(result.value) : Effect.failCause(result.cause),
          ),
        );
      } catch (error) {
        return error instanceof ComponentServiceAccessError ? Effect.fail(error) : Effect.die(error);
      }
    }) as Effect.Effect<
      ComponentServiceValue<Factories[Key]>,
      ComponentServiceFailure<Factories[Key]> | ComponentServiceAccessError
    >;
  }

  return Object.freeze({
    assertAccess,
    canAccess(): boolean {
      const current = policy.getStore();
      return current?.active === true && current.policy === "allowed";
    },
    getEffect,
    ready<Key extends keyof Factories & string>(name: Key): ComponentServiceValue<Factories[Key]> {
      assertAccess();
      const value = ready.get(name);
      if (!value) throw new Error("Component service is not initialized");
      // SAFETY: successful acquisition stores the exact value declared at this key.
      return value as ComponentServiceValue<Factories[Key]>;
    },
    get<Key extends keyof Factories & string>(name: Key): Promise<ComponentServiceValue<Factories[Key]>> {
      return Effect.runPromise(getEffect(name));
    },
    run<Result>(invocationPolicy: ComponentServicePolicy, work: () => Promise<Result>): Promise<Result> {
      runtime.assertActive();
      const parent = policy.getStore();
      const effectivePolicy = parent && parent.policy !== "allowed" ? parent.policy : invocationPolicy;
      const lifetime = { policy: effectivePolicy, active: true };
      return policy.run(lifetime, async () => {
        try {
          return await work();
        } finally {
          lifetime.active = false;
        }
      });
    },
  });
}
