import { getAsyncIteratorObjectSchemaDetails } from "@orpc/contract";
import type { AnyProcedure } from "@orpc/server";
import { isAsyncIteratorObject, wrapAsyncIterator } from "@orpc/shared";
import * as v from "valibot";
import { rpcValue, serializeRpcValue } from "./serialization";
import type { RpcValue } from "./serialization";

export type RpcOutput = RpcValue | AsyncIteratorObject<RpcValue, RpcValue>;
export const rpcOutput = v.union([
  rpcValue,
  v.pipe(
    v.custom<AsyncIteratorObject<RpcValue, RpcValue>>(isAsyncIteratorObject),
    v.transform((iterator) =>
      wrapAsyncIterator(iterator, {
        mapResult: (result) => ({ ...result, value: v.parse(rpcValue, result.value) }),
      }),
    ),
  ),
]);

export function isStreamingProcedure(procedure: AnyProcedure): boolean {
  return (
    procedure["~orpc"].outputSchemas?.some((schema) => getAsyncIteratorObjectSchemaDetails(schema) !== undefined) ??
    false
  );
}

/** Native contract validation owns each event's shape. This boundary enforces
 * Kello's wire types and byte limit without consuming or buffering the stream. */
export function validateRpcOutput(output: RpcOutput, streaming: boolean, maxBytes?: number): RpcOutput {
  function validate(value: RpcValue): RpcValue {
    const parsed = v.parse(rpcValue, value);
    const encoded = serializeRpcValue(parsed);
    if (maxBytes !== undefined && Buffer.byteLength(JSON.stringify(encoded)) > maxBytes)
      throw new Error("Procedure result exceeds configured limit");
    return parsed;
  }
  if (!isAsyncIteratorObject(output)) return validate(output);
  if (!streaming) throw new Error("Streaming output requires an explicit iterator contract");
  return wrapAsyncIterator(output, {
    mapResult: (result): IteratorResult<RpcValue, RpcValue> => ({ ...result, value: validate(result.value) }),
  });
}
