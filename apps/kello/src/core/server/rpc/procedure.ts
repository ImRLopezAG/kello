import "@orpc/experimental-effect/extensions/effect";
import "../realtime/procedure";
import { AsyncLocalStorage } from "node:async_hooks";
import { channel } from "node:diagnostics_channel";
import type { ErrorMap } from "@orpc/server";
import { os, ORPCError, ValidationError } from "@orpc/server";
import { AsyncIteratorClass, isAsyncIteratorObject } from "@orpc/shared";
import { reconcileORPCError } from "@orpc/contract";
import type { WithEffectContext } from "@orpc/experimental-effect";
import type { OperationType } from "@orpc/tanstack-query";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { Cause, Context, Effect } from "effect";
import type { SchemaDefinition } from "../../schema/define-schema";
import type { InvocationContext } from "../auth/context";
import type { Invocation } from "../effect/runtime";
import { Diagnostics } from "../effect/runtime";
import { publishRuntimeMetric } from "../observability";
import { isStreamingProcedure, rpcOutput, validateRpcOutput } from "./stream";
import * as v from "valibot";
import type { Id } from "../../schema/fields";
import { IdempotencyError } from "../idempotency";
import { TransactionConflictError } from "../transactions";
import { RpcReplayVersionError } from "./replay";
import { createProjectServices, Storage } from "../effect/services";
import { invocationStorage } from "../storage/invocation";
import type { AnyRelations } from "drizzle-orm";
import { defineRelations } from "drizzle-orm";
import { createSearchValidators } from "../../search/contract";
import type { SearchValidators } from "../../search/contract";
import { isNativeRelations, validateSchemaRelations } from "../database/relations";
import { createSearchContext } from "../../search/executor";
import type { SearchContext } from "../../search/executor";
import { RateLimitExceeded, RateLimitUnavailable } from "../rate-limits/errors";
import { RateLimits, invocationRateLimits } from "../rate-limits/service";
import { searchInputIssueCode } from "../../search/metadata";
import { searchErrors } from "../../search/errors";

/** Server invocation context extended with Effect services and transport hints. Treat operation hints as untrusted and authorize using verified identity. */
export interface ProcedureContext extends InvocationContext, WithEffectContext<Invocation> {
  /** Trusted HTTP session-store generation, absent for unsupported transports. */
  readonly login?: import("../auth/login").TrustedLogin;
  /** Server-owned Neon issuance configuration, never accepted from RPC input. */
  readonly liveQueries?: import("../realtime/procedure").LiveQueryTarget;
  /** Untrusted client intent; never authentication or authorization evidence. */
  readonly operation?: OperationType | "call";
  readonly idempotencyKey?: string;
  readonly expiresAt?: number;
}

const failures = channel("kello.procedure.failure");
const observation = new AsyncLocalStorage<boolean>();

async function publicError(cause: unknown, errorMap: ErrorMap) {
  if (cause instanceof RateLimitExceeded)
    return new ORPCError("RATE_LIMITED", {
      message: "Rate limit exceeded",
      data: { retryAfterMs: cause.retryAfterMs },
    });
  if (cause instanceof RateLimitUnavailable)
    return new ORPCError("RATE_LIMIT_UNAVAILABLE", { message: "Rate limit unavailable" });
  if (cause instanceof RpcReplayVersionError)
    return new ORPCError("RPC_VERSION_MISMATCH", { message: "RPC replay protocol mismatch" });
  if (cause instanceof IdempotencyError) return new ORPCError(cause.code, { message: cause.code });
  if (cause instanceof TransactionConflictError) return new ORPCError("CONFLICT", { message: "Transaction conflict" });
  if (cause instanceof ORPCError) {
    if (cause.cause instanceof ValidationError && cause.code === "BAD_REQUEST") {
      const code = searchInputIssueCode(cause.cause.issues);
      if (code) {
        const declared = await reconcileORPCError(
          errorMap,
          new ORPCError(code, { message: searchErrors[code].message }),
        );
        if (declared.defined) return declared;
      }
      return new ORPCError("BAD_REQUEST", { message: "Invalid input" });
    }
    const declared = await reconcileORPCError(errorMap, cause);
    if (declared.defined) return declared;
  }
  return new ORPCError("INTERNAL_SERVER_ERROR", { message: "Internal server error" });
}

