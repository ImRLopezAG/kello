import { ORPCError } from "@orpc/server";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as v from "valibot";
import type { InvocationContext } from "./context";
import type { DatabasePolicy } from "../rpc/database";
import type { RpcValue } from "../rpc/serialization";
import type { AuthConfigInput } from "./config";
import { createAuthenticationConfiguration } from "./configuration";

/** Authorization context for a procedure invocation. Enforce ownership here or in handlers; a verified identity alone does not grant data access. */
export interface RpcAuthorization extends InvocationContext {
  readonly path: readonly string[];
  readonly input: RpcValue;
  /** Server-owned capability. Automatic never exposes client-selected transaction intent. */
  readonly databasePolicy?: DatabasePolicy | "automatic";
  readonly db?: NodePgDatabase;
}
/** Server-owned authorization policy and optional token verification configuration. Returning from authorize permits the invocation; throw to reject it. */
export interface RpcAuthDefinition {
  readonly authorize: (context: RpcAuthorization) => Promise<void>;
  readonly allowAnonymous: boolean;
  /** Complete graph-local table reads by the authorizer; absent means unknown. */
  readonly dependencies?: readonly string[];
  readonly verification?: () => AuthConfigInput;
}
const definitions = new WeakSet<object>();
export function isRpcAuthDefinition(value: unknown): value is RpcAuthDefinition {
  return value instanceof Object && definitions.has(value);
}

/** Returning permits the invocation. Database policies authorize inside every
 * transaction attempt, including receipt replay; no database authority is inferred. */
export function defineRpcAuth(
  options: {
    readonly authorize: (context: RpcAuthorization) => void | Promise<void>;
    readonly allowAnonymous?: boolean;
    /** Trusted completeness declaration, including authorization side reads. */
    readonly dependencies?: readonly string[];
    /** Server-owned trust policy, resolved at runtime so platform-injected URLs remain branch-local. */
    readonly verification?: () => AuthConfigInput;
  } = {
    authorize: () => {
      throw new ORPCError("FORBIDDEN");
    },
  },
): RpcAuthDefinition {
  const authorize = v.parse(v.function(), options.authorize);
  const allowAnonymous = v.parse(v.optional(v.boolean(), false), options.allowAnonymous);
  const dependencies =
    options.dependencies === undefined
      ? undefined
      : Object.freeze([...v.parse(v.array(v.string()), options.dependencies)]);
  const verification = options.verification;
  if (verification !== undefined) v.parse(v.function(), verification);
  const policy: Partial<Record<"verification", () => AuthConfigInput>> = {};
  if (verification) policy.verification = verification;
  const base = {
    allowAnonymous,
    ...policy,
    async authorize(context: RpcAuthorization): Promise<void> {
      await authorize(context);
    },
  };
  const definition = Object.freeze(dependencies === undefined ? base : { ...base, dependencies });
  definitions.add(definition);
  return definition;
}
const deny = defineRpcAuth();
export function createRpcAuthentication(input: AuthConfigInput, definition: RpcAuthDefinition = deny) {
  if (!definitions.has(definition)) throw new Error("Expected defineRpcAuth's result");
  const trust = definition.verification ? definition.verification() : input;
  const { verify, origins } = createAuthenticationConfiguration(trust);
  const policy: Partial<Record<"dependencies", readonly string[]>> = {};
  if (definition.dependencies !== undefined) policy.dependencies = definition.dependencies;
  return Object.freeze({
    verify,
    origins,
    trust,
    authorize: definition.authorize,
    allowAnonymous: definition.allowAnonymous,
    ...policy,
  });
}
