import * as v from "valibot";
import { storageParser, systemParsers, wire } from "../validation/encoding";
import type { StorageRow, StorageValue } from "../validation/encoding";
import type { FieldMetadata } from "../schema/fields";
import type { SearchBudgets } from "./types";

/** Masked projection and query capabilities emitted to browser clients. */
export interface SearchPublicNode {
  readonly columns: Readonly<Record<string, FieldMetadata | "_id" | "_createdAt">>;
  readonly relations: Readonly<
    Record<string, { readonly many: boolean; readonly optional: boolean; readonly node: SearchPublicNode }>
  >;
  readonly fields?: Readonly<Record<string, FieldMetadata | "_id" | "_createdAt">> | undefined;
  readonly filter?: readonly string[] | undefined;
  readonly order?: readonly string[] | undefined;
  readonly text?: readonly string[] | undefined;
  readonly fullText?: Readonly<Record<string, { readonly semantics: string }>> | undefined;
  readonly mode?: "finite" | undefined;
  readonly budgets?: SearchBudgets | undefined;
}
export interface SearchPublicFilter {
  readonly [field: string]: StorageValue | SearchPublicFilter | readonly SearchPublicFilter[] | undefined;
}
export interface SearchOrder {
  readonly field: string;
  readonly direction: "asc" | "desc";
  readonly nulls?: "first" | "last";
}
export interface SearchPublicSelection {
  readonly fullText?: { readonly document: string; readonly query: string };
  readonly columns?: Readonly<Record<string, boolean>>;
  readonly with?: Readonly<Record<string, SearchPublicSelection>>;
  readonly where?: SearchPublicFilter;
  readonly orderBy?: readonly SearchOrder[];
  readonly limit?: number;
  readonly cursor?: string | null;
  readonly direction?: "forward" | "backward";
  readonly count?: boolean;
}
export interface SearchCachedPage {
  readonly rows?: StorageRow[];
  readonly nextCursor: string | null;
  readonly previousCursor: string | null;
  readonly count?: string;
}
export const defaultSearchBudgets: SearchBudgets = Object.freeze({
  pageSize: 100,
  nestedSize: 100,
  predicates: 100,
  listSize: 100,
  textLength: 1024,
  inputBytes: 65536,
  resultBytes: 1048576,
  rows: 5000,
  cursorSeconds: 3600,
});
/** Added only to descriptors with a root FTS grant. */
export const defaultFullTextBudgets = Object.freeze({
  fullTextQueryBytes: 4096,
  fullTextQueryNodes: 128,
  fullTextTimeoutMs: 5000,
});
const record = v.record(v.string(), v.unknown());
const choice = v.record(v.string(), v.boolean());
const operators = new Set([
  "eq",
  "ne",
  "in",
  "notIn",
  "isNull",
  "gt",
  "gte",
  "lt",
  "lte",
  "contains",
  "startsWith",
  "endsWith",
  "insensitive",
]);
const forbidden = new Set(["__proto__", "prototype", "constructor"]);

/** Reject accessors and prototype-like keys before reading untrusted properties. */
export function searchRecord(value: unknown): value is v.InferOutput<typeof record> {
  if (!v.is(v.object({}), value) || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some((key) => !v.is(v.string(), key) || forbidden.has(key))) return false;
  if (
    Object.values(descriptors).some(
      (entry) => Object.hasOwn(entry, "get") || Object.hasOwn(entry, "set") || !entry.enumerable,
    )
  )
    return false;
  return v.is(record, value);
}
type SearchPayload =
  | undefined
  | null
  | boolean
  | number
  | string
  | bigint
  | Date
  | readonly SearchPayload[]
  | { readonly [name: string]: SearchPayload };
