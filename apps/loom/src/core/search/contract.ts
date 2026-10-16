import type { AnyRelations, TableRelationalConfig, SQL } from "drizzle-orm";
import { One, Relation, is, relationToSQL } from "drizzle-orm";
import { PgDialect, alias, PgTable } from "drizzle-orm/pg-core";
import { eventIterator } from "@orpc/contract";
import type { StandardSchemaV1, StandardJSONSchemaV1 } from "@standard-schema/spec";
import { createHash } from "node:crypto";
import type { SchemaDefinition } from "../schema/define-schema";
import type {
  SearchDescriptor,
  SearchPolicy,
  FullTextPolicyCheck,
  SchemaSearchProjector,
  SchemaLiveSearchProjector,
  SearchWire,
  SearchBudgets,
} from "./types";
import type { SearchPublicNode, SearchPublicSelection, SearchCachedPage } from "./public";
import { validSearchSelection, acceptsSearchOutput, defaultSearchBudgets, defaultFullTextBudgets } from "./public";
import type { RuntimeSearchScope, SearchRuntimeDescriptor, SearchRuntimeNode } from "./metadata";
import { attachSearchMetadata, createSearchInputIssues, fullTextSemantics } from "./metadata";
import type { SearchJsonSchema } from "./json-schema";
import { searchJsonSchemas } from "./json-schema";
import type { CompiledFullText } from "../schema/full-text";
import type { InvocationIdentity } from "../server/auth/context";
import * as v from "valibot";

type CompiledPublicNode = { -readonly [Key in keyof SearchPublicNode]: SearchPublicNode[Key] };
type CompiledRuntimeNode = { -readonly [Key in keyof SearchRuntimeNode]: SearchRuntimeNode[Key] };

