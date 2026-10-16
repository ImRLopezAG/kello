import { and, sql, getTableColumns, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import type { StorageRow } from "../validation/encoding";
import { ORPCError } from "@orpc/server";
import type { SearchRuntimeDescriptor } from "./metadata";
import type { SearchPublicSelection, SearchCachedPage } from "./public";
import { acceptsSearchPage, acceptsSearchOutput } from "./public";
import { compileSearch, searchColumn } from "./compiler";
import { resolveSearchOrdering, resolvedSearchOrderSQL, resolvedSearchKeyset, searchOrderSQL } from "./ordering";
import type { ResolvedFullText } from "./full-text";
import { fullTextExpressions } from "./full-text";
import { createSearchCursor } from "./cursor";
import type { SearchCursorContext } from "./cursor";
import * as v from "valibot";
import { exactRankFloat4 } from "./rank";
import { systemParsers } from "../validation/encoding";

/** Plan through the native relational query; ordering fields stay private until page assembly. */
export async function prepareSearchPage(
  descriptor: SearchRuntimeDescriptor,
  input: SearchPublicSelection,
  context: SearchCursorContext,
  key: string | undefined,
  fullText?: ResolvedFullText,
) {
  const compiled = compileSearch(descriptor, input, context.identity, fullText);
  const resolvedOrder = resolveSearchOrdering(descriptor, input, fullText);
  const order =
    resolvedOrder.kind === "field"
      ? resolvedOrder.fields
      : [{ field: "_id", direction: "asc", nulls: "last" } as const];
  const codec = createSearchCursor(key, descriptor, input, context, undefined, fullText);
  const direction = input.direction ?? "forward";
  const token = input.cursor ?? input.anchor;
  const hasToken = token !== undefined && token !== null;
  const boundary = hasToken ? await codec.read(token, direction) : undefined;
  const pageSize = compiled.config.limit;
  const limit = pageSize * (descriptor.mode === "live" ? (input.loadedPages ?? 1) : 1);
  if (limit > descriptor.budgets.rows)
    throw new ORPCError("QUERY_BUDGET_EXCEEDED", { message: "Search window exceeds row budget" });
  const root = descriptor.graph[descriptor.entity];
  if (!root || !is(root.table, PgTable)) throw new Error("Missing search table");
  const columns = getTableColumns(root.table);
  const occupied = new Set([
    ...Object.keys(columns),
    ...Object.values(columns).map((column) => column.name),
    ...Object.keys(descriptor.node.relations),
  ]);
  let rankAlias: string | undefined;
  if (resolvedOrder.kind === "fullTextRank") {
    rankAlias = "searchRank";
    while (occupied.has(rankAlias)) rankAlias = `_${rankAlias}`;
    occupied.add(rankAlias);
  }
  const timestamps = order.flatMap(({ field }, index) => {
    const metadata = descriptor.node.public.fields?.[field] ?? descriptor.node.public.columns[field];
    if (!metadata || metadata === "_id" || metadata === "_createdAt" || metadata.kind !== "timestamp") return [];
    let alias = `_loom_search_timestamp_${index}`;
    while (Object.hasOwn(columns, alias)) alias = `_${alias}`;
    return [{ field, alias }];
  });
  const rankTransportAlias = rankAlias;
  return {
    descriptor,
    input,
    context,
    codec,
    direction,
    order,
    resolvedOrder,
    rankAlias,
    limit,
    pageSize,
    timestamps,
    fromCursor: hasToken,
    dependencies: compiled.dependencies,
    dependencyEvidence: compiled.dependencyEvidence,
    where: compiled.where,
    config: {
      ...compiled.config,
      columns: { ...compiled.config.columns, ...Object.fromEntries(order.map(({ field }) => [field, true])) },
      limit: limit + 1,
      orderBy: (table: Parameters<typeof searchOrderSQL>[0]) => resolvedSearchOrderSQL(table, resolvedOrder, direction),
      extras: Object.fromEntries([
        ...timestamps.map(({ field, alias }) => [
          alias,
          (table: Parameters<typeof searchOrderSQL>[0]) =>
            sql<string>`to_char(${searchColumn(table, field)} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || case when extract(year from ${searchColumn(table, field)} at time zone 'UTC') < 0 then ' BC' else '' end`.as(
              alias,
            ),
        ]),
        ...(rankTransportAlias && fullText
          ? [
              [
                rankTransportAlias,
                (table: Parameters<typeof searchOrderSQL>[0]) =>
                  fullTextExpressions(table, fullText).bits.as(rankTransportAlias),
              ],
            ]
          : []),
      ]),
      where: {
        RAW: (table: Parameters<typeof searchOrderSQL>[0]) =>
          and(
            compiled.config.where.RAW(table),
            ...(boundary ? [resolvedSearchKeyset(table, resolvedOrder, boundary, direction)] : []),
          ) ?? sql`false`,
      },
    },
    selected: compiled.config.columns,
  };
}
export type SearchPagePlan = Awaited<ReturnType<typeof prepareSearchPage>>;

/** Trim the extra root, issue boundaries from retained rows, then remove private sort keys. */
export async function finishSearchPage(plan: SearchPagePlan, rows: readonly StorageRow[]): Promise<SearchCachedPage> {
  if (rows.length > plan.limit + 1) throw new Error("Search returned too many roots");
  const retained = rows.slice(0, plan.limit);
  if (plan.direction === "backward") retained.reverse();
  const first = retained[0];
  const last = retained.at(-1);
  const hasMore = rows.length > plan.limit;
  const keys = (row: StorageRow) => {
    if (plan.resolvedOrder.kind === "fullTextRank") {
      const rank = plan.rankAlias && row[plan.rankAlias];
      if (rank === undefined || row._id === undefined) throw new Error("Search omitted a ranked key");
      v.parse(exactRankFloat4, rank);
      return [rank, v.parse(systemParsers._id, row._id)];
    }
    return plan.order.map(({ field }) => {
      const timestamp = plan.timestamps.find((entry) => entry.field === field);
      const value = row[timestamp?.alias ?? field];
      if (value === undefined) throw new Error("Search omitted an ordering field");
      return timestamp && value !== null ? { timestamp: value } : value;
    });
  };
  if (plan.resolvedOrder.kind === "fullTextRank") for (const row of rows) keys(row);
  const nextCursor =
    last && (plan.direction === "forward" ? hasMore : plan.fromCursor)
      ? await plan.codec.issue(keys(last), "forward")
      : null;
  const previousCursor =
    first && (plan.direction === "backward" ? hasMore : plan.fromCursor)
      ? await plan.codec.issue(keys(first), "backward")
      : null;
  const hidden = new Set(plan.order.filter(({ field }) => !plan.selected[field]).map(({ field }) => field));
  for (const { alias } of plan.timestamps) hidden.add(alias);
  if (plan.rankAlias) hidden.add(plan.rankAlias);
  const selected = retained.map((row) => Object.fromEntries(Object.entries(row).filter(([name]) => !hidden.has(name))));
  const page = {
    ...(plan.descriptor.mode === "live"
      ? {
          pages: Array.from({ length: Math.ceil(selected.length / plan.pageSize) }, (_, index) =>
            selected.slice(index * plan.pageSize, (index + 1) * plan.pageSize),
          ),
        }
      : { rows: selected }),
    nextCursor,
    previousCursor,
  };
  acceptsSearchOutput(plan.descriptor.node.public, page, () => {
    throw new ORPCError("QUERY_BUDGET_EXCEEDED", { message: "Search result exceeds publication budget" });
  });
  if (!acceptsSearchPage(plan.descriptor.node.public, { ...plan.input, count: false }, page, true))
    throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "Invalid selected search result" });
  return page;
}
