import { createHash } from "node:crypto";
import { describe, expect, test } from "vite-plus/test";
import * as v from "valibot";
import type { SearchBudgets, SearchPolicy } from "../../../apps/kello/src/core/search/types";
import { defineRelations } from "drizzle-orm";
import { defineSchema } from "../../../apps/kello/src/core/schema/define-schema";
import { defineTable } from "../../../apps/kello/src/core/schema/table";
import { fields } from "../../../apps/kello/src/core/schema/fields";
import { createSearchValidators, searchPublicNode } from "../../../apps/kello/src/core/search/contract";
import { searchSchemaMetadata } from "../../../apps/kello/src/core/search/metadata";
import {
  acceptsSearchOutput,
  defaultSearchBudgets,
  validSearchSelection,
} from "../../../apps/kello/src/core/search/public";
import { searchJsonSchemas } from "../../../apps/kello/src/core/search/json-schema";

const document = {
  config: "pg_catalog.english",
  fields: [
    { field: "title", weight: "A" },
    { field: "body", weight: "D" },
  ],
  version: "1",
} as const;
const schema = defineSchema(() => ({
  articles: defineTable({ title: fields.text().notNull(), body: fields.text() }, { fullText: { content: document } }),
}));
const graph = defineRelations(schema.tables);
const validators = createSearchValidators(schema, graph);
const policy = {
  scope: "public",
  columns: ["title"],
  filter: ["title", "body"],
  text: ["title", "body"],
  order: ["title"],
  fullText: ["content"],
} as const;
// Runtime boundary tests admit malformed author policies; separate type probes check authoring.
const policyInput = v.custom<SearchPolicy<typeof graph, typeof graph.articles>>((value) => v.is(v.object({}), value));
type PolicyFixture = {
  readonly scope: "public";
  readonly columns: readonly string[];
  readonly filter?: readonly string[] | undefined;
  readonly order?: readonly string[] | undefined;
  readonly text?: readonly string[] | undefined;
  readonly fullText?: readonly string[] | Readonly<Record<string, readonly string[]>> | undefined;
  readonly budgets?: Partial<SearchBudgets>;
};
const make = (value: PolicyFixture = policy) => validators.articles.search(v.parse(policyInput, value));
const node = () => searchPublicNode(make().input)!;

