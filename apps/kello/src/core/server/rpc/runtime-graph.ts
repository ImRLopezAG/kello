import { Procedure } from "@orpc/server";
import { createComponentServiceRegistry, ComponentServiceAccessError } from "../components/services";
import type { ComponentServiceFactory } from "../components/services";
import type { PreparedComponentServiceFactory } from "../components/environment";
import { createComponentCallRegistry } from "../components/callers";
import type { AnyProcedure, Middleware, Router } from "@orpc/server";
import { Context } from "effect";
import * as v from "valibot";
import type { AnyRelations } from "drizzle-orm";
import { Invocation } from "../effect/runtime";
import { composeInvocationSignals } from "../invocation-deadline";
import type { createEffectRuntime } from "../effect/runtime";
import { bindRpcDatabaseProcedure, getDatabasePolicy, resolveDatabasePolicy } from "./database";
import type { RpcDatabaseOptions } from "./database";
import { rpcErrorBoundary } from "./procedure";
import type { ProcedureContext } from "./procedure";
import { rpcValue } from "./serialization";
import type { RpcValue } from "./serialization";
import type { RpcAuthorization } from "../auth/rpc-definition";
import { rpcJobCall } from "../jobs/rpc-contracts";
import { withInvocationStorage } from "../storage/invocation";
import { isStreamingProcedure, rpcOutput } from "./stream";
import type { RpcOutput } from "./stream";
import { createStreamLifetime } from "./stream-lifetime";
import type { ComponentHttpInvocation } from "../components/http";
import type { createStorageIntents } from "../storage/intents";
import { searchContractDescriptor } from "../../search/metadata";

export interface RuntimeProcedureEntry {
  readonly path: readonly string[];
  readonly visibility: "public" | "internal" | "exported";
  readonly scope?: string;
  readonly procedure: AnyProcedure;
}
interface ProcedureTree {
  [key: string]: ProcedureTree | AnyProcedure;
}

/** Bind each authored leaf exactly once. Public transports and durable workers
 * receive views of the same compiled graph; internal routes never enter the public view. */
