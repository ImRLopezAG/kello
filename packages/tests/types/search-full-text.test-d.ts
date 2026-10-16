import { defineRelations } from "drizzle-orm";
import type { BuildQueryResult } from "drizzle-orm";
import { compile } from "../../../apps/loom/src/core/schema/compile";
import { bindSchemaNamespace, defineSchema } from "../../../apps/loom/src/core/schema/define-schema";
import { fields } from "../../../apps/loom/src/core/schema/fields";
import { defineTable } from "../../../apps/loom/src/core/schema/table";
import { fullTextVector } from "../../../apps/loom/src/core/schema/full-text";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;
const article = defineTable(
  {
    title: fields.text().notNull(),
    body: fields.text(),
    state: fields.enum(["draft", "published"]),
    count: fields.integer(),
  },
  {
    fullText: {
      content: {
        config: "pg_catalog.english",
        fields: [
          { field: "title", weight: "A" },
          { field: "body", weight: "D" },
        ],
        version: "1",
      },
      status: { config: "pg_catalog.simple", fields: [{ field: "state", weight: "B" }], version: "2" },
    },
    indexes: [{ fields: ["count"] }],
    serverFields: ["body"],
    publicFields: ["title", "_id"],
  },
);
const compiled = compile({ articles: article, legacy: { title: fields.text() } }, {});
const schema = defineSchema(() => ({ articles: article, legacy: { title: fields.text() } }));
const rebound = bindSchemaNamespace(schema, "fts_proof");
type ArticleMetadata = Extract<(typeof compiled.metadata.entities)[number], { name: "articles" }>;
type SchemaMetadata = Extract<(typeof schema.metadata.entities)[number], { name: "articles" }>;
type ReboundMetadata = Extract<(typeof rebound.metadata.entities)[number], { name: "articles" }>;
type LegacyMetadata = Extract<(typeof schema.metadata.entities)[number], { name: "legacy" }>;
export type FullTextLiterals = [
  Assert<Equal<keyof typeof article.options.fullText, "content" | "status">>,
  Assert<
    Equal<
      typeof article.options.fullText.content.fields,
      readonly [{ readonly field: "title"; readonly weight: "A" }, { readonly field: "body"; readonly weight: "D" }]
    >
  >,
  Assert<Equal<keyof ArticleMetadata["options"]["fullText"], "content" | "status">>,
  Assert<Equal<SchemaMetadata["options"]["fullText"]["content"]["config"], "pg_catalog.english">>,
  Assert<Equal<SchemaMetadata["options"]["fullText"]["content"]["version"], "1">>,
  Assert<Equal<SchemaMetadata["options"]["fullText"]["content"]["representation"], "expression">>,
  Assert<
    Equal<SchemaMetadata["options"]["fullText"]["content"]["fields"], typeof article.options.fullText.content.fields>
  >,
  Assert<Equal<keyof ReboundMetadata["options"]["fullText"], "content" | "status">>,
  Assert<Equal<Extract<keyof LegacyMetadata["options"], "fullText">, never>>,
  Assert<Equal<typeof article.options.serverFields, readonly ["body"]>>,
];
const graph = defineRelations(schema.tables);
export type NativeGraphDocuments = [
  Assert<Equal<keyof typeof graph.articles.table._.fullText, "content" | "status">>,
  Assert<Equal<Extract<keyof typeof graph.legacy.table._, "fullText">, never>>,
];
type Projected = BuildQueryResult<typeof graph, typeof graph.articles, { columns: { title: true; state: true } }>;
export type ProjectionUnchanged = Assert<Equal<Projected, { title: string; state: "draft" | "published" | null }>>;
fullTextVector(article.options.fullText.content, (key) => schema.tables.articles[key]);

const mutableSources: { field: "title" | "body"; weight: "A" | "D" }[] = [{ field: "title", weight: "A" }];
const mutableDocument = {
  config: "pg_catalog.simple" as const,
  fields: mutableSources,
  version: "1",
};
const mutableArticle = defineTable(
  { title: fields.text(), body: fields.text() },
  { fullText: { content: mutableDocument } },
);
const mutableCompiled = compile({ articles: mutableArticle }, {});
const mutableSchema = defineSchema(() => ({ articles: mutableArticle }));
const mutableRebound = bindSchemaNamespace(mutableSchema, "fts_readonly");
const mutableGraph = defineRelations(mutableSchema.tables);
const mutableContent = mutableSchema.metadata.entities[0]!.options.fullText.content;
type ReadonlyContent = {
  readonly config: "pg_catalog.simple";
  readonly fields: readonly { readonly field: "title" | "body"; readonly weight: "A" | "D" }[];
  readonly version: string;
  readonly representation: "expression";
};
export type MutableInputCompiledReadonly = [
  Assert<Equal<typeof mutableContent, ReadonlyContent>>,
  Assert<Equal<(typeof mutableCompiled.metadata.entities)[number]["options"]["fullText"]["content"], ReadonlyContent>>,
  Assert<Equal<(typeof mutableRebound.metadata.entities)[number]["options"]["fullText"]["content"], ReadonlyContent>>,
  Assert<Equal<typeof mutableGraph.articles.table._.fullText.content, ReadonlyContent>>,
  Assert<Equal<keyof typeof mutableSchema.tables.articles._.fullText, "content">>,
];
// @ts-expect-error Compiled versions are readonly even when the author variable has a string version.
mutableContent.version = "2";
// @ts-expect-error Compiled source arrays are readonly even when the author array is mutable.
mutableContent.fields.push({ field: "body", weight: "D" });
// @ts-expect-error Compiled source entries are deeply readonly.
mutableContent.fields[0]!.field = "body";
// @ts-expect-error Compiled source weights are deeply readonly.
mutableContent.fields[0]!.weight = "D";

defineTable(
  { title: fields.text() },
  // @ts-expect-error Missing root fields are not document sources.
  { fullText: { content: { config: "pg_catalog.simple", fields: [{ field: "missing", weight: "A" }], version: "1" } } },
);
defineTable(
  { count: fields.integer() },
  // @ts-expect-error Integers cannot be document sources.
  { fullText: { content: { config: "pg_catalog.simple", fields: [{ field: "count", weight: "A" }], version: "1" } } },
);
defineTable(
  { id: fields.uuid() },
  // @ts-expect-error UUID native storage is not text storage.
  { fullText: { content: { config: "pg_catalog.simple", fields: [{ field: "id", weight: "A" }], version: "1" } } },
);
defineTable(
  { project: fields.reference("projects") },
  // @ts-expect-error Relations cannot be document sources.
  { fullText: { content: { config: "pg_catalog.simple", fields: [{ field: "project", weight: "A" }], version: "1" } } },
);
defineTable(
  { title: fields.text() },
  {
    fullText: {
      // @ts-expect-error Nested sources are not root fields.
      content: { config: "pg_catalog.simple", fields: [{ field: "project.title", weight: "A" }], version: "1" },
    },
  },
);
defineTable(
  { title: fields.text() },
  // @ts-expect-error Only qualified allowlisted configurations are accepted.
  { fullText: { content: { config: "english", fields: [{ field: "title", weight: "A" }], version: "1" } } },
);
defineTable(
  { title: fields.text() },
  // @ts-expect-error Explicit valid weights are required.
  { fullText: { content: { config: "pg_catalog.simple", fields: [{ field: "title", weight: "E" }], version: "1" } } },
);