describe("full-text policy and public contract", () => {
  test("locks the legacy descriptor binding and budget shape", () => {
    const legacy = defineSchema(() => ({ articles: { title: fields.text().notNull(), body: fields.text() } }));
    const pair = createSearchValidators(legacy, defineRelations(legacy.tables)).articles.search({
      scope: "public",
      columns: ["title"],
      filter: ["title"],
      text: ["title"],
      order: ["title"],
    });
    const runtime = searchSchemaMetadata(pair.input)!.descriptor;
    expect(runtime.fingerprint).toBe("3898f6fbe6565a5f0476b88eb32eb01f98359cf99d4d77500043ecdf30040918");
    expect(runtime.budgets).toEqual(defaultSearchBudgets);
    expect(runtime.node).not.toHaveProperty("fullText");
    expect(runtime.node.public).not.toHaveProperty("fullText");
  });
  test("requires a declared grant and every source's explicit filter and text permission", () => {
    for (const changed of [
      { fullText: ["missing"] },
      { fullText: [] },
      { fullText: ["content", "content"] },
      { filter: ["title"], text: ["title"] },
      { text: ["title"] },
      { filter: undefined },
      { fullText: { content: ["title"] } },
    ])
      expect(() => make({ ...policy, ...changed })).toThrow();
    const pair = make();
    expect(searchPublicNode(pair.input)?.columns).toHaveProperty("title");
    expect(searchPublicNode(pair.input)?.columns).not.toHaveProperty("body");
  });
  test("emits only granted names and semantic identities, retaining the compiled document privately", () => {
    const runtime = searchSchemaMetadata(make().input)!.descriptor;
    const publicNode = node();
    expect(publicNode.fullText?.content?.semantics).toMatch(/^[a-f0-9]{64}$/);
    expect(runtime.node.fullText?.content).toEqual({ ...document, representation: "expression" });
    expect(JSON.stringify(publicNode.fullText)).not.toMatch(/english|weight|representation|fields|version/);
    expect(searchPublicNode(make().input)?.fullText).toEqual(publicNode.fullText);
    expect(runtime.budgets).toMatchObject({
      fullTextQueryBytes: 4096,
      fullTextQueryNodes: 128,
      fullTextTimeoutMs: 5000,
    });
    expect(Object.isFrozen(runtime.node.fullText)).toBe(true);
  });
  test("binds exact document and parser/rank semantics while masking ungranted names", () => {
    function identity(
      changed: typeof document | { config: "pg_catalog.simple"; fields: typeof document.fields; version: string },
    ) {
      const variant = defineSchema(() => ({
        articles: defineTable(
          { title: fields.text().notNull(), body: fields.text() },
          { fullText: { content: changed, hidden: document } },
        ),
      }));
      const pair = createSearchValidators(variant, defineRelations(variant.tables)).articles.search(policy);
      return searchPublicNode(pair.input)!;
    }
    const original = identity(document);
    expect(Object.keys(original.fullText!)).toEqual(["content"]);
    expect(validSearchSelection(original, { fullText: { document: "hidden", query: "x" } })).toBe(false);
    expect(identity(document).fullText).toEqual(original.fullText);
    expect(identity({ ...document, config: "pg_catalog.simple" }).fullText).not.toEqual(original.fullText);
    const semantics = createHash("sha256")
      .update(
        JSON.stringify({
          document: { ...document, representation: "expression" },
          parser: "plain-v1",
          rank: "ts_rank_cd",
          normalization: 32,
          weights: [0.1, 0.2, 0.4, 1],
          codec: "float4-bits-v1",
          order: "rank-desc-id-asc",
        }),
      )
      .digest("hex");
    expect(original.fullText?.content?.semantics).toBe(semantics);
  });
  test("preserves raw queries, validates finite/live roots, and rejects forged or nested controls", async () => {
    const raw = '  Café 😀 - quoted "words"  ';
    const pair = make();
    const input = {
      fullText: { document: "content", query: raw },
      where: { title: { contains: "ordinary" } },
      count: true,
    };
    expect(await pair.input["~standard"].validate(input)).toEqual({ value: input });
    expect(validSearchSelection(node(), { fullText: { document: "content", query: "" } })).toBe(true);
    const live = validators.articles.liveSearch(policy);
    expect(
      (await live.input["~standard"].validate({ fullText: input.fullText, loadedPages: 2 })).issues,
    ).toBeUndefined();
    for (const invalid of [
      { ...input, orderBy: [{ field: "title", direction: "asc" }] },
      { fullText: { document: "missing", query: "x" } },
      { fullText: { document: "content" } },
      { fullText: { ...input.fullText, config: "pg_catalog.simple" } },
      { fullText: { ...input.fullText, rank: 1 } },
      { fullText: { ...input.fullText, vector: "x" } },
      { where: { fullText: input.fullText } },
      { with: { articles: { fullText: input.fullText } } },
    ])
      expect(validSearchSelection(node(), invalid)).toBe(false);
    expect(validSearchSelection(searchPublicNode(make({ ...policy, fullText: undefined }).input)!, input)).toBe(false);
  });
  test("rejects NUL, malformed Unicode and descriptor attacks without evaluating getters", () => {
    for (const query of ["a\0b", "\ud800", "\udc00", "a\ud800b"])
      expect(validSearchSelection(node(), { fullText: { document: "content", query } })).toBe(false);
    let reads = 0;
    const accessor = {
      document: "content",
      get query() {
        reads++;
        return "x";
      },
    };
    for (const fullText of [
      accessor,
      Object.create({ document: "content", query: "x" }),
      JSON.parse('{"document":"content","query":"x","__proto__":{}}'),
    ])
      expect(validSearchSelection(node(), { fullText })).toBe(false);
    expect(reads).toBe(0);
  });
  test("distinguishes byte/UTF16 exhaustion from invalid input for the compiler host", () => {
    const publicNode = searchPublicNode(make({ ...policy, budgets: { textLength: 4, fullTextQueryBytes: 6 } }).input)!;
    for (const query of ["abcde", "😀😀"]) {
      let exceeded = false;
      expect(
        validSearchSelection(publicNode, { fullText: { document: "content", query } }, () => {
          exceeded = true;
        }),
      ).toBe(false);
      expect(exceeded).toBe(true);
    }
    for (const query of ["😀a", "ééé"])
      expect(validSearchSelection(publicNode, { fullText: { document: "content", query } })).toBe(true);
    let exceeded = false;
    expect(
      validSearchSelection(publicNode, { fullText: { document: "missing", query: "long invalid" } }, () => {
        exceeded = true;
      }),
    ).toBe(false);
    expect(exceeded).toBe(false);
  });
  test("validates applicable positive integer overrides and forbids nested grants", () => {
    for (const key of ["fullTextQueryBytes", "fullTextQueryNodes", "fullTextTimeoutMs"])
      for (const value of [0, -1, 1.5, NaN, Infinity])
        expect(() => make({ ...policy, budgets: { [key]: value } })).toThrow();
    expect(
      searchSchemaMetadata(make({ ...policy, budgets: { fullTextQueryNodes: 9 } }).input)!.descriptor.budgets
        .fullTextQueryNodes,
    ).toBe(9);
    expect(() => make({ ...policy, fullText: undefined, budgets: { fullTextQueryBytes: 9 } })).toThrow();
    const related = defineRelations(schema.tables, (r) => ({
      articles: { child: r.one.articles({ from: r.articles._id, to: r.articles._id }) },
    }));
    const factory = createSearchValidators(schema, related).articles.search;
    expect(() => factory(v.parse(policyInput, { ...policy, relations: { child: policy } }))).toThrow(/root/i);
    const nested = factory({ ...policy, relations: { child: { scope: "public", columns: ["title"] } } });
    expect(
      validSearchSelection(searchPublicNode(nested.input)!, {
        with: { child: { fullText: { document: "content", query: "x" } } },
      }),
    ).toBe(false);
    const json = searchJsonSchemas(searchPublicNode(nested.input)!).input;
    expect(json.properties?.with?.properties?.child?.properties).not.toHaveProperty("fullText");
  });
  test("JSON Schema exposes a strict granted root input and mutually exclusive ordering", () => {
    const json = searchJsonSchemas(node()).input;
    expect(json.properties?.fullText).toEqual({
      type: "object",
      properties: { document: { type: "string", enum: ["content"] }, query: { type: "string", maxLength: 1024 } },
      required: ["document", "query"],
      additionalProperties: false,
    });
    expect(json.not).toEqual({ required: ["fullText", "orderBy"] });
    expect(JSON.stringify(json)).not.toMatch(/pg_catalog|representation|weight/);
  });
  test("private rank/vector cannot pass output guards", () => {
    for (const extra of [{ rank: 1 }, { vector: "x" }, { _kello_rank: 1 }])
      expect(
        acceptsSearchOutput(node(), { rows: [{ title: "x", ...extra }], nextCursor: null, previousCursor: null }),
      ).toBe(false);
  });
});