const primitive = v.union([
  v.undefined(),
  v.null(),
  v.boolean(),
  v.pipe(v.number(), v.finite()),
  v.string(),
  v.bigint(),
]);
/** Inspect descriptors before codecs can traverse JSON fields or arrays. */
function safePayload(value: unknown, maxNodes: number, onBudgetExceeded?: () => void): value is SearchPayload {
  let nodes = 0;
  const ancestors = new Set<object>();
  function visit(value: unknown, depth: number): value is SearchPayload {
    if (++nodes > maxNodes) {
      onBudgetExceeded?.();
      return false;
    }
    if (depth > 32) return false;
    if (v.is(primitive, value)) return true;
    if (value instanceof Date)
      return (
        Object.getPrototypeOf(value) === Date.prototype &&
        !Reflect.ownKeys(value).length &&
        Number.isFinite(Date.prototype.getTime.call(value))
      );
    if (Array.isArray(value) ? Object.getPrototypeOf(value) !== Array.prototype : !searchRecord(value)) return false;
    if (ancestors.has(value)) return false;
    ancestors.add(value);
    try {
      const entries = Object.getOwnPropertyDescriptors(value);
      if (Object.values(entries).some((entry) => Object.hasOwn(entry, "get") || Object.hasOwn(entry, "set")))
        return false;
      if (Array.isArray(value) && Reflect.ownKeys(entries).length !== value.length + 1) return false;
      return Object.entries(entries).every(
        ([name, descriptor]) => (Array.isArray(value) && name === "length") || visit(descriptor.value, depth + 1),
      );
    } finally {
      ancestors.delete(value);
    }
  }
  return visit(value, 0);
}
function payloadBytes(value: SearchPayload): number {
  function normalize(value: SearchPayload): StorageValue | undefined {
    if (value === undefined) return undefined;
    if (v.is(primitive, value) || value instanceof Date) return value;
    if (Array.isArray(value)) return value.map((item) => normalize(item) ?? null);
    return Object.fromEntries(
      Object.entries(value).flatMap(([name, item]) => {
        const normalized = normalize(item);
        return normalized === undefined ? [] : [[name, normalized] as const];
      }),
    );
  }
  return new TextEncoder().encode(JSON.stringify(v.parse(wire, normalize(value)))).byteLength;
}
function scalarParser(field: FieldMetadata | "_id" | "_createdAt") {
  return field === "_id" || field === "_createdAt" ? systemParsers[field] : storageParser(field);
}
function scalarKind(field: FieldMetadata | "_id" | "_createdAt") {
  return field === "_id" ? "uuid" : field === "_createdAt" ? "integer" : field.kind;
}

