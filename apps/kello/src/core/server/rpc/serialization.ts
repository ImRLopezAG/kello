import { RPCJsonSerializer } from "@orpc/client";
import { NullProtoObj } from "@orpc/shared";
import * as v from "valibot";

export type RpcValue =
  | null
  | undefined
  | boolean
  | string
  | number
  | bigint
  | Date
  | URL
  | RpcValue[]
  | { [key: string]: RpcValue }
  | Set<RpcValue>
  | Map<RpcValue, RpcValue>;

/** Finite transaction results; streams and binary storage use separate boundaries. */
export const rpcValue: v.GenericSchema<RpcValue> = v.lazy(() =>
  v.union([
    v.null(),
    v.undefined(),
    v.boolean(),
    v.string(),
    v.pipe(v.number(), v.finite()),
    v.bigint(),
    v.date(),
    v.instance(URL),
    v.array(rpcValue),
    v.set(rpcValue),
    v.map(rpcValue, rpcValue),
    v.pipe(
      v.custom<Record<string, RpcValue>>(
        (value) =>
          v.is(v.object({}), value) &&
          (Object.getPrototypeOf(value) === Object.prototype ||
            Object.getPrototypeOf(value) === null ||
            Object.getPrototypeOf(value) === NullProtoObj.prototype),
      ),
      v.record(v.string(), rpcValue),
    ),
  ]),
);

const serializer = new RPCJsonSerializer({ omitUndefinedProperties: false });
export const rpcProtocolVersion = "loom-orpc-2";

/** Encoding belongs to oRPC; validate before a transaction commits. */
export function serializeRpcValue(value: RpcValue) {
  return serializer.serialize(v.parse(rpcValue, value));
}

export function deserializeRpcValue(value: ReturnType<typeof serializeRpcValue>): RpcValue {
  return v.parse(rpcValue, serializer.deserialize(value));
}
