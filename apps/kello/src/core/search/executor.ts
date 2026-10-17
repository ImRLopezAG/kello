import { AsyncLocalStorage } from "node:async_hooks";
import { sql, is } from "drizzle-orm";
import type { AnyRelations } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { ORPCError } from "@orpc/server";
import * as v from "valibot";
import { acceptsSearchPage, acceptsSearchOutput, validSearchSelection } from "./public";
import type { SearchPublicSelection } from "./public";
import type { SearchRuntimeDescriptor } from "./metadata";
import type { SearchCursorContext } from "./cursor";
import type { SearchProjection, InferSearchInputProjector } from "./types";
import { prepareSearchPage, finishSearchPage } from "./pagination";
import type { SearchPagePlan } from "./pagination";
import type { StorageRow } from "../validation/encoding";
import { storageRows } from "../validation/encoding";
import { scopedDatabase } from "../server/database/context";
import { withSearchDeadline } from "./deadline";
import { fullTextPreflightSQL, resolveFullText } from "./full-text";
import { defaultFullTextBudgets } from "./public";

interface SearchInvocation {
  readonly descriptor: SearchRuntimeDescriptor;
  readonly input: SearchPublicSelection;
  readonly context: SearchCursorContext;
  readonly key: string;
  readonly db: NodePgDatabase;
  readonly signal: AbortSignal;
  readonly assertCurrent: () => void;
  readonly pending: Set<Promise<void>>;
  active: boolean;
  failure?: Error;
}
const invocations = new AsyncLocalStorage<SearchInvocation>();

interface NativeSearchQuery {
  findMany(config: SearchPagePlan["config"]): Promise<StorageRow[]>;
}

/** Run only after authorization and read-only transaction acquisition. */
export async function withSearchInvocation<Result>(
  options: Omit<SearchInvocation, "active" | "pending" | "failure">,
  work: () => Promise<Result>,
): Promise<Result> {
  const scope: SearchInvocation = { ...options, active: true, pending: new Set() };
  try {
    return await invocations.run(scope, async () => {
      try {
        const result = await work();
        while (scope.pending.size) await Promise.all(scope.pending);
        if (scope.failure !== undefined) throw scope.failure;
        return result;
      } finally {
        while (scope.pending.size) await Promise.all(scope.pending);
      }
    });
  } finally {
    scope.active = false;
  }
}

function ownSearchWork<Result>(scope: SearchInvocation, work: () => Promise<Result>): Promise<Result> {
  const result = work();
  const settled = result.then(
    () => {
      scope.pending.delete(settled);
    },
    (cause: unknown) => {
      scope.failure ??= cause instanceof Error ? cause : new Error("Search failed");
      scope.pending.delete(settled);
    },
  );
  scope.pending.add(settled);
  return result;
}

type SearchInputMode<Input, Field extends "rows" | "pages"> = [InferSearchInputProjector<Input>] extends [never]
  ? never
  : Field extends keyof InferSearchInputProjector<Input>["output"]
    ? object
    : never;

export type SearchContext<Graph extends AnyRelations> = {
  readonly [Entity in keyof Graph]: {
    /** Execute this contract's validated input in its authorized read snapshot. */
    readonly paginate: <const Input extends SearchPublicSelection>(
      input: Input & SearchInputMode<Input, "rows">,
    ) => Promise<SearchProjection<InferSearchInputProjector<Input>, Input>>;
  };
};

function currentSearch(graph: AnyRelations, entity: string, input: SearchPublicSelection) {
  const scope = invocations.getStore();
  if (!scope?.active) throw new Error("Requires an active search invocation");
  scope.signal.throwIfAborted();
  scope.assertCurrent();
  if (scope.descriptor.graph !== graph || scope.descriptor.entity !== entity || input !== scope.input)
    throw new Error("Search belongs to a different contract or input");
  return scope;
}

