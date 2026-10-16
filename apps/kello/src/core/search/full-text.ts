import { sql, getTableColumns, is } from "drizzle-orm";
import type { SQL, TableRelationalConfig } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { ORPCError } from "@orpc/server";
import * as v from "valibot";
import { fullTextVector } from "../schema/full-text";
import type { CompiledFullText } from "../schema/full-text";
import type { SearchRuntimeDescriptor } from "./metadata";
import type { SearchPublicSelection } from "./public";
import { validSearchSelection, defaultFullTextBudgets } from "./public";

export interface ResolvedFullText {
  readonly document: CompiledFullText[string];
  readonly name: string;
  readonly raw: string;
  readonly canonical: string;
  readonly empty: boolean;
}
export function fullTextBudgetExceeded(): never {
  throw new ORPCError("QUERY_BUDGET_EXCEEDED", { message: "Full-text query exceeds its configured budget" });
}
function selection(descriptor: SearchRuntimeDescriptor, input: SearchPublicSelection) {
  if (!validSearchSelection(descriptor.node.public, input, fullTextBudgetExceeded) || !input.fullText)
    throw new ORPCError("INVALID_SELECTION");
  const document = descriptor.node.fullText?.[input.fullText.document];
  if (!document) throw new ORPCError("INVALID_SELECTION");
  return { document, name: input.fullText.document, raw: input.fullText.query };
}
/** Execute on the owned transaction, before canonical-query cursor binding. */
export function fullTextPreflightSQL(descriptor: SearchRuntimeDescriptor, input: SearchPublicSelection): SQL {
  const { document, raw } = selection(descriptor, input);
  const config =
    document.config === "pg_catalog.english"
      ? sql`'pg_catalog.english'::regconfig`
      : sql`'pg_catalog.simple'::regconfig`;
  return sql`select q::text as canonical, numnode(q) as nodes, querytree(q) as tree
    from (select plainto_tsquery(${config}, ${raw}) as q) as parsed`;
}
const parsedQuery = v.strictObject({
  canonical: v.string(),
  nodes: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  tree: v.string(),
});
export function resolveFullText(
  descriptor: SearchRuntimeDescriptor,
  input: SearchPublicSelection,
  parsed: v.InferInput<typeof parsedQuery>,
): ResolvedFullText {
  const selected = selection(descriptor, input);
  const result = v.parse(parsedQuery, parsed);
  if (result.nodes > (descriptor.budgets.fullTextQueryNodes ?? defaultFullTextBudgets.fullTextQueryNodes))
    fullTextBudgetExceeded();
  if (result.nodes && (!result.canonical || !result.tree.trim() || result.tree.trim() === "T"))
    throw new ORPCError("INVALID_SELECTION", { message: "Full-text query is not indexable" });
  if (!result.nodes && result.canonical !== "") throw new Error("Invalid empty full-text query");
  return Object.freeze({ ...selected, canonical: result.canonical, empty: result.nodes === 0 });
}
/** Match, order, continuation and exact-bit transport share this alias-aware expression. */
export function fullTextExpressions(source: TableRelationalConfig["table"], resolved: ResolvedFullText) {
  if (!is(source, PgTable)) throw new Error("Full-text search requires a PostgreSQL table");
  const columns = getTableColumns(source);
  const vector = fullTextVector(resolved.document, (field) => {
    const column = columns[field];
    if (!column) throw new Error("Missing full-text source");
    return column;
  });
  const query = sql`${resolved.canonical}::tsquery`;
  const rank = sql`ts_rank_cd(ARRAY[0.1,0.2,0.4,1.0]::real[], ${vector}, ${query}, 32)::real`;
  return {
    match: resolved.empty ? sql`false` : sql`${vector} @@ ${query}`,
    rank,
    bits: sql<string>`encode(pg_catalog.float4send(${rank}), 'hex')`,
  };
}