export const rpcErrorBoundary = os.$context<ProcedureContext>().middleware(({ next, procedure, context }) => {
  const report = !observation.getStore();
  return observation.run(true, async () => {
    const started = performance.now();
    let status: "success" | "error" = "success";
    try {
      const result = await next();
      const output = validateRpcOutput(v.parse(rpcOutput, result.output), isStreamingProcedure(procedure));
      if (!isAsyncIteratorObject(output)) return { ...result, output };
      const stream = new AsyncIteratorClass(
        async () => {
          try {
            return await output.next();
          } catch (cause) {
            throw await publicError(cause, procedure["~orpc"].errorMap);
          }
        },
        async () => {
          try {
            await output.return?.();
          } catch (cause) {
            throw await publicError(cause, procedure["~orpc"].errorMap);
          }
        },
      );
      return { ...result, output: stream };
    } catch (cause) {
      status = "error";
      const error = await publicError(cause, procedure["~orpc"].errorMap);
      if (report) failures.publish({ requestId: context.requestId, code: error.code });
      throw error;
    } finally {
      if (report)
        publishRuntimeMetric({
          type: "rpc.procedure",
          mode: isStreamingProcedure(procedure) ? "live" : context.operation === "mutation" ? "mutation" : "finite",
          status,
          durationMs: performance.now() - started,
        });
    }
  });
});

/** Generated bindings configure this native builder once per project. Database
 * capabilities are supplied separately by transaction middleware. */
export interface ProjectSchema extends SchemaDefinition {
  readonly validators: object;
  readonly id: (table: never) => StandardSchemaV1<string, Id<string>>;
}

export function createProjectContext<Schema extends ProjectSchema, Relations extends AnyRelations>(
  schema: Schema,
  relations: Relations,
): ReturnType<typeof projectContext<Schema, Relations>>;
export function createProjectContext<Schema extends ProjectSchema>(
  schema: Schema,
): ReturnType<typeof projectContext<Schema, AnyRelations>>;
export function createProjectContext<Schema extends ProjectSchema>(schema: Schema, relations?: AnyRelations) {
  const graph = relations ?? defineRelations(schema.tables);
  if (!isNativeRelations(graph)) throw new Error("Invalid project relation graph");
  return projectContext(schema, graph);
}
function projectContext<Schema extends ProjectSchema, Relations extends AnyRelations>(
  schema: Schema,
  relations: Relations,
) {
  validateSchemaRelations(schema, relations);
  const bindings: ProjectBindings<Schema, Relations> = Object.freeze({
    tables: schema.tables,
    validators: Object.freeze({ tables: createSearchValidators(schema, relations), id: schema.id }),
    search: createSearchContext(relations),
  });
  const { Tables, Validators } = createProjectServices<Schema, Relations>();
  const middleware = os.$context<ProcedureContext>().middleware(({ next, context }) =>
    next({
      context: {
        ...bindings,
        storage: invocationStorage(),
        rateLimits: invocationRateLimits(),
        "effect/wrap": redactDefects,
        "effect/context": context["effect/context"].pipe(
          Context.add(Tables, schema.tables),
          Context.add(Validators, bindings.validators.tables),
          Context.add(Diagnostics, publishRuntimeMetric),
          Context.add(Storage, invocationStorage()),
          Context.add(RateLimits, invocationRateLimits()),
        ),
      },
    }),
  );
  return { middleware, ...bindings };
}

export function createProjectProcedures<Schema extends ProjectSchema, Relations extends AnyRelations>(
  schema: Schema,
  relations: Relations,
): ReturnType<typeof projectProcedures<Schema, Relations>>;
export function createProjectProcedures<Schema extends ProjectSchema>(
  schema: Schema,
): ReturnType<typeof projectProcedures<Schema, AnyRelations>>;
export function createProjectProcedures<Schema extends ProjectSchema>(schema: Schema, relations?: AnyRelations) {
  const graph = relations ?? defineRelations(schema.tables);
  if (!isNativeRelations(graph)) throw new Error("Invalid project relation graph");
  return projectProcedures(schema, graph);
}
function projectProcedures<Schema extends ProjectSchema, Relations extends AnyRelations>(
  schema: Schema,
  relations: Relations,
) {
  const { middleware, ...bindings } = createProjectContext(schema, relations);
  const procedure = os
    .$context<ProcedureContext>()
    .errors({
      RPC_VERSION_MISMATCH: {},
      INVALID_IDEMPOTENCY_KEY: {},
      IDEMPOTENCY_CONFLICT: {},
      IDEMPOTENCY_EXPIRED: {},
      CONFLICT: {},
      UNAUTHORIZED: {},
      FORBIDDEN: {},
      STORAGE_UNAVAILABLE: {},
      RATE_LIMITED: {
        data: v.strictObject({ retryAfterMs: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(86_400_000)) }),
      },
      RATE_LIMIT_UNAVAILABLE: {},
    })
    .use(rpcErrorBoundary)
    .use(middleware);
  return Object.freeze({ procedure, ...bindings });
}

/** Schema capabilities injected into a handler for one generated project or component scope. */
export interface ProjectBindings<Schema extends ProjectSchema, Relations extends AnyRelations = AnyRelations> {
  readonly tables: Schema["tables"];
  readonly validators: { readonly tables: SearchValidators<Schema, Relations>; readonly id: Schema["id"] };
  readonly search: SearchContext<Relations>;
}

function redactDefects<A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E> {
  return Effect.catchCause(effect, (cause) =>
    Cause.hasDies(cause) ? Effect.die(new Error("Procedure defect")) : Effect.failCause(cause),
  );
}
