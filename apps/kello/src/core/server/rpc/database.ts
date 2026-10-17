import { AsyncLocalStorage } from "node:async_hooks";
import { call, defineMeta, os, Procedure, ORPCError } from "@orpc/server";
import type { AnySchema, ErrorMap, Middleware, InferSchemaInput } from "@orpc/server";
import type { AnyRelations } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as v from "valibot";
import { Context } from "effect";
import { composeInvocationSignals } from "../invocation-deadline";
import type { DatabaseConnection } from "../database/connection";
import { captureInvocationGuard, hasDatabaseInvocation } from "../database/connection";
import { scopedDatabase } from "../database/context";
import { bindDatabaseIdentity } from "../auth/context";
import { runFunctionTransaction } from "../transactions";
import type { IdempotencyOptions } from "../idempotency";
import { validateIdempotencyOptions } from "../idempotency";
import { rpcErrorBoundary } from "./procedure";
import type { ProcedureContext } from "./procedure";
import { rpcValue, serializeRpcValue, deserializeRpcValue } from "./serialization";
import type { RpcValue } from "./serialization";
import { isStreamingProcedure, rpcOutput, validateRpcOutput } from "./stream";
import type { RpcOutput } from "./stream";
import { prepareRpcReplay } from "./replay";
import type { SchemaDefinition } from "../../schema/define-schema";
import { isNativeRelations, validateSchemaRelations } from "../database/relations";
import { RpcSchedulerService, createProjectServices, Storage } from "../effect/services";
import { invocationStorage } from "../storage/invocation";
import { RateLimits, invocationRateLimits } from "../rate-limits/service";

import type { RpcScheduler } from "../jobs/rpc-scheduler";
import { Diagnostics } from "../effect/runtime";
import { publishRuntimeMetric } from "../observability";
import { createSearchValidators } from "../../search/contract";
import { searchContractDescriptor } from "../../search/metadata";
import { liveQueryRows } from "../../realtime/contract";
import { createSearchContext, withSearchInvocation, validateSearchHandlerOutput } from "../../search/executor";
import { validSearchSelection } from "../../search/public";
import type { SearchPublicSelection } from "../../search/public";

const unavailableScheduler: RpcScheduler = Object.freeze({
  runAt: () =>
    ownRpcDatabaseWork(async () => {
      throw new Error("Scheduler is not configured");
    }),
  runAfter: () =>
    ownRpcDatabaseWork(async () => {
      throw new Error("Scheduler is not configured");
    }),
});

export type DatabasePolicy = "read" | "write";
const [databasePolicy, readDatabasePolicy] = defineMeta(
  "kello.databasePolicy",
  (incoming: DatabasePolicy | "automatic") => incoming,
);
const middlewarePolicies = new WeakMap<object, DatabasePolicy | "automatic">();

export function getDatabasePolicy(
  procedure: Parameters<typeof readDatabasePolicy>[0] & {
    readonly "~orpc": { readonly orderedMiddlewares?: readonly { readonly middleware: object }[] };
  },
): DatabasePolicy | "automatic" | undefined {
  // Native contract implementers retain middleware identity but intentionally do
  // not merge its metadata into the contract. Keep this runtime capability local.
  const policies = new Set(
    procedure["~orpc"].orderedMiddlewares
      ?.map(({ middleware }) => middlewarePolicies.get(middleware))
      .filter((policy) => policy !== undefined),
  );
  if (policies.size > 1) throw new Error("Conflicting database policies");
  return policies.values().next().value ?? readDatabasePolicy(procedure);
}

export function resolveDatabasePolicy(
  binding: ReturnType<typeof getDatabasePolicy>,
  context: ProcedureContext,
  streaming = false,
): DatabasePolicy | undefined {
  if (binding !== "automatic") return binding;
  if (streaming) return "read";
  return context.operation && ["query", "infinite", "streamed", "live"].includes(context.operation) ? "read" : "write";
}
interface ActiveDatabase {
  readonly db: NodePgDatabase;
  readonly policy: DatabasePolicy;
  readonly automatic: boolean;
  readonly invocation: symbol;
  readonly requestId: string;
  readonly connection: object;
  readonly identity: ProcedureContext["identity"];
  readonly assertCurrent: () => void;
  readonly scheduler: RpcScheduler;
  readonly pending: Set<Promise<void>>;
  active: boolean;
  failure?: Error;
}
const currentDatabase = new AsyncLocalStorage<ActiveDatabase>();
const currentScheduler = new AsyncLocalStorage<RpcScheduler>();

