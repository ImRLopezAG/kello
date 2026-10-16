import * as v from "valibot";
import { ownNestedRpcWork } from "../rpc/database";
import { validateComponentName } from "./graph";
import { AsyncLocalStorage } from "node:async_hooks";
import { createProcedureClient, Procedure } from "@orpc/server";
import type { AnyProcedure, RouterClient } from "@orpc/server";
import type { SearchRouterClient } from "../../client/search-types";
import type { ProcedureContext } from "../rpc/procedure";

export interface ComponentProcedureTree {
  readonly [key: string]: ComponentProcedureTree | AnyProcedure;
}

export interface ComponentCallScope {
  readonly name: string;
  readonly internal: ComponentProcedureTree;
  readonly exported: ComponentProcedureTree;
  readonly dependencies: Readonly<Record<string, string>>;
}
interface CallLifetime {
  active: boolean;
  readonly context: ProcedureContext;
}
const invocation = new AsyncLocalStorage<CallLifetime>();

/** Snapshot registries before serving so later user mutation cannot widen access. */
function copyRouter(router: ComponentProcedureTree, ancestors = new Set<object>()): ComponentProcedureTree {
  if (ancestors.has(router)) throw new Error("Cyclic component caller router");
  ancestors.add(router);
  const copy: Record<string, ComponentProcedureTree | AnyProcedure> = {};
  Object.setPrototypeOf(copy, null);
  for (const [key, child] of Object.entries(router)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(key) || ["constructor", "prototype", "__proto__", "then"].includes(key))
      throw new Error("Invalid component caller path");
    copy[key] = child instanceof Procedure ? child : copyRouter(child, ancestors);
  }
  ancestors.delete(router);
  return Object.freeze(copy);
}

type ScopedCalls<Scope extends ComponentCallScope, All extends ComponentCallScope> = {
  readonly internal: SearchRouterClient<RouterClient<Scope["internal"]>>;
  readonly components: {
    readonly [Key in keyof Scope["dependencies"]]: {
      readonly rpc: SearchRouterClient<
        RouterClient<Extract<All, { readonly name: Scope["dependencies"][Key] }>["exported"]>
      >;
    };
  };
};

export function createComponentCallRegistry<const Scopes extends readonly ComponentCallScope[]>(scopes: Scopes) {
  const registry = new Map<string, ComponentCallScope>();
  for (const scope of scopes) {
    if (registry.has(scope.name)) throw new Error("Duplicate component caller scope");
    registry.set(
      scope.name,
      Object.freeze({
        name: scope.name,
        internal: copyRouter(scope.internal),
        exported: copyRouter(scope.exported),
        dependencies: Object.freeze({ ...scope.dependencies }),
      }),
    );
  }
  for (const scope of registry.values()) {
    for (const [alias, name] of Object.entries(scope.dependencies)) {
      validateComponentName(alias);
      if (alias === "then") throw new Error("Invalid component caller dependency");
      if (!registry.has(name) || name === scope.name) throw new Error("Invalid component caller dependency");
    }
  }
  function caller(
    router: ComponentProcedureTree,
    lifetime: CallLifetime,
    path: readonly string[] = [],
  ): RouterClient<ComponentProcedureTree> {
    const cache = new Map<string, RouterClient<ComponentProcedureTree> | RouterClient<AnyProcedure>>();
    // Native oRPC validation starts asynchronously. The leaf wrapper registers
    // pending work synchronously so an unawaited child cannot escape its transaction.
    return new Proxy(
      {},
      {
        get(_target, key) {
          if (!v.is(v.string(), key) || !Object.hasOwn(router, key)) return undefined;
          const cached = cache.get(key);
          if (cached) return cached;
          const entry = router[key];
          if (!entry) return undefined;
          const client =
            entry instanceof Procedure
              ? (() => {
                  const native = createProcedureClient(entry, {
                    path: [...path, key],
                    context: () => lifetime.context,
                  });
                  return (...args: Parameters<typeof native>) =>
                    ownNestedRpcWork(async () => {
                      if (!lifetime.active || invocation.getStore() !== lifetime)
                        throw new Error("Component caller is inactive");
                      lifetime.context.signal.throwIfAborted();
                      return native(...args);
                    });
                })()
              : caller(entry, lifetime, [...path, key]);
          cache.set(key, client);
          return client;
        },
      },
    );
  }
  return Object.freeze({
    async run<const Name extends Scopes[number]["name"], Result>(
      name: Name,
      context: ProcedureContext,
      work: (calls: ScopedCalls<Extract<Scopes[number], { readonly name: Name }>, Scopes[number]>) => Promise<Result>,
    ): Promise<Result> {
      const scope = registry.get(name);
      if (!scope) throw new Error("Unknown component caller scope");
      const lifetime: CallLifetime = { active: true, context: Object.freeze({ ...context }) };
      const components: Record<string, { readonly rpc: RouterClient<ComponentProcedureTree> }> = {};
      Object.setPrototypeOf(components, null);
      for (const [key, target] of Object.entries(scope.dependencies)) {
        const dependency = registry.get(target);
        if (!dependency) throw new Error("Unknown component caller dependency");
        Object.defineProperty(components, key, {
          value: Object.freeze({ rpc: caller(dependency.exported, lifetime) }),
          enumerable: true,
        });
      }
      return invocation.run(lifetime, async () => {
        try {
          // SAFETY: registry keys and dependency targets were validated above;
          // each native client is built from the exact corresponding router.
          const calls = {
            internal: caller(scope.internal, lifetime),
            components: Object.freeze(components),
          } as ScopedCalls<Extract<Scopes[number], { readonly name: Name }>, Scopes[number]>;
          return await work(calls);
        } finally {
          lifetime.active = false;
        }
      });
    },
  });
}