export function bindRuntimeGraph<Relations extends AnyRelations>(options: {
  readonly entries: readonly RuntimeProcedureEntry[];
  readonly exposures?: readonly { readonly scope: string; readonly prefix: string }[] | undefined;
  readonly scopes?:
    | readonly { readonly name: string; readonly dependencies: Readonly<Record<string, string>> }[]
    | undefined;
  readonly database: RpcDatabaseOptions<Relations>;
  readonly databaseForScope?: (scope: string) => RpcDatabaseOptions<Relations>;
  readonly effects: ReturnType<typeof createEffectRuntime<never, never>>;
  readonly activate: (signal: AbortSignal) => Promise<void>;
  readonly authorize: (context: RpcAuthorization) => Promise<void>;
  readonly storage?: ReturnType<typeof createStorageIntents> | undefined;
  readonly storageForScope?: (scope: string) => ReturnType<typeof createStorageIntents> | undefined;
  readonly application?:
    | {
        readonly serviceFactories?: Readonly<Record<string, PreparedComponentServiceFactory>>;
        readonly run: <Result>(work: () => Result) => Result;
        readonly runComponent: <Result>(path: string, work: () => Result) => Result;
      }
    | undefined;
}) {
  const runApplication = options.application?.run ?? (<Result>(work: () => Result): Result => work());
  const streams = createStreamLifetime();
  const declarations = options.application?.serviceFactories ?? {};
  const initializedServices = new Map<string, object>();
  const factories: Record<string, ComponentServiceFactory> = Object.fromEntries(
    Object.entries(declarations).map(([name, factory]) => [
      name,
      () => {
        const dependencies = scopeRouters.get(name)?.dependencies ?? {};
        const components = Object.fromEntries(
          Object.entries(dependencies).map(([alias, target]) => [
            alias,
            Object.freeze({ services: initializedServices.get(target) ?? emptyServices }),
          ]),
        );
        return factory(Object.freeze(components));
      },
    ]),
  );
  const services = createComponentServiceRegistry(options.effects, factories);
  const emptyServices = Object.freeze({});
  const forbiddenServices = new Proxy(
    {},
    {
      get() {
        throw new ComponentServiceAccessError();
      },
    },
  );
  async function initializeService(name: string, ancestors = new Set<string>()): Promise<void> {
    if (!Object.hasOwn(factories, name)) return;
    services.assertAccess();
    if (initializedServices.has(name)) return;
    if (ancestors.has(name)) throw new Error("Cyclic component service dependency");
    const dependencies = scopeRouters.get(name)?.dependencies ?? {};
    await Promise.all(
      Object.values(dependencies).map((target) => initializeService(target, new Set([...ancestors, name]))),
    );
    initializedServices.set(name, await services.get(name));
  }
  async function serviceContext(scopeName: string) {
    const scope = scopeRouters.get(scopeName);
    if (!scope) throw new Error("Unknown component service scope");
    const names = [scopeName, ...Object.values(scope.dependencies)].filter((name) => Object.hasOwn(factories, name));
    if (services.canAccess()) await Promise.all(names.map((name) => initializeService(name)));
    const value = (name: string) =>
      !Object.hasOwn(factories, name) ? emptyServices : services.canAccess() ? services.ready(name) : forbiddenServices;
    return { local: value(scopeName), dependency: value };
  }
  function createTree(): ProcedureTree {
    const node: ProcedureTree = {};
    Object.setPrototypeOf(node, null);
    return node;
  }
  const publicRouter = createTree();
  const internal = [];
  const scopeRouters = new Map(
    (options.scopes ?? [{ name: "", dependencies: {} }]).map((scope) => [
      scope.name,
      { ...scope, internal: createTree(), exported: createTree() },
    ]),
  );
  if (scopeRouters.size !== (options.scopes?.length ?? 1)) throw new Error("Duplicate component caller scope");
  if (!scopeRouters.has("")) throw new Error("Application caller scope is missing");
  const exposedPrefixes = new Set<string>();
  for (const exposure of options.exposures ?? []) {
    v.parse(rpcJobCall.entries.path, [exposure.prefix]);
    if (!exposure.scope || !scopeRouters.has(exposure.scope)) throw new Error("Unknown public component scope");
    if (
      exposedPrefixes.has(exposure.prefix) ||
      options.entries.some(
        (entry) => !entry.scope && entry.visibility === "public" && entry.path[0] === exposure.prefix,
      )
    )
      throw new Error("Conflicting public component prefix");
    if (!options.entries.some((entry) => entry.scope === exposure.scope && entry.visibility === "exported"))
      throw new Error("Component has no exported RPCs");
    exposedPrefixes.add(exposure.prefix);
  }
  const paths = new Set<string>();
  function insert(tree: ProcedureTree, path: readonly string[], procedure: AnyProcedure) {
    let node = tree;
    for (const segment of path.slice(0, -1)) {
      const child = node[segment];
      if (child instanceof Procedure) throw new Error("Procedure path collides with a router");
      node = child ?? (node[segment] = createTree());
    }
    const last = path.at(-1);
    if (!last || node[last]) throw new Error("Duplicate procedure path");
    node[last] = procedure;
  }
  for (const entry of options.entries) {
    const scopeName = entry.scope ?? "";
    const scope = scopeRouters.get(scopeName);
    if (!scope) throw new Error("Unknown procedure scope");
    const run = scopeName
      ? <Result>(work: () => Result): Result => {
          if (!options.application) throw new Error("Component application scope is missing");
          return options.application.runComponent(scopeName, work);
        }
      : runApplication;
    const path = v.parse(rpcJobCall.entries.path, entry.path);
    const key = JSON.stringify([scopeName, entry.visibility, path]);
    if (paths.has(key)) throw new Error("Duplicate procedure path");
    paths.add(key);
    const database = { ...(options.databaseForScope?.(scopeName) ?? options.database), scope: scopeName };
    const policy = searchContractDescriptor(entry.procedure) ? "read" : getDatabasePolicy(entry.procedure);
    const streaming = isStreamingProcedure(entry.procedure);
    const supplyServices: Middleware<ProcedureContext, object, RpcValue, RpcOutput, Record<never, never>> = async ({
      context,
      next,
    }) => {
      const prepared = await serviceContext(scopeName);
      // SAFETY: own installs exactly this scope's validated caller capabilities before dispatch.
      const calls = context as ProcedureContext & {
        readonly components: Readonly<Record<string, { readonly rpc: object }>>;
      };
      const components = Object.fromEntries(
        Object.entries(calls.components).map(([alias, capability]) => [
          alias,
          Object.freeze({
            ...capability,
            services: prepared.dependency(scope.dependencies[alias]!),
          }),
        ]),
      );
      return next({ context: { services: prepared.local, components: Object.freeze(components) } });
    };
    const authored = entry.procedure["~orpc"];
    const serviceBound = new Procedure({
      ...authored,
      orderedMiddlewares: [
        {
          middleware: supplyServices,
          inputSchemasLengthAtUse: authored.inputSchemas
            ? Array.isArray(authored.inputSchemas)
              ? authored.inputSchemas.length
              : 1
            : 0,
          outputSchemasLengthAtUse: 0,
        },
        ...authored.orderedMiddlewares,
      ],
    });
    const bound = policy ? bindRpcDatabaseProcedure(serviceBound, database) : serviceBound;
    const definition = bound["~orpc"];
    const own: Middleware<ProcedureContext, object, RpcValue, RpcOutput, Record<never, never>> = (
      { context, signal, next },
      input,
    ) =>
      run(() =>
        options.effects.promise(
          context,
          (invocation) =>
            services.run(streaming ? "live" : policy && policy !== "automatic" ? "retryable" : "allowed", async () => {
              await options.activate(invocation.signal);
              if (!policy) {
                await options.authorize({
                  ...context,
                  signal: invocation.signal,
                  path,
                  input: v.parse(rpcValue, input),
                });
              }
              const storagePolicy =
                policy === "automatic" && resolveDatabasePolicy(policy, context, streaming) === "write"
                  ? "single-attempt-write"
                  : resolveDatabasePolicy(policy, context, streaming);
              const execute = () =>
                callers.run(scopeName, { ...context, signal: invocation.signal }, (calls) =>
                  withInvocationStorage(
                    invocation,
                    options.storageForScope?.(scopeName) ?? (scopeName ? undefined : options.storage),
                    storagePolicy,
                    async () => {
                      return next({
                        context: {
                          ...calls,
                          signal: invocation.signal,
                          "effect/context": Context.add(context["effect/context"], Invocation, {
                            ...context,
                            signal: invocation.signal,
                          }),
                        },
                      });
                    },
                  ),
                );
              const result = await execute();
              return {
                ...result,
                output: await streams.own(v.parse(rpcOutput, result.output), invocation.signal, run),
              };
            }),
          signal ? composeInvocationSignals([signal, context.signal]) : context.signal,
        ),
      );
    // Validation still precedes acquisition. Database binding already moves all
    // input stages ahead of its transaction, and finite output stages stay inside it.
    const inputCount = definition.inputSchemas
      ? Array.isArray(definition.inputSchemas)
        ? definition.inputSchemas.length
        : 1
      : 0;
    const ownProcedure = (procedure: AnyProcedure) => {
      const owned = new Procedure({
        ...procedure["~orpc"],
        orderedMiddlewares: [
          { middleware: rpcErrorBoundary, inputSchemasLengthAtUse: inputCount, outputSchemasLengthAtUse: 0 },
          { middleware: own, inputSchemasLengthAtUse: inputCount, outputSchemasLengthAtUse: 0 },
          ...procedure["~orpc"].orderedMiddlewares.map((middleware) => ({
            ...middleware,
            inputSchemasLengthAtUse: inputCount,
          })),
        ],
      });
      return owned;
    };
    const owned = ownProcedure(bound);
    if (entry.visibility === "internal") {
      internal.push(scopeName ? { path, procedure: owned, scope: scopeName } : { path, procedure: owned });
      insert(scope.internal, path, owned);
    } else if (entry.visibility === "exported") {
      insert(scope.exported, path, owned);
      for (const exposure of options.exposures ?? []) {
        if (exposure.scope !== scopeName) continue;
        const projected = v.parse(rpcJobCall.entries.path, [exposure.prefix, ...path]);
        insert(publicRouter, projected, owned);
      }
    } else {
      if (scopeName) throw new Error("Component public routes require an explicit projection");
      insert(publicRouter, path, owned);
    }
  }
  const callers = createComponentCallRegistry([...scopeRouters.values()]);
  const router: Router<ProcedureContext> = publicRouter;
  async function invokeComponentHttp<Result>(
    scopeName: string,
    invocation: ComponentHttpInvocation,
    work: (
      context: ProcedureContext & { readonly internal: object; readonly components: object; readonly services: object },
    ) => Promise<Result>,
  ): Promise<Result> {
    if (!scopeName || !scopeRouters.has(scopeName) || !options.application)
      throw new Error("Unknown component HTTP scope");
    const baseContext = {
      identity: invocation.session?.identity ?? null,
      requestId: crypto.randomUUID(),
      signal: invocation.signal,
    };
    const context = invocation.session ? { ...baseContext, expiresAt: invocation.session.expiresAt } : baseContext;
    return options.application.runComponent(scopeName, () =>
      options.effects.promise(
        context,
        async (owned) =>
          services.run("allowed", async () => {
            await options.activate(owned.signal);
            const prepared = await serviceContext(scopeName);
            return callers.run(
              scopeName,
              { ...context, signal: owned.signal, "effect/context": Context.make(Invocation, owned) },
              async (calls) => {
                const dependencies = scopeRouters.get(scopeName)!.dependencies;
                const components = Object.freeze(
                  Object.fromEntries(
                    Object.entries(calls.components).map(([alias, capability]) => [
                      alias,
                      Object.freeze({ ...capability, services: prepared.dependency(dependencies[alias]!) }),
                    ]),
                  ),
                );
                return work({
                  ...context,
                  signal: owned.signal,
                  "effect/context": Context.make(Invocation, owned),
                  ...calls,
                  components,
                  services: prepared.local,
                });
              },
            );
          }),
        invocation.signal,
      ),
    );
  }
  return Object.freeze({
    router,
    internal: Object.freeze(internal),
    invokeComponentHttp,
    stop: streams.stop,
  });
}