export function validSearchSelection(
  node: SearchPublicNode,
  input: unknown,
  onBudgetExceeded?: () => void,
): input is SearchPublicSelection {
  const budgets = node.budgets ?? defaultSearchBudgets;
  const state = { predicates: 0, nodes: 0 };
  function filter(
    node: SearchPublicNode,
    value: unknown,
    relationDepth: number,
    booleanDepth: number,
  ): value is SearchPublicFilter {
    if (++state.nodes > budgets.predicates * 10 || booleanDepth > 8 || relationDepth > 4 || !searchRecord(value))
      return false;
    for (const [key, operand] of Object.entries(value)) {
      if (key === "AND" || key === "OR") {
        if (
          !Array.isArray(operand) ||
          operand.length > budgets.predicates ||
          !operand.every((item) => filter(node, item, relationDepth, booleanDepth + 1))
        )
          return false;
      } else if (key === "NOT") {
        if (!filter(node, operand, relationDepth, booleanDepth + 1)) return false;
      } else if (key === "relations") {
        if (!searchRecord(operand)) return false;
        for (const [name, conditions] of Object.entries(operand)) {
          const child = Object.hasOwn(node.relations, name) ? node.relations[name] : undefined;
          if (!child || !searchRecord(conditions) || !Object.keys(conditions).length) return false;
          for (const [mode, condition] of Object.entries(conditions)) {
            if (
              !(child.many ? ["some", "none"] : ["is", "isNot"]).includes(mode) ||
              !filter(child.node, condition, relationDepth + 1, booleanDepth)
            )
              return false;
          }
        }
      } else {
        const field = node.fields?.[key] ?? node.columns[key];
        if (!node.filter?.includes(key) || !field || !searchRecord(operand) || !Object.keys(operand).length)
          return false;
        for (const [op, value] of Object.entries(operand)) {
          if (++state.predicates > budgets.predicates || !operators.has(op)) return false;
          const kind = scalarKind(field);
          if (op === "isNull") {
            if (field === "_id" || field === "_createdAt" || field.notNull || !v.is(v.boolean(), value)) return false;
          } else if (["contains", "startsWith", "endsWith", "insensitive"].includes(op)) {
            if (!node.text?.includes(key) || !["text", "enum"].includes(kind)) return false;
            if (
              op === "insensitive" &&
              !["contains", "startsWith", "endsWith"].some((key) => Object.hasOwn(operand, key))
            )
              return false;
            if (
              op === "insensitive"
                ? !v.is(v.boolean(), value)
                : !v.is(v.pipe(v.string(), v.maxLength(budgets.textLength)), value)
            )
              return false;
          } else {
            if (["gt", "gte", "lt", "lte"].includes(op) && ["json", "boolean"].includes(kind)) return false;
            if (op === "in" || op === "notIn") {
              if (
                !Array.isArray(value) ||
                value.length > budgets.listSize ||
                !value.every((item) => item !== null && v.is(scalarParser(field), item))
              )
                return false;
            } else if (value === null || !v.is(scalarParser(field), value)) return false;
            if (v.is(v.string(), value) && value.length > budgets.textLength) return false;
          }
        }
      }
    }
    return true;
  }
  function selection(node: SearchPublicNode, value: unknown, depth: number): value is SearchPublicSelection {
    if (++state.nodes > budgets.predicates * 10 || depth > 4 || !searchRecord(value)) return false;
    const controls = [
      "columns",
      "with",
      "where",
      "orderBy",
      "limit",
      ...(depth || !node.fullText ? [] : ["fullText"]),
      ...(depth ? [] : ["cursor", "direction", "count"]),
    ];
    if (Object.keys(value).some((key) => !controls.includes(key))) return false;
    if (value.fullText !== undefined) {
      const match = value.fullText;
      if (
        depth ||
        !searchRecord(match) ||
        Object.keys(match).some((key) => !["document", "query"].includes(key)) ||
        !v.is(v.string(), match.document) ||
        !Object.hasOwn(node.fullText ?? {}, match.document) ||
        !v.is(v.string(), match.query) ||
        value.orderBy !== undefined ||
        match.query.includes("\0") ||
        /[\uD800-\uDFFF]/u.test(match.query)
      )
        return false;
      if (
        match.query.length > budgets.textLength ||
        new TextEncoder().encode(match.query).byteLength >
          (budgets.fullTextQueryBytes ?? defaultFullTextBudgets.fullTextQueryBytes)
      ) {
        onBudgetExceeded?.();
        return false;
      }
    }
    const size = depth ? budgets.nestedSize : budgets.pageSize;
    if (
      value.limit !== undefined &&
      !v.is(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(size)), value.limit)
    )
      return false;
    for (const key of ["cursor"])
      if (value[key] !== undefined && value[key] !== null && !v.is(v.pipe(v.string(), v.maxLength(4096)), value[key]))
        return false;
    if (value.direction !== undefined && value.direction !== "forward" && value.direction !== "backward") return false;
    if (value.count !== undefined && !v.is(v.boolean(), value.count)) return false;
    if (value.columns !== undefined) {
      if (
        !searchRecord(value.columns) ||
        !v.is(choice, value.columns) ||
        !Object.keys(value.columns).length ||
        Object.keys(value.columns).some((key) => !Object.hasOwn(node.columns, key))
      )
        return false;
      const choices = Object.values(value.columns);
      if ((choices.includes(true) && choices.includes(false)) || !selectedColumns(node, value).length) return false;
    }
    if (value.where !== undefined && !filter(node, value.where, depth, 0)) return false;
    if (value.orderBy !== undefined) {
      if (!Array.isArray(value.orderBy) || !value.orderBy.length || value.orderBy.length > 8) return false;
      const fields = new Set<string>();
      for (const order of value.orderBy) {
        if (
          !searchRecord(order) ||
          Object.keys(order).some((key) => !["field", "direction", "nulls"].includes(key)) ||
          !v.is(v.string(), order.field) ||
          !node.order?.includes(order.field) ||
          fields.has(order.field) ||
          !v.is(v.picklist(["asc", "desc"]), order.direction) ||
          (order.nulls !== undefined && !v.is(v.picklist(["first", "last"]), order.nulls))
        )
          return false;
        fields.add(order.field);
      }
    }
    if (value.with !== undefined) {
      if (!searchRecord(value.with)) return false;
      for (const [name, child] of Object.entries(value.with)) {
        const relation = Object.hasOwn(node.relations, name) ? node.relations[name] : undefined;
        if (!relation || !selection(relation.node, child, depth + 1)) return false;
      }
    }
    return true;
  }
  if (
    !safePayload(input, budgets.predicates * 20 + budgets.listSize * budgets.predicates) ||
    !selection(node, input, 0)
  )
    return false;
  // Storage encoding is lossless and does not invoke user-defined JSON methods.
  return payloadBytes(input) <= budgets.inputBytes;
}

