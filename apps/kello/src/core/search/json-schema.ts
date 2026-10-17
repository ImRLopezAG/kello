import type { FieldMetadata } from "../schema/fields";
import type { SearchPublicNode } from "./public";
import { defaultSearchBudgets } from "./public";

export type SearchJsonSchema = {
  readonly type?: string | readonly string[];
  readonly properties?: Readonly<Record<string, SearchJsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly items?: SearchJsonSchema;
  readonly not?: SearchJsonSchema;
  readonly anyOf?: readonly SearchJsonSchema[];
  readonly enum?: readonly string[] | undefined;
  readonly format?: string;
  readonly pattern?: string;
  readonly minProperties?: number;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly maxLength?: number;
  readonly $ref?: string;
  readonly $defs?: Readonly<Record<string, SearchJsonSchema>>;
  readonly "x-native-type"?: "bigint" | "date";
};
type JsonSchema = SearchJsonSchema;
interface CompiledJsonNode {
  readonly input: JsonSchema;
  readonly row: JsonSchema;
  readonly filter: JsonSchema;
}
interface SearchJsonSchemas {
  readonly input: JsonSchema;
  readonly output: JsonSchema;
}
function properties(entries: readonly (readonly [string, JsonSchema])[]) {
  return Object.fromEntries(entries);
}
function object(properties: Record<string, JsonSchema>, required: readonly string[] = []): JsonSchema {
  return { type: "object", properties, required, additionalProperties: false };
}
function scalar(field: FieldMetadata | "_id" | "_createdAt", nullable = true): JsonSchema {
  const kind = field === "_id" ? "uuid" : field === "_createdAt" ? "integer" : field.kind;
  const value: JsonSchema =
    kind === "boolean"
      ? { type: "boolean" }
      : kind === "integer"
        ? { type: "integer" }
        : kind === "bigint"
          ? { type: "string", pattern: "^-?\\d+$", "x-native-type": "bigint" }
          : kind === "timestamp"
            ? { type: "string", format: "date-time", "x-native-type": "date" }
            : kind === "uuid" || kind === "reference"
              ? { type: "string", format: "uuid" }
              : kind === "json"
                ? {}
                : kind === "enum" && field !== "_id" && field !== "_createdAt"
                  ? { type: "string", enum: field.enumValues }
                  : { type: "string" };
  return nullable && field !== "_id" && field !== "_createdAt" && !field.notNull
    ? { anyOf: [value, { type: "null" }] }
    : value;
}
/** Public capability schemas contain no table names, authorization callbacks or credentials. */
export function searchJsonSchemas(root: SearchPublicNode): SearchJsonSchemas {
  const budgets = root.budgets ?? defaultSearchBudgets;
  const definitions: Record<string, JsonSchema> = {};
  let sequence = 0;
  function compile(node: SearchPublicNode, depth: number): CompiledJsonNode {
    const name = `filter${sequence++}`;
    const filterRef = { $ref: `#/$defs/${name}` };
    const rows: Record<string, JsonSchema> = {};
    const children: Record<string, JsonSchema> = {};
    const relationFilters: Record<string, JsonSchema> = {};
    for (const [field, metadata] of Object.entries(node.columns)) rows[field] = scalar(metadata);
    for (const [relation, value] of Object.entries(node.relations)) {
      const child = compile(value.node, depth + 1);
      children[relation] = child.input;
      rows[relation] = value.many
        ? { type: "array", items: child.row, maxItems: budgets.nestedSize }
        : { anyOf: [child.row, { type: "null" }] };
      relationFilters[relation] = object(
        Object.fromEntries((value.many ? ["some", "none"] : ["is", "isNot"]).map((mode) => [mode, child.filter])),
      );
    }
    const filters: Record<string, JsonSchema> = {};
    for (const field of node.filter ?? []) {
      const metadata = node.fields?.[field] ?? node.columns[field];
      if (!metadata) throw new Error(`Missing search field metadata: ${field}`);
      const value = scalar(metadata, false);
      const operators = properties([
        ["eq", value],
        ["ne", value],
        ["in", { type: "array", items: value, maxItems: budgets.listSize }],
        ["notIn", { type: "array", items: value, maxItems: budgets.listSize }],
      ]);
      if (metadata !== "_id" && metadata !== "_createdAt" && !metadata.notNull) operators.isNull = { type: "boolean" };
      if (metadata === "_id" || metadata === "_createdAt" || !["json", "boolean"].includes(metadata.kind))
        for (const operator of ["gt", "gte", "lt", "lte"]) operators[operator] = value;
      if (node.text?.includes(field)) {
        for (const operator of ["contains", "startsWith", "endsWith"])
          operators[operator] = { type: "string", maxLength: budgets.textLength };
        operators.insensitive = { type: "boolean" };
      }
      filters[field] = { ...object(operators), minProperties: 1 };
    }
    definitions[name] = object({
      ...filters,
      AND: { type: "array", items: filterRef, maxItems: budgets.predicates },
      OR: { type: "array", items: filterRef, maxItems: budgets.predicates },
      NOT: filterRef,
      relations: object(relationFilters),
    });
    const controls = properties([
      [
        "columns",
        {
          ...object(Object.fromEntries(Object.keys(node.columns).map((field) => [field, { type: "boolean" }]))),
          minProperties: 1,
        },
      ],
      ["with", object(children)],
      ["where", filterRef],
      [
        "orderBy",
        {
          type: "array",
          minItems: 1,
          maxItems: 8,
          items: object(
            {
              field: { type: "string", enum: node.order ?? [] },
              direction: { enum: ["asc", "desc"] },
              nulls: { enum: ["first", "last"] },
            },
            ["field", "direction"],
          ),
        },
      ],
      ["limit", { type: "integer", minimum: 1, maximum: depth ? budgets.nestedSize : budgets.pageSize }],
    ]);
    if (!depth) {
      if (node.fullText)
        controls.fullText = object(
          {
            document: { type: "string", enum: Object.keys(node.fullText) },
            query: { type: "string", maxLength: budgets.textLength },
          },
          ["document", "query"],
        );
      controls.count = { type: "boolean" };
      controls.cursor = { type: ["string", "null"], maxLength: 4096 };
      controls.direction = { enum: ["forward", "backward"] };
    }
    const input: { -readonly [Key in keyof JsonSchema]: JsonSchema[Key] } = object(controls);
    if (!depth && node.fullText) input.not = { required: ["fullText", "orderBy"] };
    return { input, row: { ...object(rows), minProperties: 1 }, filter: filterRef };
  }
  const compiled = compile(root, 0);
  const key = "rows";
  const page: JsonSchema = { type: "array", items: compiled.row, maxItems: budgets.pageSize };
  return {
    input: { ...compiled.input, $defs: definitions },
    output: object(
      {
        [key]: page,
        nextCursor: { type: ["string", "null"] },
        previousCursor: { type: ["string", "null"] },
        count: { type: "string", pattern: "^\\d+$" },
      },
      [key, "nextCursor", "previousCursor"],
    ),
  };
}
