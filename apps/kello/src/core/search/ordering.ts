import { and, or, eq, gt, lt, isNull, isNotNull, sql, getTableColumns, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import type { SQL, TableRelationalConfig } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import type { StorageValue } from "../validation/encoding";
import { systemParsers } from "../validation/encoding";
import type { SearchRuntimeDescriptor } from "./metadata";
import type { SearchPublicSelection, SearchOrder } from "./public";
import { validSearchSelection } from "./public";
import { searchColumn } from "./compiler";
import { exactSearchTimestamp } from "./timestamp";
import * as v from "valibot";
import type { ResolvedFullText } from "./full-text";
import { fullTextExpressions } from "./full-text";
import { exactRankFloat4 } from "./rank";

export type SearchDirection = "forward" | "backward";
export type ResolvedSearchOrder = SearchOrder & { readonly nulls: "first" | "last" };
export type ResolvedSearchOrdering =
  | { readonly kind: "field"; readonly fields: readonly ResolvedSearchOrder[] }
  | { readonly kind: "fullTextRank"; readonly fullText: ResolvedFullText };

export function resolveSearchOrdering(
  descriptor: SearchRuntimeDescriptor,
  input: SearchPublicSelection,
  fullText?: ResolvedFullText,
): ResolvedSearchOrdering {
  // Retain the existing primary-key and selection checks in both modes.
  const fields = searchOrdering(descriptor, input);
  if (input.fullText) {
    if (!fullText) throw new Error("Missing parsed full-text order");
    return { kind: "fullTextRank", fullText };
  }
  return { kind: "field", fields };
}
export function resolvedSearchOrderSQL(
  table: TableRelationalConfig["table"],
  order: ResolvedSearchOrdering,
  direction: SearchDirection,
): SQL[] {
  if (order.kind === "field") return searchOrderSQL(table, order.fields, direction);
  const { rank } = fullTextExpressions(table, order.fullText);
  return direction === "forward"
    ? [sql`${rank} desc`, sql`${searchColumn(table, "_id")} asc`]
    : [sql`${rank} asc`, sql`${searchColumn(table, "_id")} desc`];
}
export function resolvedSearchKeyset(
  table: TableRelationalConfig["table"],
  order: ResolvedSearchOrdering,
  keys: readonly StorageValue[],
  direction: SearchDirection,
): SQL {
  if (order.kind === "field") return searchKeyset(table, order.fields, keys, direction);
  if (keys.length !== 2) throw new Error("Search boundary length mismatch");
  const rank = fullTextExpressions(table, order.fullText).rank;
  const parameter = sql`${v.parse(exactRankFloat4, keys[0]).toString()}::real`;
  const id = searchColumn(table, "_id");
  const uuid = sql`${v.parse(systemParsers._id, keys[1])}::uuid`;
  return direction === "forward"
    ? sql`(${rank} < ${parameter} or (${rank} = ${parameter} and ${id} > ${uuid}))`
    : sql`(${rank} > ${parameter} or (${rank} = ${parameter} and ${id} < ${uuid}))`;
}

/** Every ordering ends in the compiled root primary key, never a guessed unique field. */
export function searchOrdering(
  descriptor: SearchRuntimeDescriptor,
  input: SearchPublicSelection,
): readonly ResolvedSearchOrder[] {
  if (!validSearchSelection(descriptor.node.public, input)) throw new ORPCError("INVALID_SELECTION");
  const root = descriptor.graph[descriptor.entity];
  if (!root || !is(root.table, PgTable) || !getTableColumns(root.table)._id?.primary)
    throw new Error("Search requires a compiled primary key");
  const order = input.orderBy ?? [{ field: "_createdAt", direction: "asc" }];
  return [
    ...order,
    ...(order.some(({ field }) => field === "_id") ? [] : [{ field: "_id", direction: "asc" } as const]),
  ].map((entry) => ({ ...entry, nulls: entry.nulls ?? "last" }));
}
function traversal(order: ResolvedSearchOrder, direction: SearchDirection): ResolvedSearchOrder {
  return direction === "forward"
    ? order
    : {
        field: order.field,
        direction: order.direction === "asc" ? "desc" : "asc",
        nulls: order.nulls === "first" ? "last" : "first",
      };
}
export function searchOrderSQL(
  table: TableRelationalConfig["table"],
  order: readonly ResolvedSearchOrder[],
  direction: SearchDirection,
): SQL[] {
  return order.map((entry) => {
    const next = traversal(entry, direction);
    return sql`${searchColumn(table, next.field)} ${next.direction === "asc" ? sql`asc` : sql`desc`} nulls ${next.nulls === "first" ? sql`first` : sql`last`}`;
  });
}
/** Strict lexicographic continuation, including explicit NULL placement in either direction. */
export function searchKeyset(
  table: TableRelationalConfig["table"],
  order: readonly ResolvedSearchOrder[],
  keys: readonly StorageValue[],
  direction: SearchDirection,
): SQL {
  if (order.length !== keys.length) throw new Error("Search boundary length mismatch");
  const alternatives: SQL[] = [];
  const equalPrefix: SQL[] = [];
  for (const [index, entry] of order.entries()) {
    const next = traversal(entry, direction);
    const column = searchColumn(table, next.field);
    const key = keys[index];
    if (key === undefined) throw new Error("Search boundary key missing");
    const parameter = v.is(exactSearchTimestamp, key) ? sql`${key.timestamp}::timestamptz` : key;
    const beyond =
      key === null
        ? next.nulls === "first"
          ? isNotNull(column)
          : sql`false`
        : or(
            next.direction === "asc" ? gt(column, parameter) : lt(column, parameter),
            ...(next.nulls === "last" ? [isNull(column)] : []),
          );
    alternatives.push(and(...equalPrefix, beyond) ?? sql`false`);
    equalPrefix.push(key === null ? isNull(column) : eq(column, parameter));
  }
  return or(...alternatives) ?? sql`false`;
}
