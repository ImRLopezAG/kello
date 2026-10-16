import { describe, expect, test } from "vite-plus/test";
import { SQL } from "drizzle-orm";
import { alias, getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { bindSchemaNamespace, defineSchema } from "../../../apps/loom/src/core/schema/define-schema";
import { defineTable, TableDefinition } from "../../../apps/loom/src/core/schema/table";
import { compile } from "../../../apps/loom/src/core/schema/compile";
import { fullTextVector } from "../../../apps/loom/src/core/schema/full-text";
import type { FullTextDeclarations, FullTextDocument } from "../../../apps/loom/src/core/schema/full-text";
import { fields } from "../../../apps/loom/src/core/schema/fields";

const document = {
  config: "pg_catalog.english",
  fields: [
    { field: "title", weight: "A" },
    { field: "body", weight: "D" },
  ],
  version: "1",
} as const;
const sources = { title: fields.text().notNull(), body: fields.text(), state: fields.enum(["draft", "published"]) };
function schemaFor(documents: FullTextDeclarations) {
  return defineSchema(() => ({ articles: new TableDefinition(sources, { fullText: documents }) }));
}
function indexSql(schema: ReturnType<typeof schemaFor>) {
  return getTableConfig(schema.tables.articles).indexes.map(({ config }) => {
    const expression = config.columns[0];
    expect(expression).toBeInstanceOf(SQL);
    if (!(expression instanceof SQL)) throw new Error("Expected native SQL index expression");
    return { name: config.name, method: config.method, ...new PgDialect().sqlToQuery(expression, "indexes") };
  });
}

describe("schema full-text documents", () => {
  test("preserves the exact pre-FTS fingerprint and absent metadata", () => {
    const schema = defineSchema(() => ({
      articles: defineTable(
        { title: fields.text().notNull(), body: fields.text(), state: fields.enum(["draft", "published"]) },
        {
          indexes: [{ fields: ["state"] }],
          serverFields: ["body"],
          commandFields: ["title"],
          publicFields: ["title", "_id"],
        },
      ),
    }));
    expect(schema.fingerprint).toBe("a0dbfed5a03c14e3ff8cfed2b451555700d266ed4e4bbeee117ef6c8c028acb8");
    expect(schema.metadata.entities[0]?.options).not.toHaveProperty("fullText");
    expect(getTableConfig(schema.tables.articles).indexes).toHaveLength(1);
  });

  test("compiles an opted-in weighted document to a native GIN index", () => {
    const schema = defineSchema(() => ({
      articles: defineTable(
        { title: fields.text(), body: fields.text() },
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
          },
        },
      ),
    }));
    expect(getTableConfig(schema.tables.articles).indexes).toHaveLength(1);
    expect(schema.metadata.entities[0]?.options).toHaveProperty("fullText.content.config", "pg_catalog.english");
  });

  test("emits the same weighted vector through native index and alias column resolution", () => {
    const schema = schemaFor({ content: document });
    const [generated] = indexSql(schema);
    expect(generated).toEqual({
      name: "articles_content_e99957b3e8340b52_fts_idx",
      method: "gin",
      params: [],
      sql: `(setweight(to_tsvector('pg_catalog.english'::regconfig, coalesce("title", '')), 'A'::"char") || setweight(to_tsvector('pg_catalog.english'::regconfig, coalesce("body", '')), 'D'::"char"))`,
    });
    const root = alias(schema.tables.articles, "search_root");
    const aliased = new PgDialect().sqlToQuery(fullTextVector(document, (key) => root[key]));
    expect(aliased.params).toEqual([]);
    expect(aliased.sql).toBe(
      generated?.sql.replaceAll('"title"', '"search_root"."title"').replaceAll('"body"', '"search_root"."body"'),
    );
    expect(getTableConfig(schema.tables.articles).columns).toHaveLength(5);
    expect(
      indexSql(
        schemaFor({ status: { config: "pg_catalog.simple", fields: [{ field: "state", weight: "B" }], version: "1" } }),
      )[0]?.sql,
    ).toBe(`(setweight(to_tsvector('pg_catalog.simple'::regconfig, coalesce("state", '')), 'B'::"char"))`);
  });

  test("snapshots and deeply freezes author-owned documents before compilation", () => {
    const mutableSources: { field: "title" | "body"; weight: "A" | "D" }[] = [{ field: "title", weight: "A" }];
    const input = { content: { config: "pg_catalog.english" as const, fields: mutableSources, version: "1" } };
    const table = defineTable(sources, { fullText: input });
    const first = defineSchema(() => ({ articles: table }));
    Object.assign(input.content, { config: "pg_catalog.simple", version: "changed" });
    Object.assign(input.content.fields[0]!, { field: "body", weight: "D" });
    input.content.fields.push({ field: "body", weight: "A" });
    Object.assign(input, { another: document });
    const second = defineSchema(() => ({ articles: table }));
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(table.options.fullText.content).toEqual({
      config: "pg_catalog.english",
      fields: [{ field: "title", weight: "A" }],
      version: "1",
    });
    for (const value of [
      table.options.fullText,
      table.options.fullText.content,
      table.options.fullText.content.fields,
      table.options.fullText.content.fields[0],
    ])
      expect(Object.isFrozen(value)).toBe(true);
    const compiled = second.metadata.entities[0]!.options.fullText;
    for (const value of [compiled, compiled.content, compiled.content.fields, compiled.content.fields[0]])
      expect(Object.isFrozen(value)).toBe(true);
    expect(() => Object.assign(compiled.content.fields[0]!, { field: "body" })).toThrow();
    expect(() => Object.assign(table.options.fullText.content, { version: "2" })).toThrow();
  });

  test("canonicalizes document-map order, retains source order, and binds namespaces freshly", () => {
    const status = { config: "pg_catalog.simple", fields: [{ field: "state", weight: "C" }], version: "1" } as const;
    const first = schemaFor({ content: document, status });
    const second = schemaFor({ status, content: document });
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(indexSql(first)).toEqual(indexSql(second));
    expect(new Set(indexSql(first).map((entry) => entry.name)).size).toBe(2);
    expect(indexSql(first)[0]?.sql).not.toBe(indexSql(first)[1]?.sql);
    const rebound = bindSchemaNamespace(first, "fts_proof");
    expect(getTableConfig(rebound.tables.articles).schema).toBe("fts_proof");
    expect(getTableConfig(first.tables.articles).schema).toBeUndefined();
    expect(rebound.tables.articles).not.toBe(first.tables.articles);
    expect(indexSql(rebound)).toEqual(indexSql(first));
    expect(rebound.metadata.entities).toEqual(first.metadata.entities);
    expect(rebound.fingerprint).not.toBe(first.fingerprint);
    const vector = new PgDialect().sqlToQuery(fullTextVector(document, (key) => rebound.tables.articles[key]));
    expect(vector.sql).toContain('"fts_proof"."articles"."title"');
  });

  test("binds ordered sources, configuration, weight, version, and representation in fingerprints", () => {
    const first = schemaFor({ content: document });
    const variants: FullTextDocument[] = [
      { ...document, fields: [...document.fields].reverse() },
      { ...document, config: "pg_catalog.simple" },
      { ...document, fields: [{ field: "title", weight: "B" }, document.fields[1]] },
      { ...document, version: "2" },
    ];
    for (const changed of variants) expect(schemaFor({ content: changed }).fingerprint).not.toBe(first.fingerprint);
    expect(first.metadata.entities[0]?.options).toHaveProperty("fullText.content.representation", "expression");
    expect(JSON.stringify(first.metadata)).toContain('"representation":"expression"');
  });

  test("preserves ordinary indexes, policies and projection validators alongside FTS", async () => {
    const options = {
      indexes: [{ fields: ["state"] as const }],
      serverFields: ["body"] as const,
      commandFields: ["title"] as const,
      publicFields: ["title"] as const,
    };
    const legacy = defineSchema(() => ({ articles: defineTable(sources, options) }));
    const fts = defineSchema(() => ({
      articles: defineTable(sources, { ...options, fullText: { content: document } }),
    }));
    expect(getTableConfig(fts.tables.articles).indexes[0]?.config.name).toBe(
      getTableConfig(legacy.tables.articles).indexes[0]?.config.name,
    );
    for (const boundary of ["insert", "patch", "command", "public"] as const) {
      for (const input of [
        { title: "example", body: "private", state: "draft" },
        { title: "example" },
        { body: "private" },
      ]) {
        expect(await fts.validators.articles[boundary]["~standard"].validate(input)).toEqual(
          await legacy.validators.articles[boundary]["~standard"].validate(input),
        );
      }
    }
  });

  test("accepts the maximum document/source bounds and uses distinct bounded native names", () => {
    const manyFields = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`source${i}`, fields.text()]));
    const manyDocuments = Object.fromEntries(
      Array.from({ length: 8 }, (_, i) => [
        `document${i}`,
        {
          config: "pg_catalog.simple" as const,
          fields: Object.keys(manyFields).map((field) => ({ field, weight: "D" as const })),
          version: "1",
        },
      ]),
    );
    const schema = compile({ articles: new TableDefinition(manyFields, { fullText: manyDocuments }) }, {});
    expect(getTableConfig(schema.tables.articles).indexes).toHaveLength(8);
    const longName = "a".repeat(63);
    const long = compile({ [longName]: new TableDefinition(sources, { fullText: { [longName]: document } }) }, {});
    const names = getTableConfig(long.tables[longName]!).indexes.map((entry) => entry.config.name!);
    expect(names).toHaveLength(1);
    expect(Buffer.byteLength(names[0]!)).toBeLessThanOrEqual(63);
    expect(
      getTableConfig(
        compile({ [longName]: new TableDefinition(sources, { fullText: { [longName]: document } }) }, {}).tables[
          longName
        ]!,
      ).indexes[0]?.config.name,
    ).toBe(names[0]);
  });

  test("keeps index identities distinct across ambiguous table/document name joins", () => {
    const schema = compile(
      {
        a_b: new TableDefinition(sources, { fullText: { c: document } }),
        a: new TableDefinition(sources, { fullText: { b_c: document } }),
      },
      {},
    );
    const names = Object.values(schema.tables).flatMap((table) =>
      getTableConfig(table).indexes.map((entry) => entry.config.name),
    );
    expect(new Set(names).size).toBe(2);
  });

  test("rejects empty/excess document or source lists, duplicates and invalid schema semantics", () => {
    expect(() => schemaFor({})).toThrow("1..8 documents");
    expect(() =>
      schemaFor(Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`document${i}`, document]))),
    ).toThrow("1..8 documents");
    expect(() => schemaFor({ content: { ...document, fields: [] } })).toThrow("1..8 fields");
    expect(() =>
      schemaFor({
        content: { ...document, fields: Array.from({ length: 9 }, (_, i) => ({ field: `source${i}`, weight: "A" })) },
      }),
    ).toThrow("1..8 fields");
    expect(() => schemaFor({ content: { ...document, fields: [document.fields[0], document.fields[0]] } })).toThrow(
      "Duplicate full-text source",
    );
    for (const version of ["", "  ", "v\0one"])
      expect(() => schemaFor({ content: { ...document, version } })).toThrow("Invalid full-text version");
    for (const config of [
      "english",
      "pg_catalog.french",
      "custom.simple",
      "pg_catalog.simple'::regconfig); DROP TABLE articles; --",
    ]) {
      const invalid: FullTextDocument = { ...document };
      Object.assign(invalid, { config });
      expect(() => schemaFor({ content: invalid })).toThrow("Invalid full-text configuration");
    }
    const invalidWeight: FullTextDocument = { ...document, fields: [{ field: "title", weight: "A" }] };
    Object.assign(invalidWeight.fields[0]!, { weight: "E" });
    expect(() => schemaFor({ content: invalidWeight })).toThrow("Invalid full-text weight");
    for (const name of ["_system", "loom_search", "two words", "x".repeat(64)])
      expect(() => schemaFor({ [name]: document })).toThrow();
    expect(() => schemaFor({ searchDoc: document, search_doc: document })).toThrow("SQL-name collision");
  });

  test("rejects missing, nested, system, relation and every non-text storage source", () => {
    const invalidSources = {
      count: fields.integer(),
      enabled: fields.boolean(),
      total: fields.bigint(),
      amount: fields.numeric(),
      id: fields.uuid(),
      at: fields.timestamp(),
      data: fields.json(),
      project: fields.reference("projects"),
    };
    for (const source of ["missing", "project.title", "_id", "_createdAt", ...Object.keys(invalidSources)]) {
      expect(() =>
        compile(
          {
            projects: {},
            articles: new TableDefinition(
              { ...sources, ...invalidSources },
              { fullText: { content: { ...document, fields: [{ field: source, weight: "A" }] } } },
            ),
          },
          {},
        ),
      ).toThrow("root text/enum field");
    }
  });
});
