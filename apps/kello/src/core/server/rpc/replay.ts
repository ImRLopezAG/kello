import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as v from "valibot";
import type { JsonValue } from "../../schema/fields";
import { json } from "../../validation/encoding";
import { prepareMutationReplay } from "../idempotency";
import type { IdempotencyOptions } from "../idempotency";
import { serializeRpcValue, deserializeRpcValue, rpcProtocolVersion } from "./serialization";
import type { RpcValue } from "./serialization";

const receipt = v.strictObject({
  protocol: v.literal(rpcProtocolVersion),
  payload: v.strictObject({
    json,
    meta: v.optional(v.array(v.tupleWithRest([v.string()], v.union([v.string(), v.number()])))),
  }),
});

export class RpcReplayVersionError extends Error {
  constructor() {
    super("RPC replay protocol mismatch");
  }
}

/** Reuse the existing atomic receipt and tombstone protocol. The scope must not
 * contain the serializer version: incompatible receipts must fail, never miss. */
export function prepareRpcReplay(
  options: IdempotencyOptions,
  scope: JsonValue,
  key: string | undefined,
  input: RpcValue,
) {
  const replay = prepareMutationReplay(options, scope, key, serializeReceiptInput(input));
  return async (db: NodePgDatabase, invoke: () => Promise<RpcValue>): Promise<RpcValue> => {
    const saved = await replay(db, async () =>
      v.parse(json, {
        protocol: rpcProtocolVersion,
        payload: serializeReceiptInput(await invoke()),
      }),
    );
    const parsed = v.safeParse(receipt, saved);
    if (!parsed.success) throw new RpcReplayVersionError();
    return deserializeRpcValue(parsed.output.payload);
  };
}

function serializeReceiptInput(value: RpcValue): JsonValue {
  // Match the native JSON transport's omission of optional serializer fields.
  return v.parse(json, JSON.parse(JSON.stringify(serializeRpcValue(value))));
}
