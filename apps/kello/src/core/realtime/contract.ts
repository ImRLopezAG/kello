import { ContractBuilder, ProcedureContract } from "@orpc/contract";
import type { AnySchema, AnyProcedureContract, ErrorMap, InferSchemaOutput, InitialInputSchema } from "@orpc/contract";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { IssuedNeonQuery } from "../client/realtime";
import * as v from "valibot";
import { liveQueryEnvelope } from "./envelope";

export type LiveQueryOutput<Rows> = StandardSchemaV1<
  IssuedNeonQuery<Rows extends readonly (infer Row)[] ? Row : never>
>;
type LiveQueryErrors = {
  UNAUTHORIZED: { readonly message: string };
  SERVICE_UNAVAILABLE: { readonly message: string };
};
const liveErrors: LiveQueryErrors = {
  UNAUTHORIZED: { message: "Authentication required" },
  SERVICE_UNAVAILABLE: { message: "Live queries unavailable" },
};
const key = Symbol.for("kello.live-query.rows.v1");

/** The authored output remains the row validator; only the RPC wire output is
 * a short-lived capability. No server query or credential enters the contract. */
export function liveQueryRows(procedure: {
  readonly "~orpc": { readonly outputSchemas?: readonly AnySchema[] | undefined };
}) {
  const outputs = procedure["~orpc"].outputSchemas;
  const schema = outputs?.[0];
  if (!schema || !(key in schema)) return undefined;
  if (outputs.length !== 1) throw new Error("A live contract requires one output schema");
  const rows = schema[key];
  if (!v.is(v.object({ "~standard": v.object({ validate: v.function() }) }), rows))
    throw new Error("Invalid live row schema");
  // SAFETY: this symbol is installed only by .live() on its output validator.
  return rows as StandardSchemaV1<unknown, readonly unknown[]>;
}

declare module "@orpc/contract" {
  interface ProcedureContractBuilderWithInputOutput<
    TInputSchema extends AnySchema,
    TOutputSchema extends AnySchema,
    TErrorMap extends ErrorMap,
  > {
    live(
      this: InferSchemaOutput<TOutputSchema> extends readonly unknown[]
        ? ProcedureContractBuilderWithInputOutput<TInputSchema, TOutputSchema, TErrorMap>
        : never,
    ): ProcedureContract<TInputSchema, LiveQueryOutput<InferSchemaOutput<TOutputSchema>>, TErrorMap & LiveQueryErrors>;
  }
  interface ProcedureContractBuilderWithOutput<TOutputSchema extends AnySchema, TErrorMap extends ErrorMap> {
    live(
      this: InferSchemaOutput<TOutputSchema> extends readonly unknown[]
        ? ProcedureContractBuilderWithOutput<TOutputSchema, TErrorMap>
        : never,
    ): ProcedureContract<
      InitialInputSchema,
      LiveQueryOutput<InferSchemaOutput<TOutputSchema>>,
      TErrorMap & LiveQueryErrors
    >;
  }
}

// Follow oRPC's own .effect() extension convention. This extends the installed
// builder at runtime; it does not modify the dependency or its native methods.
Object.defineProperty(ContractBuilder.prototype, "live", {
  configurable: true,
  value(this: AnyProcedureContract) {
    const outputs = this["~orpc"].outputSchemas;
    if (outputs?.length !== 1 || liveQueryRows(this)) throw new Error("Declare one row-array output before .live()");
    const output: StandardSchemaV1<IssuedNeonQuery<unknown>> = v.strictObject(liveQueryEnvelope.entries);
    Object.defineProperty(output, key, { value: outputs[0] });
    return new ProcedureContract({
      ...this["~orpc"],
      errorMap: { ...liveErrors, ...this["~orpc"].errorMap },
      outputSchemas: [output],
    });
  },
});