/** Independent admission cannot run within any database invocation, including reads. */
export function assertOutsideRpcDatabase(): void {
  const active = currentDatabase.getStore();
  if (!active && !hasDatabaseInvocation()) return;
  active?.assertCurrent();
  const failure = new ORPCError("FORBIDDEN", { message: "Attempt admission requires a non-database procedure" });
  if (active) active.failure ??= failure;
  throw failure;
}

/** Scheduling uses the same guarded transaction and cannot escape its lifetime.
 * A caught scheduling error still aborts the owning database attempt. */
export function ownRpcDatabaseWork<T>(
  work: (db: NodePgDatabase, identity: ProcedureContext["identity"]) => Promise<T>,
  expected?: Pick<ProcedureContext, "requestId" | "identity">,
): Promise<T> {
  const active = currentDatabase.getStore();
  if (!active?.active || active.policy !== "write")
    return Promise.reject(new Error("Scheduling requires database-write authority"));
  active.assertCurrent();
  const result = (async () => {
    active.assertCurrent();
    if (expected && (expected.requestId !== active.requestId || expected.identity !== active.identity))
      throw new Error("Database belongs to a different invocation");
    return work(active.db, active.identity);
  })();
  return trackDatabaseWork(active, result);
}

function trackDatabaseWork<T>(active: ActiveDatabase, result: Promise<T>): Promise<T> {
  const tracked = result
    .then(
      () => undefined,
      (cause) => {
        active.failure ??= cause instanceof Error ? cause : new Error("Database work failed");
      },
    )
    .finally(() => active.pending.delete(tracked));
  active.pending.add(tracked);
  return result;
}

/** Register synchronously before native oRPC's first asynchronous validation step. */
export function ownNestedRpcWork<T>(work: () => Promise<T>): Promise<T> {
  const active = currentDatabase.getStore();
  if (!active) return work();
  active.assertCurrent();
  const result = work();
  return trackDatabaseWork(active, result);
}

async function drainDatabaseWork(active: ActiveDatabase): Promise<void> {
  while (active.pending.size) await Promise.all(active.pending);
  if (active.failure) throw active.failure;
}

/** A reusable native middleware capability. Runtime binding owns its transaction. */
export function createDatabaseMiddleware<
  Relations extends AnyRelations,
  Schema extends SchemaDefinition & { readonly validators: object },
>(relations: Relations, policy: DatabasePolicy | "automatic", schema: Schema) {
  if (!isNativeRelations(relations)) throw new Error("Expected native Drizzle relations");
  validateSchemaRelations(schema, relations);
  const { Database, Tables, Validators, Search } = createProjectServices<Schema, Relations>();
  const validators = createSearchValidators(schema, relations);
  const search = createSearchContext(relations);
  const middleware = os
    .$context<ProcedureContext>()
    .meta(databasePolicy(policy))
    .middleware(({ next, context }) => {
      const current = currentDatabase.getStore();
      if (!current?.active) throw new Error("Database procedure has no active invocation");
      current.assertCurrent();
      if (current.policy === "read" && policy === "write")
        throw new Error("Read-only invocation cannot acquire write authority");
      const scopedScheduler = currentScheduler.getStore() ?? current.scheduler;
      const scheduler = Object.freeze<RpcScheduler>({
        runAt: (...args) => {
          current.assertCurrent();
          return scopedScheduler.runAt(...args);
        },
        runAfter: (...args) => {
          current.assertCurrent();
          return scopedScheduler.runAfter(...args);
        },
      });
      const db = scopedDatabase(current.db, relations);
      return next({
        context: {
          db,
          scheduler,
          "effect/context": context["effect/context"].pipe(
            Context.add(Database, db),
            Context.add(RpcSchedulerService, scheduler),
            Context.add(Tables, schema.tables),
            Context.add(Validators, validators),
            Context.add(Search, search),
            Context.add(Diagnostics, publishRuntimeMetric),
            Context.add(Storage, invocationStorage()),
            Context.add(RateLimits, invocationRateLimits()),
          ),
        },
      });
    });
  middlewarePolicies.set(middleware, policy);
  return middleware;
}

export interface RpcDatabaseOptions<Relations extends AnyRelations> {
  readonly connection: DatabaseConnection<Relations>;
  readonly scope?: string;
  readonly replay: IdempotencyOptions;
  readonly scheduler?: RpcScheduler;
  readonly maxResultBytes?: number;
  readonly search?:
    | {
        readonly branchId: string;
        readonly key: string;
        /** Stable contract identity for direct calls that have no native router path. */
        readonly contract?: string;
      }
    | undefined;
  readonly authorize: (
    context: ProcedureContext & {
      readonly db: NodePgDatabase<Relations>;
      readonly path: readonly string[];
      readonly input: RpcValue;
      readonly databasePolicy: DatabasePolicy | "automatic";
    },
  ) => Promise<void>;
}