export function selectedColumns(node: SearchPublicNode, input: SearchPublicSelection) {
  if (!v.is(choice, input.columns)) return Object.keys(node.columns);
  const columns = input.columns;
  return Object.values(columns).includes(true)
    ? Object.keys(columns).filter((key) => columns[key])
    : Object.keys(node.columns).filter((key) => columns[key] !== false);
}
/** Cache values allow compatible extras; server publication uses strict mode. */
export function acceptsSearchPage(
  node: SearchPublicNode,
  input: SearchPublicSelection,
  data: unknown,
  strict = false,
): data is SearchCachedPage {
  if (
    !safePayload(data, (node.budgets ?? defaultSearchBudgets).rows * 100) ||
    !searchRecord(data) ||
    !v.is(v.nullable(v.string()), data.nextCursor) ||
    !v.is(v.nullable(v.string()), data.previousCursor)
  )
    return false;
  if (data.count !== undefined && !v.is(v.pipe(v.string(), v.regex(/^\d+$/)), data.count)) return false;
  if (
    strict &&
    (Object.keys(data).some(
      (key) => !["rows", "nextCursor", "previousCursor", ...(input.count ? ["count"] : [])].includes(key),
    ) ||
      (input.count === true && data.count === undefined))
  )
    return false;
  let rows = 0;
  const budgets = node.budgets ?? defaultSearchBudgets;
  function acceptsRow(node: SearchPublicNode, input: SearchPublicSelection, row: unknown): row is StorageRow {
    if (++rows > budgets.rows || !searchRecord(row)) return false;
    const selected = selectedColumns(node, input);
    if (strict && Object.keys(row).some((key) => !selected.includes(key) && !Object.hasOwn(input.with ?? {}, key)))
      return false;
    for (const name of selected) {
      const field = node.columns[name];
      if (!field || !Object.hasOwn(row, name) || !v.is(scalarParser(field), row[name])) return false;
    }
    for (const [name, selection] of Object.entries(input.with ?? {})) {
      const relation = node.relations[name];
      if (!relation || !Object.hasOwn(row, name)) return false;
      const value = row[name];
      if (relation.many) {
        if (
          !Array.isArray(value) ||
          value.length > (selection.limit ?? Math.min(20, budgets.nestedSize)) ||
          !value.every((item) => acceptsRow(relation.node, selection, item))
        )
          return false;
      } else if (value === null ? !relation.optional && !selection.where : !acceptsRow(relation.node, selection, value))
        return false;
    }
    return true;
  }
  return (
    Array.isArray(data.rows) &&
    data.rows.length <= (input.limit ?? Math.min(50, budgets.pageSize)) &&
    data.rows.every((row) => acceptsRow(node, input, row))
  );
}

/** Validate every eligible output field before per-request projection checks. */
export function acceptsSearchOutput(
  node: SearchPublicNode,
  value: unknown,
  onBudgetExceeded?: () => void,
): value is SearchCachedPage {
  const budgets = node.budgets ?? defaultSearchBudgets;
  if (!safePayload(value, budgets.rows * 100, onBudgetExceeded) || !searchRecord(value)) return false;
  let visited = 0;
  let overBudget = false;
  function row(node: SearchPublicNode, value: unknown, depth: number): value is StorageRow {
    if (++visited > budgets.rows) {
      overBudget = true;
      return false;
    }
    if (depth > 4 || !searchRecord(value) || !Object.keys(value).length) return false;
    let scalars = 0;
    for (const [name, item] of Object.entries(value)) {
      if (Object.hasOwn(node.columns, name)) {
        const field = node.columns[name];
        if (!field || !v.is(scalarParser(field), item)) return false;
        scalars++;
      } else {
        const relation = Object.hasOwn(node.relations, name) ? node.relations[name] : undefined;
        if (
          !relation ||
          (relation.many
            ? !Array.isArray(item) ||
              item.length > budgets.nestedSize ||
              !item.every((item) => row(relation.node, item, depth + 1))
            : item !== null && !row(relation.node, item, depth + 1))
        )
          return false;
      }
    }
    return scalars > 0;
  }
  const key = "rows";
  if (
    Object.keys(value).some((name) => ![key, "nextCursor", "previousCursor", "count"].includes(name)) ||
    !v.is(v.nullable(v.string()), value.nextCursor) ||
    !v.is(v.nullable(v.string()), value.previousCursor) ||
    (value.count !== undefined && !v.is(v.pipe(v.string(), v.regex(/^\d+$/)), value.count))
  )
    return false;
  if (
    !Array.isArray(value.rows) ||
    value.rows.length > budgets.pageSize ||
    !value.rows.every((item) => row(node, item, 0))
  ) {
    if (overBudget) onBudgetExceeded?.();
    return false;
  }
  const encoded = v.safeParse(wire, value);
  if (!encoded.success) return false;
  if (new TextEncoder().encode(JSON.stringify(encoded.output)).byteLength > budgets.resultBytes) {
    onBudgetExceeded?.();
    return false;
  }
  return true;
}
