import * as v from "valibot";
import { json } from "../../validation/encoding";
import { rpcProtocolVersion, serializeRpcValue, deserializeRpcValue } from "../rpc/serialization";
import type { RpcValue } from "../rpc/serialization";

const segment = v.pipe(
  v.string(),
  v.regex(/^[a-zA-Z][a-zA-Z0-9_]*$/),
  v.maxLength(128),
  v.check((value) => !["constructor", "prototype", "__proto__"].includes(value)),
);
export const rpcJobCall = v.strictObject({
  protocol: v.literal(rpcProtocolVersion),
  version: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
  scope: v.optional(
    v.pipe(v.string(), v.regex(/^[a-zA-Z][a-zA-Z0-9_]*(\/[a-zA-Z][a-zA-Z0-9_]*)*$/), v.maxLength(4096)),
  ),
  path: v.pipe(v.array(segment), v.minLength(1), v.maxLength(32)),
  input: v.strictObject({
    json,
    meta: v.optional(v.array(v.tupleWithRest([v.string()], v.union([v.string(), v.number()])))),
  }),
});
export type RpcJobCall = v.InferOutput<typeof rpcJobCall>;

export function encodeRpcJobCall(
  version: string,
  path: readonly string[],
  input: RpcValue,
  scope?: string,
): RpcJobCall {
  // Match the native transport's optional field omission without losing its type metadata.
  return v.parse(
    rpcJobCall,
    JSON.parse(
      JSON.stringify({
        protocol: rpcProtocolVersion,
        version,
        path,
        scope: scope || undefined,
        input: serializeRpcValue(input),
      }),
    ),
  );
}
export function decodeRpcJobInput(call: RpcJobCall): RpcValue {
  return deserializeRpcValue(call.input);
}
