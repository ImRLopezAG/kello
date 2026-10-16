import { AsyncLocalStorage } from "node:async_hooks";
import { Context, Effect } from "effect";
import { ORPCError } from "@orpc/server";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { InvocationContext, InvocationIdentity } from "../auth/context";
import { assertOutsideRpcDatabase, ownRpcDatabaseWork } from "../rpc/database";
import { isRateLimitDefinitions } from "./policy";
import type { RateLimitDefinitions, RateLimitPolicy } from "./policy";
import { RateLimitExceeded, RateLimitUnavailable } from "./errors";

type Policies = Readonly<Record<string, RateLimitPolicy>>;
type Names<P extends Policies, Mode extends "quota" | "attempt"> = {
  [Name in keyof P]: P[Name]["mode"] extends Mode ? Name : never;
}[keyof P] &
  string;
type Failure = RateLimitExceeded | RateLimitUnavailable | ORPCError<"UNAUTHORIZED" | "FORBIDDEN", undefined>;

export interface InvocationRateLimits {
  quota<P extends Policies>(
    definitions: RateLimitDefinitions<P>,
    name: Names<NoInfer<P>, "quota">,
  ): Effect.Effect<void, Failure>;
  attempt<P extends Policies>(
    definitions: RateLimitDefinitions<P>,
    name: Names<NoInfer<P>, "attempt">,
  ): Effect.Effect<void, Failure>;
  quotaPromise<P extends Policies>(
    definitions: RateLimitDefinitions<P>,
    name: Names<NoInfer<P>, "quota">,
  ): Promise<void>;
  attemptPromise<P extends Policies>(
    definitions: RateLimitDefinitions<P>,
    name: Names<NoInfer<P>, "attempt">,
  ): Promise<void>;
}

export class RateLimits extends Context.Service<RateLimits, InvocationRateLimits>()("kello/RateLimits") {}

/** Runtime-created scope; implementations own SQL admission and independent attempt commit. */
export interface RateLimitScope {
  readonly definitions: RateLimitDefinitions;
  readonly quota: (
    db: NodePgDatabase,
    identity: InvocationIdentity,
    name: string,
    signal: AbortSignal,
  ) => Promise<void>;
  readonly attempt: (identity: InvocationIdentity, name: string, signal: AbortSignal) => Promise<void>;
}
interface Owner {
  readonly service: InvocationRateLimits;
}
const current = new AsyncLocalStorage<Owner>();
const unavailable = (): Promise<never> => Promise.reject(new RateLimitUnavailable());
const asEffect = (work: () => Promise<void>) => Effect.tryPromise({ try: work, catch: safeFailure });
const unavailableService: InvocationRateLimits = Object.freeze({
  quotaPromise: unavailable,
  attemptPromise: unavailable,
  quota: () => asEffect(unavailable),
  attempt: () => asEffect(unavailable),
});
export function invocationRateLimits(): InvocationRateLimits {
  return current.getStore()?.service ?? unavailableService;
}
function safeFailure(cause: unknown): Failure {
  if (cause instanceof RateLimitExceeded || cause instanceof RateLimitUnavailable) return cause;
  if (cause instanceof ORPCError && (cause.code === "UNAUTHORIZED" || cause.code === "FORBIDDEN"))
    return new ORPCError(cause.code, { data: undefined });
  return new RateLimitUnavailable();
}

/** Invocation lifetime and transaction ownership apply equally to both native handler styles. */
export async function withInvocationRateLimits<T>(
  context: InvocationContext,
  backend: RateLimitScope | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  const pending = new Set<Promise<void>>();
  let active = true;
  let failure: Failure | undefined;
  const identity = context.identity ? Object.freeze({ ...context.identity }) : null;
  function validate(definitions: RateLimitDefinitions, name: string, mode: "quota" | "attempt"): InvocationIdentity {
    if (!active || current.getStore() !== owner) throw new RateLimitUnavailable();
    context.signal.throwIfAborted();
    if (!identity) throw new ORPCError("UNAUTHORIZED");
    if (!backend || !isRateLimitDefinitions(definitions) || definitions.fingerprint !== backend.definitions.fingerprint)
      throw new RateLimitUnavailable();
    const policy = definitions.policies[name];
    if (!policy || policy.mode !== mode) throw new RateLimitUnavailable();
    if (policy.scope !== "user" && !identity.tenantId) throw new ORPCError("FORBIDDEN");
    return identity;
  }
  function own(mode: "quota" | "attempt", definitions: RateLimitDefinitions, name: string): Promise<void> {
    const work = async () => {
      if (mode === "quota") {
        await ownRpcDatabaseWork(async (db) => {
          const identity = validate(definitions, name, mode);
          await backend!.quota(db, identity, name, context.signal);
          context.signal.throwIfAborted();
        }, context);
      } else {
        assertOutsideRpcDatabase();
        const identity = validate(definitions, name, mode);
        await backend!.attempt(identity, name, context.signal);
        context.signal.throwIfAborted();
      }
    };
    const result = work().catch((cause: unknown) => {
      if (context.signal.aborted) throw context.signal.reason;
      throw safeFailure(cause);
    });
    // Quota failure belongs to its database attempt. Retaining it here would
    // poison a later successful retry after the original charge rolled back.
    const tracked = result
      .then(
        () => undefined,
        (cause: unknown) => {
          if (mode === "attempt") failure ??= safeFailure(cause);
        },
      )
      .finally(() => pending.delete(tracked));
    pending.add(tracked);
    return result;
  }
  const service = Object.freeze<InvocationRateLimits>({
    quotaPromise: (definitions, name) => own("quota", definitions, name),
    attemptPromise: (definitions, name) => own("attempt", definitions, name),
    quota: (definitions, name) => asEffect(() => own("quota", definitions, name)),
    attempt: (definitions, name) => asEffect(() => own("attempt", definitions, name)),
  });
  const owner: Owner = { service };
  return current.run(owner, async () => {
    try {
      const result = await operation();
      while (pending.size) await Promise.all(pending);
      context.signal.throwIfAborted();
      if (failure) throw failure;
      return result;
    } finally {
      active = false;
      while (pending.size) await Promise.all(pending);
    }
  });
}
