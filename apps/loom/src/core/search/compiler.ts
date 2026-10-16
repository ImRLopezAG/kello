import {
  and,
  or,
  not,
  eq,
  ne,
  gt,
  gte,
  lt,
  lte,
  inArray,
  notInArray,
  isNull,
  isNotNull,
  sql,
  is,
  SQL,
  getTableColumns,
  relationToSQL,
  getTableAsAliasSQL,
} from "drizzle-orm";
import type { AnyColumn, Relation, TableRelationalConfig } from "drizzle-orm";
import { alias, PgTable } from "drizzle-orm/pg-core";
import { ORPCError } from "@orpc/server";
import * as v from "valibot";
import type { InvocationIdentity } from "../server/auth/context";
import type { SearchRuntimeDescriptor, SearchRuntimeNode, RuntimeSearchScope } from "./metadata";
import type { SearchPublicSelection, SearchPublicFilter } from "./public";
import { validSearchSelection, selectedColumns, searchRecord } from "./public";
import { fullTextExpressions, fullTextBudgetExceeded } from "./full-text";
import type { ResolvedFullText } from "./full-text";

export interface CompiledSearch {
  readonly config: SearchQueryConfig;
  /** The same authorized root predicate is used for rows and optional count. */
  readonly where: (table: TableRelationalConfig["table"]) => SQL;
  readonly dependencies: ReadonlySet<string>;
  /** Private live evidence: consume only after lazy row and count SQL has executed. */
  readonly dependencyEvidence: {
    readonly dependencies: ReadonlySet<string>;
    readonly complete: boolean;
  };
}
export interface SearchQueryConfig {
  readonly columns: Record<string, boolean>;
  readonly with: Record<string, SearchQueryConfig>;
  readonly where: { readonly RAW: (table: TableRelationalConfig["table"]) => SQL };
  readonly orderBy: (table: TableRelationalConfig["table"]) => SQL[];
  readonly limit: number;
}
type FilterValue = SearchPublicFilter[string];
function table(value: TableRelationalConfig["table"]): PgTable {
  if (!is(value, PgTable)) throw new Error("Search requires a compiled PostgreSQL table");
  return value;
}
export function searchColumn(value: TableRelationalConfig["table"], name: string): AnyColumn {
  const column = getTableColumns(table(value))[name];
  if (!column) throw new Error("Search field is absent from the compiled table");
  return column;
}
function scope(
  value: "public" | RuntimeSearchScope,
  table: TableRelationalConfig["table"],
  identity: InvocationIdentity | null,
): SQL {
  if (value === "public") return sql`true`;
  const predicate = value.where({ table, identity });
  if (!is(predicate, SQL)) throw new Error("Search scope must return native SQL");
  return predicate;
}
function combine(predicates: readonly SQL[], kind: "AND" | "OR" = "AND"): SQL {
  return (kind === "AND" ? and(...predicates) : or(...predicates)) ?? (kind === "AND" ? sql`true` : sql`false`);
}
function record(value: FilterValue): SearchPublicFilter {
  return v.parse(v.custom<SearchPublicFilter>(searchRecord), value);
}
function escapedPattern(value: FilterValue, operator: string) {
  const escaped = v.parse(v.string(), value).replace(/[\\%_]/g, "\\$&");
  return `${operator === "startsWith" ? "" : "%"}${escaped}${operator === "endsWith" ? "" : "%"}`;
}
function scalar(column: AnyColumn, conditions: FilterValue): SQL[] {
  const values = record(conditions);
  const predicates: SQL[] = [];
  for (const [operator, value] of Object.entries(values)) {
    if (value === undefined || operator === "insensitive") continue;
    switch (operator) {
      case "eq":
        predicates.push(eq(column, value));
        break;
      case "ne":
        predicates.push(ne(column, value));
        break;
      case "gt":
        predicates.push(gt(column, value));
        break;
      case "gte":
        predicates.push(gte(column, value));
        break;
      case "lt":
        predicates.push(lt(column, value));
        break;
      case "lte":
        predicates.push(lte(column, value));
        break;
      case "in":
        predicates.push(inArray(column, v.parse(v.array(v.unknown()), value)));
        break;
      case "notIn":
        predicates.push(notInArray(column, v.parse(v.array(v.unknown()), value)));
        break;
      case "isNull":
        predicates.push(value ? isNull(column) : isNotNull(column));
        break;
      case "contains":
      case "startsWith":
      case "endsWith":
        predicates.push(
          values.insensitive === true
            ? sql`${column} ilike ${escapedPattern(value, operator)} escape '\\'`
            : sql`${column} like ${escapedPattern(value, operator)} escape '\\'`,
        );
        break;
      default:
        throw new ORPCError("INVALID_SELECTION");
    }
  }
  return predicates;
}
/** Compile only a validated descriptor and selection, using native aliases and encoders. */
export function compileSearch(
  descriptor: SearchRuntimeDescriptor,
  input: SearchPublicSelection,
  identity: InvocationIdentity | null,
  fullText?: ResolvedFullText,
): CompiledSearch {
  if (!validSearchSelection(descriptor.node.public, input, fullTextBudgetExceeded))
    throw new ORPCError("INVALID_SELECTION");
  if (Boolean(input.fullText) !== Boolean(fullText)) throw new Error("Full-text search requires parser preflight");
  if (fullText && (input.fullText?.document !== fullText.name || input.fullText.query !== fullText.raw))
    throw new Error("Full-text preflight belongs to a different query");
  const dependencies = new Set<string>([descriptor.entity]);
  let complete = true;
  const dependencyEvidence = {
    dependencies,
    get complete() {
      return complete;
    },
  };
  function policyScope(value: "public" | RuntimeSearchScope, source: TableRelationalConfig["table"]): SQL {
    if (value !== "public") {
      if (value.dependencies === undefined) complete = false;
      else for (const name of value.dependencies) dependencies.add(name);
    }
    return scope(value, source, identity);
  }
  const tableNames = new Map(Object.entries(descriptor.graph).map(([name, config]) => [config.table, name]));
  function configNode(node: SearchRuntimeNode) {
    const value = descriptor.graph[node.entity];
    if (!value) throw new Error("Search graph is incomplete");
    return value;
  }
  function junction(node: SearchRuntimeNode, relation: Relation) {
    const name = relation.throughTable && tableNames.get(relation.throughTable);
    if (!name || !Object.hasOwn(node.through, name)) throw new Error("Search junction scope is missing");
    dependencies.add(name);
    const policy = node.through[name];
    if (!policy) throw new Error("Search junction scope is missing");
    return { table: table(descriptor.graph[name]!.table), policy };
  }
  function collect(node: SearchRuntimeNode, filter: SearchPublicFilter | undefined): void {
    for (const [name, condition] of Object.entries(filter ?? {})) {
      if (condition === undefined) continue;
      if (name === "AND" || name === "OR") {
        for (const child of v.parse(v.array(v.custom<SearchPublicFilter>(searchRecord)), condition))
          collect(node, child);
      } else if (name === "NOT") collect(node, record(condition));
      else if (name === "relations") {
        for (const [name, conditions] of Object.entries(record(condition))) {
          const relation = configNode(node).relations[name];
          const child = node.relations[name];
          if (!relation || !child) throw new ORPCError("INVALID_SELECTION");
          dependencies.add(child.entity);
          if (relation.throughTable) junction(node, relation);
          for (const filter of Object.values(record(conditions))) collect(child, record(filter));
        }
      }
    }
  }
  function predicate(
    node: SearchRuntimeNode,
    source: TableRelationalConfig["table"],
    filter: SearchPublicFilter | undefined,
  ): SQL {
    let sequence = 0;
    function visit(
      node: SearchRuntimeNode,
      source: TableRelationalConfig["table"],
      filter: SearchPublicFilter | undefined,
    ): SQL {
      dependencies.add(node.entity);
      const predicates = [policyScope(node.scope, source)];
      for (const [name, condition] of Object.entries(filter === undefined ? {} : record(filter))) {
        if (condition === undefined) continue;
        if (name === "AND" || name === "OR") {
          predicates.push(
            combine(
              v
                .parse(v.array(v.custom<SearchPublicFilter>(searchRecord)), condition)
                .map((value) => visit(node, source, value)),
              name,
            ),
          );
        } else if (name === "NOT") {
          // Authorization stays outside NOT, which negates only client membership.
          predicates.push(not(client(node, source, record(condition))));
        } else if (name === "relations") {
          for (const [relationName, conditions] of Object.entries(record(condition))) {
            const relation = configNode(node).relations[relationName];
            const child = node.relations[relationName];
            if (!relation || !child) throw new ORPCError("INVALID_SELECTION");
            for (const [mode, childFilter] of Object.entries(record(conditions))) {
              const target = alias(table(relation.targetTable), `s${++sequence}`);
              const through = relation.throughTable ? junction(node, relation) : undefined;
              const throughTable = through ? alias(through.table, `j${++sequence}`) : undefined;
              const joins = relationToSQL(relation, source, target, throughTable);
              const match = combine([
                ...(joins.filter ? [joins.filter] : []),
                visit(child, target, record(childFilter)),
                ...(through && throughTable ? [policyScope(through.policy, throughTable)] : []),
              ]);
              const join = throughTable
                ? sql`inner join ${getTableAsAliasSQL(throughTable)} on ${joins.joinCondition}`
                : sql``;
              const exists = sql`exists (select 1 from ${getTableAsAliasSQL(target)} ${join} where ${match})`;
              predicates.push(mode === "none" || mode === "isNot" ? not(exists) : exists);
            }
          }
        } else {
          predicates.push(...scalar(searchColumn(source, name), condition));
        }
      }
      return combine(predicates);
    }
    function client(node: SearchRuntimeNode, source: TableRelationalConfig["table"], filter: SearchPublicFilter): SQL {
      // Scope is applied to related rows, but root authorization cannot be negated.
      return visit({ ...node, scope: "public" }, source, filter);
    }
    return visit(node, source, filter);
  }
  function projection(
    node: SearchRuntimeNode,
    selection: SearchPublicSelection,
    depth: number,
    incoming?: { node: SearchRuntimeNode; relation: Relation },
  ): SearchQueryConfig {
    dependencies.add(node.entity);
    collect(node, selection.where);
    const children: Record<string, SearchQueryConfig> = {};
    for (const [name, childSelection] of Object.entries(selection.with ?? {})) {
      const child = node.relations[name];
      const relation = configNode(node).relations[name];
      if (!child || !relation) throw new ORPCError("INVALID_SELECTION");
      children[name] = projection(child, childSelection, depth + 1, { node, relation });
    }
    if (incoming?.relation.throughTable) junction(incoming.node, incoming.relation);
    return {
      columns: Object.fromEntries(selectedColumns(node.public, selection).map((name) => [name, true])),
      with: children,
      where: {
        RAW: (source) => {
          const predicates = [predicate(node, source, selection.where)];
          if (depth === 0 && fullText) predicates.push(fullTextExpressions(source, fullText).match);
          if (incoming?.relation.throughTable) {
            const through = junction(incoming.node, incoming.relation);
            // Pinned Drizzle RQB v2 uses tr{parentDepth} for its exact joined junction.
            predicates.push(policyScope(through.policy, alias(through.table, `tr${depth - 1}`)));
          }
          return combine(predicates);
        },
      },
      orderBy: (source) =>
        (
          selection.orderBy ?? [
            { field: "_createdAt", direction: "asc" },
            { field: "_id", direction: "asc" },
          ]
        ).map(
          (order) =>
            sql`${searchColumn(source, order.field)} ${order.direction === "asc" ? sql`asc` : sql`desc`} nulls ${order.nulls === "first" ? sql`first` : sql`last`}`,
        ),
      limit:
        selection.limit ??
        Math.min(depth ? 20 : 50, depth ? descriptor.budgets.nestedSize : descriptor.budgets.pageSize),
    };
  }
  const where = (source: TableRelationalConfig["table"]) =>
    fullText
      ? combine([predicate(descriptor.node, source, input.where), fullTextExpressions(source, fullText).match])
      : predicate(descriptor.node, source, input.where);
  const config = projection(descriptor.node, input, 0);
  return { config, where, dependencies, dependencyEvidence };
}
