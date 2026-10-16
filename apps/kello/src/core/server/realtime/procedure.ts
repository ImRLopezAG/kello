import { ProcedureImplementer, ORPCError } from "@orpc/server";
import type { Context, MergedContext, ImplementedProcedure, ORPCErrorConstructorMap } from "@orpc/server";
import type { AnySchema, ErrorMap, InferSchemaInput, InferSchemaOutput } from "@orpc/contract";
import type { IssuedNeonQuery } from "../../client/realtime";
import { liveQueryRows } from "../../realtime/contract";
import { createNeonQueryIssuer } from "./neon";
import type { NeonLiveQuery } from "./neon";
import type { ProcedureContext } from "../rpc/procedure";
import { captureTrustedLogin } from "../auth/login";
import { AuthenticationError } from "../auth/verify";
import * as v from "valibot";

export interface LiveQueryTarget {
  readonly secret: string;
  readonly database: string;
  readonly deployment: string;
}
type Select<Row> = {
  readonly _: { readonly result: readonly Row[] };
  toSQL(): { sql: string; params: readonly unknown[] };
};
type Row<Schema extends AnySchema> = InferSchemaInput<Schema> extends IssuedNeonQuery<infer R> ? R : never;

declare module "@orpc/server" {
  interface ProcedureImplementer<
    TInitialContext extends Context,
    TInjectedContext extends Context,
    TInputSchema extends AnySchema,
    TOutputSchema extends AnySchema,
    TErrorMap extends ErrorMap,
  > {
    /** Return a Drizzle SELECT without awaiting it. Async authorization belongs
     * in normal .use() middleware; permissions must also be present in SQL. */
    live(
      handler: (options: {
        context: MergedContext<TInitialContext, TInjectedContext>;
        input: InferSchemaOutput<TInputSchema>;
        errors: ORPCErrorConstructorMap<TErrorMap>;
        signal?: AbortSignal | undefined;
        path: readonly string[];
      }) => Select<Row<TOutputSchema>>,
    ): ImplementedProcedure<TInitialContext, TInjectedContext, TInputSchema, TOutputSchema, TErrorMap>;
  }
}

ProcedureImplementer.prototype.live = function (handler) {
  const rows = liveQueryRows(this);
  if (!rows) throw new Error("Use .live() in the matching contract first");
  return this.handler((options) => {
    const context = options.context;
    if (
      !v.is(
        v.object({
          identity: v.object({}),
          login: v.object({}),
          expiresAt: v.number(),
          signal: v.instance(AbortSignal),
        }),
        context,
      )
    )
      throw new ORPCError("UNAUTHORIZED");
    // SAFETY: native HTTP context supplies these fields; captureTrustedLogin
    // rechecks full identity, generation and expiry before the author callback.
    const trusted = context as ProcedureContext;
    if (!trusted.identity || !trusted.login || trusted.expiresAt === undefined) throw new ORPCError("UNAUTHORIZED");
    let login;
    try {
      login = captureTrustedLogin(
        { identity: trusted.identity, expiresAt: trusted.expiresAt },
        trusted.login,
        trusted.signal,
      );
    } catch (cause) {
      if (cause instanceof AuthenticationError) throw new ORPCError("UNAUTHORIZED");
      throw cause;
    }
    if (!trusted.liveQueries)
      throw new ORPCError("SERVICE_UNAVAILABLE", { message: "Live queries are not configured" });
    const selected = handler(options);
    const definition: NeonLiveQuery<unknown, unknown> = {
      name: "procedure.v1",
      input: v.unknown(),
      rows,
      authorize: () => {},
      query: () => selected,
    };
    return createNeonQueryIssuer({ ...trusted.liveQueries, queries: [definition] }).issue(definition, options.input, {
      identity: trusted.identity,
      sessionId: login.id,
      expiresAt: login.expiresAt,
      signal: trusted.signal,
    });
  });
};
