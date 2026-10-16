"use client";

import { useMemo, useState } from "react";
import { RPCJsonSerializer } from "@orpc/client";
import * as v from "valibot";
import type { AnyNestedClient, Client } from "@orpc/client";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { createNeonLiveClient, IssuedNeonQuery } from "../client/realtime";
import { useNeonLiveQuery } from "./realtime";
import { liveQueryEnvelope } from "../realtime/envelope";

type LiveState<Row> = ReturnType<typeof useNeonLiveQuery<Row>> & {
  readonly data: readonly Row[] | undefined;
  readonly status: "connecting" | "live" | "stale" | "closed" | "error";
  readonly isPending: boolean;
  readonly refetch: () => void;
};
export type LiveQueryHooks<Router extends AnyNestedClient> =
  Router extends Client<infer _Context, infer Input, infer Output, infer _Error>
    ? Output extends IssuedNeonQuery<infer Row>
      ? Router & { useLiveQuery(...args: undefined extends Input ? [input?: Input] : [input: Input]): LiveState<Row> }
      : Router
    : { [Key in keyof Router]: Router[Key] extends AnyNestedClient ? LiveQueryHooks<Router[Key]> : never };

const serializer = new RPCJsonSerializer({ omitUndefinedProperties: false });
interface ClientNode {
  // Dynamic native proxy properties cross a boundary: declared children are
  // validated below; unrelated properties retain their original runtime value.
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type
  readonly [key: string | symbol]: unknown;
}
// Native oRPC paths are proxy properties, not own properties. Validate without
// cloning the node or using own-property lookup, which would erase those paths.
const clientNode = v.custom<ClientNode>((value) => v.is(v.union([v.function(), v.object({})]), value));
/** Generated React bindings only. Schemas come from the public contract, never
 * from a server import. The generated session connection owns client disposal. */
export function createLiveQueryHooks<Router extends AnyNestedClient>(
  client: Router,
  live: ReturnType<typeof createNeonLiveClient>,
  declarations: readonly {
    readonly path: readonly string[];
    readonly rows: StandardSchemaV1<unknown, readonly unknown[]>;
  }[],
): LiveQueryHooks<Router> {
  function wrap(target: ClientNode, path: readonly string[]): ClientNode {
    const declaration = declarations.find(
      (entry) => entry.path.length === path.length && entry.path.every((part, i) => part === path[i]),
    );
    const children = new Map<string, ClientNode>();
    function useLiveQuery<Input>(input: Input) {
      if (!declaration || !v.is(v.function(), target)) throw new Error("Not a live procedure");
      const [revision, setRevision] = useState(0);
      const key = JSON.stringify(serializer.serialize(input));
      const issue = useMemo(() => {
        const parsed: unknown = serializer.deserialize(JSON.parse(key));
        return async () => v.parse(liveQueryEnvelope, await target(parsed));
      }, [key, revision, target]);
      const state = useNeonLiveQuery({ client: live, rows: declaration.rows, issue });
      return {
        ...state,
        data: state.snapshot?.data,
        status: state.failed ? "error" : (state.snapshot?.status ?? "connecting"),
        isPending: state.snapshot === undefined && !state.failed,
        refetch: () => setRevision((value) => value + 1),
      };
    }
    return new Proxy(target, {
      get(object, property) {
        if (property === "useLiveQuery" && declaration) return useLiveQuery;
        if (
          !v.is(v.string(), property) ||
          !declarations.some(
            (entry) =>
              entry.path.length > path.length &&
              entry.path.slice(0, path.length).every((part, i) => part === path[i]) &&
              entry.path[path.length] === property,
          )
        )
          return object[property];
        let child = children.get(property);
        if (!child) {
          const value = v.parse(clientNode, object[property]);
          child = wrap(value, [...path, property]);
          children.set(property, child);
        }
        return child;
      },
    });
  }
  // SAFETY: the generated declaration paths exactly match the contract. Only
  // those native client functions gain hooks; ordinary calls are untouched.
  return wrap(v.parse(clientNode, client), []) as LiveQueryHooks<Router>;
}