/** Static generated capabilities use the current contract, never caller-supplied policy. */
export function createSearchContext<Graph extends AnyRelations>(graph: Graph): SearchContext<Graph> {
  const entries = Object.keys(graph).map((entity) => [
    entity,
    Object.freeze({
      paginate(input: SearchPublicSelection) {
        const scope = currentSearch(graph, entity, input);
        if (scope.descriptor.mode !== "finite") throw new Error("Pagination requires a finite search contract");
        return ownSearchWork(scope, () => readSearchPage(scope));
      },
    }),
  ]);
  // SAFETY: keys come from the native graph; runtime binds the exact descriptor/input.
  // The phantom input projection retains that descriptor's policy for handler inference.
  return Object.freeze(Object.fromEntries(entries)) as SearchContext<Graph>;
}

/** Finite pages and live windows share one query and optional count in the owned snapshot. */
async function readSearchPage(scope: SearchInvocation) {
  if (scope.input.fullText) {
    return withSearchDeadline(
      scope.db,
      scope.descriptor.graph,
      scope.descriptor.budgets.fullTextTimeoutMs ?? defaultFullTextBudgets.fullTextTimeoutMs,
      scope.signal,
      scope.assertCurrent,
      (statement) => executeSearchPage(scope, statement),
    );
  }
  return executeSearchPage(scope, (read) => read());
}

async function executeSearchPage(
  scope: SearchInvocation,
  statement: <Value>(read: () => Promise<Value>) => Promise<Value>,
) {
  const { input } = scope;
  const db = scopedDatabase(scope.db, scope.descriptor.graph);
  let fullText;
  if (input.fullText) {
    const result = await statement(() =>
      db.execute<{ canonical: string; nodes: number; tree: string }>(fullTextPreflightSQL(scope.descriptor, input)),
    );
    if (result.rows.length !== 1 || !result.rows[0]) throw new Error("Invalid full-text preflight result");
    fullText = resolveFullText(scope.descriptor, input, result.rows[0]);
  }
  const plan = await prepareSearchPage(scope.descriptor, input, scope.context, scope.key, fullText);
  scope.signal.throwIfAborted();
  scope.assertCurrent();
  // SAFETY: every graph entry is a native relational query; its dynamic
  // config is compiled from that graph and its rows are parsed below.
  const query = db.query[scope.descriptor.entity] as NativeSearchQuery | undefined;
  if (!query) throw new Error("Missing search entity");
  // Dynamic graph lookup stays private. The compiler validates native fields,
  // and the raw database result is checked before any selected value escapes.
  const rows = v.parse(storageRows, await statement(() => query.findMany(plan.config)));
  scope.signal.throwIfAborted();
  scope.assertCurrent();
  let page = await finishSearchPage(plan, rows);
  if (input.count) {
    const table = scope.descriptor.graph[scope.descriptor.entity]?.table;
    if (!table || !is(table, PgTable)) throw new Error("Missing search table");
    const result = await statement(async () =>
      db
        .select({ count: sql<string>`count(*)::text` })
        .from(table)
        .where(plan.where(table)),
    );
    page = { ...page, count: v.parse(v.pipe(v.string(), v.regex(/^\d+$/)), result[0]?.count) };
  }
  scope.signal.throwIfAborted();
  scope.assertCurrent();
  const output = validateSelectedSearchOutput(scope.descriptor, input, page);
  return output;
}

/** Check raw handler values before native output schemas can strip or transform them. */
export function validateSelectedSearchOutput<Value>(
  descriptor: SearchRuntimeDescriptor,
  input: SearchPublicSelection,
  value: Value,
): Value {
  const accepted = acceptsSearchOutput(descriptor.node.public, value, () => {
    throw new ORPCError("QUERY_BUDGET_EXCEEDED", { message: "Search result exceeds publication budget" });
  });
  if (
    !validSearchSelection(descriptor.node.public, input) ||
    !acceptsSearchPage(descriptor.node.public, input, value, true) ||
    !accepted
  )
    throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "Invalid selected search result" });
  return value;
}

/** Generated search returns a finite page; ordinary procedure streams are handled by HTTP. */
export function validateSearchHandlerOutput<Value>(
  descriptor: SearchRuntimeDescriptor,
  input: SearchPublicSelection,
  value: Value,
) {
  return validateSelectedSearchOutput(descriptor, input, value);
}