interface ScopeFingerprint {
  readonly name: string;
  readonly version: string;
  readonly source: string;
  readonly dependencies?: readonly string[];
}
interface PolicyFingerprint {
  readonly entity: string;
  readonly public: SearchPublicNode;
  readonly scope: "public" | ScopeFingerprint;
  readonly through: Readonly<Record<string, "public" | ScopeFingerprint>>;
  readonly relations: Readonly<Record<string, PolicyFingerprint>>;
}
interface SearchSchema extends SchemaDefinition {
  readonly validators: object;
}
export type SearchTableFactories<Graph extends AnyRelations, Table extends TableRelationalConfig> = {
  readonly search: <const Policy extends SearchPolicy<Graph, Table>>(
    policy: Policy & FullTextPolicyCheck<Table, Policy>,
  ) => SearchDescriptor<SchemaSearchProjector<Graph, Table, Policy>>;
  readonly liveSearch: <const Policy extends SearchPolicy<Graph, Table>>(
    policy: Policy & FullTextPolicyCheck<Table, Policy>,
  ) => SearchDescriptor<
    SchemaLiveSearchProjector<Graph, Table, Policy>,
    AsyncIterableIterator<SearchWire<SchemaLiveSearchProjector<Graph, Table, Policy>>>
  >;
};
export type SearchValidators<Schema extends { readonly validators: object }, Graph extends AnyRelations> = {
  readonly [Name in keyof Schema["validators"]]: Schema["validators"][Name] &
    (Name extends keyof Graph ? SearchTableFactories<Graph, Graph[Name]> : object);
};
const searchNode = Symbol.for("kello.search.public-node.v1");
const field = v.object({
  kind: v.picklist([
    "text",
    "boolean",
    "integer",
    "bigint",
    "numeric",
    "uuid",
    "timestamp",
    "json",
    "enum",
    "reference",
  ]),
  notNull: v.boolean(),
  unique: v.boolean(),
  enumValues: v.optional(v.array(v.string())),
  precision: v.optional(v.number()),
  scale: v.optional(v.number()),
});
const fields = v.record(v.string(), v.union([v.literal("_id"), v.literal("_createdAt"), field]));
const budgetsSchema = v.object(
  Object.fromEntries([
    ...Object.keys(defaultSearchBudgets).map((key) => [key, v.pipe(v.number(), v.integer(), v.minValue(1))] as const),
    ...Object.keys(defaultFullTextBudgets).map(
      (key) => [key, v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)))] as const,
    ),
  ]),
);
const nodeSchema: v.GenericSchema<SearchPublicNode> = v.lazy(() =>
  v.object({
    columns: fields,
    fields: v.optional(fields),
    filter: v.optional(v.array(v.string())),
    order: v.optional(v.array(v.string())),
    text: v.optional(v.array(v.string())),
    fullText: v.optional(v.record(v.string(), v.object({ semantics: v.string() }))),
    mode: v.optional(v.picklist(["finite", "live"])),
    budgets: v.optional(v.custom<SearchBudgets>((value) => v.is(budgetsSchema, value))),
    relations: v.record(v.string(), v.object({ many: v.boolean(), optional: v.boolean(), node: nodeSchema })),
  }),
);
/** Descriptor metadata survives isolated installs and multiple package copies. */
export function searchPublicNode(schema: StandardSchemaV1 | undefined) {
  if (!schema || !(searchNode in schema)) return undefined;
  return v.parse(nodeSchema, schema[searchNode]);
}
const scopeSchema = v.union([
  v.literal("public"),
  v.object({
    name: v.pipe(v.string(), v.minLength(1)),
    version: v.pipe(v.string(), v.minLength(1)),
    where: v.function(),
    dependencies: v.optional(v.array(v.string())),
  }),
]);
const policySchema = v.strictObject({
  fullText: v.optional(v.array(v.string())),
  columns: v.array(v.string()),
  filter: v.optional(v.array(v.string())),
  order: v.optional(v.array(v.string())),
  text: v.optional(v.array(v.string())),
  scope: scopeSchema,
  through: v.optional(v.record(v.string(), scopeSchema)),
  budgets: v.optional(v.record(v.string(), v.number())),
  relations: v.optional(v.record(v.string(), v.unknown())),
});
type ParsedPolicy = v.InferOutput<typeof policySchema>;
function scope(value: v.InferOutput<typeof scopeSchema>, graph: AnyRelations): "public" | RuntimeSearchScope {
  if (value === "public") return value;
  const where = v.parse(
    v.custom<(context: { table: TableRelationalConfig["table"]; identity: InvocationIdentity | null }) => SQL>(
      (value) => v.is(v.function(), value),
    ),
    value.where,
  );
  const dependencies = value.dependencies;
  if (dependencies?.some((name) => !Object.hasOwn(graph, name))) throw new Error("Unknown search policy dependency");
  const base = { name: value.name, version: value.version, where };
  return Object.freeze(
    dependencies === undefined ? base : { ...base, dependencies: Object.freeze([...new Set(dependencies)].sort()) },
  );
}
/** Bind descriptor factories only after the project's native graph exists. */
export function createSearchValidators<Schema extends SearchSchema, Graph extends AnyRelations>(
  schema: Schema,
  graph: Graph,
): SearchValidators<Schema, Graph> {
  function descriptor(name: string, value: ParsedPolicy, mode: "finite" | "live") {
    const policy = v.parse(policySchema, value);
    const overrides = policy.budgets ?? {};
    const defaults = policy.fullText ? { ...defaultSearchBudgets, ...defaultFullTextBudgets } : defaultSearchBudgets;
    if (Object.keys(overrides).some((key) => !Object.hasOwn(defaults, key))) throw new Error("Unknown search budget");
    const budgets = v.parse(
      v.custom<SearchBudgets>((value) => v.is(budgetsSchema, value)),
      { ...defaults, ...overrides },
    );
    const node = compileNode(name, policy, 0, budgets, mode);
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify(
          { schema: schema.fingerprint, mode, node: fingerprintNode(node), budgets, graph: fingerprintGraph() },
          (_key, value) => (v.is(v.bigint(), value) ? { bigint: value.toString() } : value),
        ),
      )
      .digest("hex");
    const metadata: SearchRuntimeDescriptor = Object.freeze({
      id: Symbol(name),
      entity: name,
      graph,
      schemaFingerprint: schema.fingerprint,
      fingerprint,
      node,
      budgets,
      mode,
    });
    const json = searchJsonSchemas(node.public);
    function make(
      role: "input" | "output",
      validate: (value: unknown, onBudgetExceeded?: () => void) => value is SearchPublicSelection | SearchCachedPage,
      json: SearchJsonSchema,
    ): StandardSchemaV1 & StandardJSONSchemaV1 {
      const result: StandardSchemaV1 & StandardJSONSchemaV1 = {
        "~standard": {
          version: 1,
          vendor: "kello",
          validate(value) {
            let budgetExceeded = false;
            if (
              validate(value, () => {
                budgetExceeded = true;
              })
            )
              return { value };
            if (role === "input" && node.public.fullText)
              return {
                issues: createSearchInputIssues(budgetExceeded ? "QUERY_BUDGET_EXCEEDED" : "INVALID_SELECTION"),
              };
            return { issues: [{ message: `Invalid search ${role}` }] };
          },
          jsonSchema: { input: () => json, output: () => json },
        },
      };
      Object.defineProperty(result, searchNode, { value: node.public });
      attachSearchMetadata(result, metadata, role);
      return Object.freeze(result);
    }
    const input = make(
      "input",
      (value, onBudgetExceeded) => validSearchSelection(node.public, value, onBudgetExceeded),
      json.input,
    );
    const output = make("output", (value) => acceptsSearchOutput(node.public, value), json.output);
    return Object.freeze({ input, output: mode === "live" ? eventIterator(output) : output });
  }
  function fingerprintGraph() {
    const dialect = new PgDialect();
    return Object.fromEntries(
      Object.entries(graph).map(([name, config]) => [
        name,
        Object.fromEntries(
          Object.entries(config.relations).map(([key, relation]) => {
            if (!is(relation.sourceTable, PgTable) || !is(relation.targetTable, PgTable))
              throw new Error("Search requires native PostgreSQL relations");
            const through = relation.throughTable;
            if (through && !is(through, PgTable)) throw new Error("Search requires a native PostgreSQL junction");
            const joins = relationToSQL(
              relation,
              alias(relation.sourceTable, "source"),
              alias(relation.targetTable, "target"),
              through && is(through, PgTable) ? alias(through, "junction") : undefined,
            );
            return [
              key,
              {
                target: relation.targetTableName,
                type: relation.relationType,
                optional: is(relation, One) && relation.optional,
                alias: relation.alias,
                reversed: relation.isReversed,
                filter: joins.filter && dialect.sqlToQuery(joins.filter),
                join: joins.joinCondition && dialect.sqlToQuery(joins.joinCondition),
              },
            ];
          }),
        ),
      ]),
    );
  }
  function fingerprintNode(node: SearchRuntimeNode): PolicyFingerprint {
    const policyScope = (value: "public" | RuntimeSearchScope) => {
      if (value === "public") return value;
      const result = {
        name: value.name,
        version: value.version,
        source: Function.prototype.toString.call(value.where),
      };
      return value.dependencies === undefined ? result : { ...result, dependencies: value.dependencies };
    };
    return {
      entity: node.entity,
      public: node.public,
      scope: policyScope(node.scope),
      through: Object.fromEntries(Object.entries(node.through).map(([name, value]) => [name, policyScope(value)])),
      relations: Object.fromEntries(
        Object.entries(node.relations).map(([name, child]) => [name, fingerprintNode(child)]),
      ),
    };
  }
  function compileNode(
    name: string,
    value: ParsedPolicy,
    depth: number,
    budgets: SearchBudgets,
    mode: "finite" | "live",
  ): SearchRuntimeNode {
    if (depth > 4) throw new Error("Search relation depth exceeds four");
    const policy = v.parse(policySchema, value);
    if (depth && policy.fullText !== undefined) throw new Error("Full-text grants belong to the root policy");
    if (depth && policy.budgets) throw new Error("Search budgets belong to the root policy");
    if (policy.filter?.some((name) => ["AND", "OR", "NOT", "relations"].includes(name)))
      throw new Error("Search filter field collides with a boolean control");
    const table = graph[name];
    const entity = schema.metadata.entities.find((entity) => entity.name === name);
    if (!table || !entity || !policy.columns.length) throw new Error("Invalid search table or columns");
    const available = Object.fromEntries([
      ...["_id", "_createdAt"].map((name) => [name, v.parse(v.picklist(["_id", "_createdAt"]), name)] as const),
      ...entity.fields.map(
        (field) =>
          [
            field.name,
            {
              kind: field.kind,
              notNull: field.notNull,
              unique: false,
              enumValues: field.enumValues,
              precision: field.precision,
              scale: field.scale,
            },
          ] as const,
      ),
    ]);
    const fieldKind = (name: string) => {
      const value = available[name];
      return value === "_id" ? "uuid" : value === "_createdAt" ? "integer" : value?.kind;
    };
    for (const [capability, names] of [
      ["columns", policy.columns],
      ["filter", policy.filter ?? []],
      ["order", policy.order ?? []],
      ["text", policy.text ?? []],
    ] as const) {
      if (new Set(names).size !== names.length || names.some((name) => !Object.hasOwn(available, name)))
        throw new Error(`Invalid search ${capability} fields`);
      if (capability === "order" && names.some((name) => ["json", "boolean"].includes(fieldKind(name) ?? "")))
        throw new Error("Invalid search order scalar");
      if (
        capability === "text" &&
        names.some((name) => !["text", "enum"].includes(fieldKind(name) ?? "") || !policy.filter?.includes(name))
      )
        throw new Error("Text matching requires an enabled text filter");
    }
    const fullText: CompiledFullText = Object.freeze(
      Object.fromEntries(
        (policy.fullText ?? []).map((name) => {
          const documents = entity.options.fullText;
          const document = documents && Object.hasOwn(documents, name) ? documents[name] : undefined;
          if (!document) throw new Error(`Unknown full-text document: ${name}`);
          if (document.fields.some(({ field }) => !policy.filter?.includes(field) || !policy.text?.includes(field)))
            throw new Error("Full-text matching requires explicit filter and text grants for every source");
          if (!("representation" in document) || document.representation !== "expression")
            throw new Error("Full-text document must be compiled");
          return [name, Object.freeze({ ...document, representation: "expression" as const })];
        }),
      ),
    );
    if (policy.fullText && (!policy.fullText.length || new Set(policy.fullText).size !== policy.fullText.length))
      throw new Error("Invalid full-text grants");
    const publicFullText = Object.freeze(
      Object.fromEntries(
        Object.entries(fullText).map(([name, document]) => [
          name,
          Object.freeze({
            semantics: createHash("sha256")
              .update(
                JSON.stringify({
                  document,
                  ...fullTextSemantics,
                }),
              )
              .digest("hex"),
          }),
        ]),
      ),
    );
    const pick = (name: string) => {
      const field = available[name];
      if (!field) throw new Error(`Missing search field: ${name}`);
      return [name, field] as const;
    };
    const columns = Object.fromEntries(policy.columns.map(pick));
    const queryFields = Object.fromEntries([...new Set([...(policy.filter ?? []), ...(policy.order ?? [])])].map(pick));
    const relations: Record<string, SearchPublicNode["relations"][string]> = {};
    const runtime: Record<string, SearchRuntimeNode> = {};
    const through = Object.fromEntries(
      Object.entries(policy.through ?? {}).map(([name, value]) => {
        if (!graph[name]) throw new Error(`Unknown search junction: ${name}`);
        return [name, scope(value, graph)];
      }),
    );
    for (const [name, child] of Object.entries(policy.relations ?? {})) {
      if (Object.hasOwn(available, name)) throw new Error(`Search relation collides with a column: ${name}`);
      const relation = table.relations[name];
      if (!is(relation, Relation)) throw new Error(`Unknown search relation: ${name}`);
      if (
        relation.throughTable &&
        !Object.entries(graph).some(
          ([name, table]) => table.table === relation.throughTable && Object.hasOwn(through, name),
        )
      )
        throw new Error(`Search junction requires an explicit scope: ${name}`);
      const compiled = compileNode(relation.targetTableName, v.parse(policySchema, child), depth + 1, budgets, mode);
      runtime[name] = compiled;
      relations[name] = {
        many: !is(relation, One),
        optional: is(relation, One) && (relation.optional || compiled.scope !== "public"),
        node: compiled.public,
      };
    }
    const publicNode: CompiledPublicNode = {
      columns: Object.freeze(columns),
      fields: Object.freeze(queryFields),
      filter: Object.freeze(policy.filter ?? []),
      order: Object.freeze(policy.order ?? []),
      text: Object.freeze(policy.text ?? []),
      relations: Object.freeze(relations),
      budgets: Object.freeze(budgets),
      mode,
    };
    if (policy.fullText) publicNode.fullText = publicFullText;
    const node: CompiledRuntimeNode = {
      entity: name,
      public: Object.freeze(publicNode),
      scope: scope(policy.scope, graph),
      through: Object.freeze(through),
      relations: Object.freeze(runtime),
    };
    if (policy.fullText) node.fullText = fullText;
    return Object.freeze(node);
  }
  const entries = Object.entries(schema.validators).map(([name, validators]) => [
    name,
    Object.freeze({
      ...validators,
      search: (policy: ParsedPolicy) => descriptor(name, policy, "finite"),
      liveSearch: (policy: ParsedPolicy) => descriptor(name, policy, "live"),
    }),
  ]);
  // SAFETY: factories retain each original table validator and are bound to its
  // validated native graph. Their runtime schemas enforce the compiled policy.
  return Object.freeze(Object.fromEntries(entries)) as SearchValidators<Schema, Graph>;
}