/** Bind a native procedure without changing its input/output types. All input
 * schemas run once before acquisition; original output stages remain inside the
 * transaction. Middleware receives fully validated input in the bound graph. */
export function bindRpcDatabaseProcedure<
  Initial extends ProcedureContext,
  Injected extends object,
  Input extends AnySchema,
  Output extends AnySchema,
  Errors extends ErrorMap,
  Relations extends AnyRelations,
>(
  procedure: Procedure<Initial, Injected, Input, Output, Errors>,
  options: RpcDatabaseOptions<Relations>,
): Procedure<Initial, Injected, Input, Output, Errors> {
  const search = searchContractDescriptor(procedure);
  const binding = search || liveQueryRows(procedure) ? "read" : getDatabasePolicy(procedure);
  const streaming = isStreamingProcedure(procedure);
  if (!binding) throw new Error("Database policy required");
  if (streaming && binding === "write") throw new Error("Streaming contracts require read-only database authority");
  validateIdempotencyOptions(options.replay);
  if (
    options.maxResultBytes !== undefined &&
    (!Number.isSafeInteger(options.maxResultBytes) ||
      options.maxResultBytes < 1024 ||
      options.maxResultBytes > 10485760)
  )
    throw new Error("Invalid result byte limit");
  const definition = procedure["~orpc"];
  if (search && (!options.search?.branchId || !options.search.key)) throw new Error("Search runtime binding required");
  if (definition.disableInputValidation || definition.disableOutputValidation)
    throw new Error("Database procedures require runtime validation");
  const errorIndex = definition.orderedMiddlewares.findIndex((entry) => entry.middleware === rpcErrorBoundary);
  const first = definition.orderedMiddlewares[errorIndex];
  if (!first) throw new Error("Expected a project-bound procedure");

  const inputCount = definition.inputSchemas
    ? Array.isArray(definition.inputSchemas)
      ? definition.inputSchemas.length
      : 1
    : 0;
  const attempt = new Procedure({
    ...definition,
    handler: search
      ? async (opts, input) => {
          const active = currentDatabase.getStore();
          const runtime = options.search;
          // A search leaf always has read authority, including when an authorized
          // parent shares its write transaction. The compiler emits only reads.
          if (!active?.active || !runtime) throw new Error("Search requires a read invocation");
          active.assertCurrent();
          const selection = v.parse(
            v.custom<SearchPublicSelection>((value) => validSearchSelection(search.node.public, value)),
            input,
          );
          return withSearchInvocation(
            {
              descriptor: search,
              input: selection,
              context: {
                branchId: runtime.branchId,
                namespace: options.scope ?? "",
                contract: opts.path.length ? JSON.stringify(opts.path) : runtime.contract!,
                identity: active.identity,
              },
              key: runtime.key,
              db: active.db,
              signal: opts.signal ? AbortSignal.any([opts.signal, opts.context.signal]) : opts.context.signal,
              assertCurrent: active.assertCurrent,
            },
            async () => validateSearchHandlerOutput(search, selection, await definition.handler(opts, input)),
          );
        }
      : definition.handler,
    disableInputValidation: true,
    disableOutputValidation: false,
    orderedMiddlewares: definition.orderedMiddlewares
      .filter((_entry, index) => index !== errorIndex)
      .map((entry) => ({ ...entry, inputSchemasLengthAtUse: inputCount })),
  });
  const boundary: Middleware<Initial, object, RpcValue, RpcOutput, Record<never, never>> = async (
    { context, path, signal: callerSignal, lastEventId },
    input,
  ) => {
    if (search && !path.length && !options.search?.contract)
      throw new Error("Direct search calls require a contract binding");
    const policy = resolveDatabasePolicy(binding, context, streaming);
    if (!policy) throw new Error("Database policy required");
    const capturedInput = serializeRpcValue(v.parse(rpcValue, input));
    const args = deserializeRpcValue(structuredClone(capturedInput));
    const searchInput = search
      ? v.parse(
          v.custom<SearchPublicSelection>((value) => validSearchSelection(search.node.public, value)),
          args,
        )
      : undefined;
    const signal = callerSignal ? composeInvocationSignals([context.signal, callerSignal]) : context.signal;
    signal.throwIfAborted();
    const parent = currentDatabase.getStore();
    const run = async () => {
      signal.throwIfAborted();
      let result;
      try {
        // Input schemas already ran before acquisition. Give every attempt its
        // own validated value, including native Date/URL/Map/Set values.
        // SAFETY: this private procedure skips input schemas; it consumes their validated output.
        const fresh = deserializeRpcValue(structuredClone(capturedInput)) as InferSchemaInput<Input>;
        result = await currentScheduler.run(options.scheduler ?? unavailableScheduler, () =>
          call(attempt, fresh, { context: { ...context, signal }, path, signal, lastEventId }),
        );
      } finally {
        const active = currentDatabase.getStore();
        if (active && !parent) await drainDatabaseWork(active);
      }
      // Native middleware may replace a handler result. Check again against the
      // original validated input before the transaction commits or a stream leaves.
      if (search && searchInput) result = validateSearchHandlerOutput(search, searchInput, result);
      return validateRpcOutput(v.parse(rpcOutput, result), streaming, options.maxResultBytes);
    };
    if (parent) {
      if (binding === "automatic" && !parent.automatic)
        throw new Error("Automatic handlers cannot run inside retryable procedures");
      if (
        !parent.active ||
        parent.requestId !== context.requestId ||
        parent.identity !== context.identity ||
        parent.connection !== options.connection
      )
        throw new Error("Database belongs to a different invocation");
      parent.assertCurrent();
      if (parent.policy === "read" && policy === "write")
        throw new Error("Read-only invocation cannot acquire write authority");
      try {
        // SAFETY: the same connection owns the parent and relations are checked by the capability middleware.
        await options.authorize({
          ...context,
          signal,
          db: parent.db as NodePgDatabase<Relations>,
          path,
          input: deserializeRpcValue(structuredClone(capturedInput)),
          databasePolicy: binding,
        });
        const output = await run();
        return { output, context: {} };
      } catch (cause) {
        parent.failure ??= cause instanceof Error ? cause : new Error("Nested database procedure failed");
        throw cause;
      }
    }
    const replay =
      policy === "write" && (binding !== "automatic" || context.idempotencyKey !== undefined)
        ? prepareRpcReplay(
            options.replay,
            [
              context.identity
                ? [context.identity.issuer, context.identity.subject, context.identity.tenantId ?? null]
                : null,
              options.scope ? [options.scope, path] : path,
            ],
            context.idempotencyKey,
            args,
          )
        : undefined;
    const output = await runFunctionTransaction(
      options.connection,
      policy === "read" ? "query" : "mutation",
      async (db) => {
        const invocation = Symbol("rpcAttempt");
        await bindDatabaseIdentity(db, context.identity);
        const assertDatabaseCurrent = captureInvocationGuard();
        const active: ActiveDatabase = {
          db,
          policy,
          automatic: binding === "automatic",
          invocation,
          connection: options.connection,
          identity: context.identity,
          requestId: context.requestId,
          assertCurrent: () => {
            const scope = currentDatabase.getStore();
            if (!scope?.active || scope.invocation !== invocation) throw new Error("RPC invocation is inactive");
            assertDatabaseCurrent();
          },
          active: true,
          pending: new Set(),
          scheduler: options.scheduler ?? unavailableScheduler,
        };
        return currentDatabase.run(active, async () => {
          try {
            // Reauthorization is inside each attempt and runs even when a receipt exists.
            await options.authorize({
              ...context,
              signal,
              db,
              path,
              input: deserializeRpcValue(structuredClone(capturedInput)),
              databasePolicy: binding,
            });
            const result = replay ? await replay(db, async () => v.parse(rpcValue, await run())) : await run();
            if (active.failure) throw active.failure;
            return result;
          } finally {
            active.active = false;
          }
        });
      },
      // Automatic handlers may perform external work. Never repeat that work
      // merely because PostgreSQL asks to retry a transaction.
      binding === "automatic" ? { signal, maxAttempts: 1 } : { signal },
    );
    return { output, context: {} };
  };
  const errorBoundary: typeof boundary = (opts, input, done) => {
    // Nested database failures must reach the single outer retry owner before
    // public error redaction. The outermost boundary still redacts all defects.
    return currentDatabase.getStore()?.active ? opts.next() : rpcErrorBoundary(opts, input, done);
  };
  const middlewares = [
    { ...first, middleware: errorBoundary, inputSchemasLengthAtUse: inputCount, outputSchemasLengthAtUse: 0 },
    { middleware: boundary, inputSchemasLengthAtUse: inputCount, outputSchemasLengthAtUse: 0 },
  ];
  const bound: Procedure<Initial, Injected, Input, Output, Errors> = new Procedure({
    ...definition,
    disableOutputValidation: true,
    orderedMiddlewares: middlewares,
  });
  return bound;
}
