import { RPCJsonSerializer } from "@orpc/client";
import { hashKey } from "@tanstack/query-core";
import type { DehydratedState } from "@tanstack/query-core";
import * as v from "valibot";

const serializer = new RPCJsonSerializer();
const wire = v.strictObject({
  json: v.unknown(),
  meta: v.optional(v.array(v.tupleWithRest([v.string()], v.union([v.string(), v.number()])))),
});
const cache = v.object({
  mutations: v.array(v.never()),
  queries: v.array(
    v.object({
      queryKey: v.array(v.unknown()),
      queryHash: v.string(),
      dehydratedAt: v.number(),
      state: v.object({
        status: v.literal("success"),
        data: v.unknown(),
        dataUpdateCount: v.number(),
        dataUpdatedAt: v.number(),
        error: v.null(),
        errorUpdateCount: v.number(),
        errorUpdatedAt: v.number(),
        fetchFailureCount: v.number(),
        fetchFailureReason: v.null(),
        fetchMeta: v.nullable(v.record(v.string(), v.unknown())),
        isInvalidated: v.boolean(),
        fetchStatus: v.picklist(["idle", "fetching", "paused"]),
      }),
      meta: v.exactOptional(v.record(v.string(), v.unknown())),
    }),
  ),
});

/** A string crosses both framework serializers without weakening their type checks. */
export function encodeHydration(state: DehydratedState): string {
  const serialized = serializer.serialize(state);
  if (serialized.blobs?.length) throw new Error("Prefetch file data separately from SSR hydration");
  return JSON.stringify(serialized);
}

export function decodeHydration(state: string, prefix: string) {
  const value = serializer.deserialize(v.parse(wire, JSON.parse(state)));
  const parsed = v.parse(cache, value);
  if (parsed.queries.some((query) => query.queryKey[0] !== prefix || query.queryHash !== hashKey(query.queryKey)))
    throw new Error("Hydration contains data outside its Kello session");
  return parsed;
}
