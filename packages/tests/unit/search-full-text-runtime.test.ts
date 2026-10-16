import { describe, expect, test } from "vite-plus/test";
import { defineRelations, sql } from "drizzle-orm";
import { alias, PgDialect } from "drizzle-orm/pg-core";
import { defineSchema } from "../../../apps/loom/src/core/schema/define-schema";
import { defineTable } from "../../../apps/loom/src/core/schema/table";
import { fields } from "../../../apps/loom/src/core/schema/fields";
import { createSearchValidators } from "../../../apps/loom/src/core/search/contract";
import { searchSchemaMetadata } from "../../../apps/loom/src/core/search/metadata";
import { compileSearch, searchColumn } from "../../../apps/loom/src/core/search/compiler";
import { resolveFullText, fullTextPreflightSQL } from "../../../apps/loom/src/core/search/full-text";
import { prepareSearchPage, finishSearchPage } from "../../../apps/loom/src/core/search/pagination";
import { createSearchCursor } from "../../../apps/loom/src/core/search/cursor";
import { EncryptJWT, jwtDecrypt } from "jose";

const schema = defineSchema(() => ({
  articles: defineTable(
    {
      title: fields.text().notNull(),
      body: fields.text(),
      searchRank: fields.text(),
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
      },
    },
  ),
}));
const graph = defineRelations(schema.tables);
const pair = createSearchValidators(schema, graph).articles.search({
  scope: {
    name: "tenant",
    version: "1",
    where: ({ table }) => sql`${searchColumn(table, "_id")} <> ${"00000000-0000-0000-0000-000000000099"}::uuid`,
  },
  columns: ["title", "searchRank"],
  filter: ["title", "body"],
  text: ["title", "body"],
  fullText: ["content"],
});
const descriptor = searchSchemaMetadata(pair.input)!.descriptor;
const input = { columns: { title: true }, fullText: { document: "content", query: " cats " }, limit: 1 };
const context = { branchId: "br", namespace: "app", contract: "articles.search", identity: null };
const secret = "01".repeat(32);
const id = "00000000-0000-0000-0000-000000000001";
const dialect = new PgDialect();
const parsed = { canonical: "'cat'", nodes: 1, tree: "'cat'" };
const resolved = () => resolveFullText(descriptor, input, parsed);

describe("ranked search runtime foundation", () => {
  test("preflight binds raw input under explicit config and validates parser budgets", () => {
    const query = dialect.sqlToQuery(fullTextPreflightSQL(descriptor, input));
    expect(query.sql).toContain("plainto_tsquery('pg_catalog.english'::regconfig");
    expect(query.params).toEqual([" cats "]);
    expect(query.sql).toContain("numnode");
    expect(query.sql).toContain("querytree");
    expect(() => resolveFullText(descriptor, input, { ...parsed, nodes: 129 })).toThrowError(
      expect.objectContaining({ code: "QUERY_BUDGET_EXCEEDED" }),
    );
    for (const tree of ["", "T"]) expect(() => resolveFullText(descriptor, input, { ...parsed, tree })).toThrow();
    expect(() =>
      fullTextPreflightSQL(descriptor, { ...input, fullText: { ...input.fullText, query: "x".repeat(1025) } }),
    ).toThrowError(expect.objectContaining({ code: "QUERY_BUDGET_EXCEEDED" }));
  });
  test("root and count predicate retain authorization, ordinary filters and aliased match", () => {
    const plan = compileSearch(descriptor, { ...input, where: { title: { ne: "hidden" } } }, null, resolved());
    const source = alias(schema.tables.articles, "a");
    const query = dialect.sqlToQuery(plan.where(source));
    expect(query.sql).toContain('"a"."title"');
    expect(query.sql).toContain("@@");
    expect(query.sql).toContain("<>");
    expect(query.params).toContain("hidden");
    expect(query.params).toContain("'cat'");
    expect(() => compileSearch(descriptor, input, null)).toThrow();
  });
  test("ranked pages use exact private bits, collision-free aliases, lookahead and both boundaries", async () => {
    const plan = await prepareSearchPage(descriptor, input, context, secret, resolved());
    expect(plan.rankAlias).not.toBe("searchRank");
    const query = dialect.sqlToQuery(sql.join(plan.config.orderBy(schema.tables.articles), sql`, `));
    expect(query.sql).toContain("ts_rank_cd(ARRAY[0.1,0.2,0.4,1.0]::real[]");
    expect(query.sql).toMatch(/desc.*_id.*asc/);
    const page = await finishSearchPage(plan, [
      { title: "one", _id: id, [plan.rankAlias!]: "3eaaaaab" },
      { title: "two", _id: "00000000-0000-0000-0000-000000000002", [plan.rankAlias!]: "3eaaaaab" },
    ]);
    expect(page.rows).toEqual([{ title: "one" }]);
    expect(page.nextCursor).toBeTypeOf("string");
    const next = await prepareSearchPage(
      descriptor,
      { ...input, cursor: page.nextCursor },
      context,
      secret,
      resolved(),
    );
    const forward = dialect.sqlToQuery(next.config.where.RAW(schema.tables.articles));
    expect(forward.params).toContain("0.3333333432674408");
    expect(forward.sql).toContain("::real");
    expect(dialect.sqlToQuery(next.where(schema.tables.articles))).toEqual(
      dialect.sqlToQuery(plan.where(schema.tables.articles)),
    );
    const codec = createSearchCursor(secret, descriptor, input, context, undefined, resolved());
    const previous = await codec.issue(["3eaaaaab", id], "backward");
    const back = await prepareSearchPage(
      descriptor,
      { ...input, limit: 2, cursor: previous, direction: "backward" },
      context,
      secret,
      resolved(),
    );
    expect(dialect.sqlToQuery(sql.join(back.config.orderBy(schema.tables.articles), sql`, `)).sql).toMatch(
      /asc.*_id.*desc/,
    );
    const backward = dialect.sqlToQuery(back.config.where.RAW(schema.tables.articles));
    expect(backward.sql).toContain(" > ");
    expect(backward.sql).toContain(" < ");
    const backwardPage = await finishSearchPage(back, [
      { title: "lower", _id: id, [back.rankAlias!]: "3eaaaaac" },
      { title: "higher", _id: id, [back.rankAlias!]: "3eaaaaad" },
      { title: "extra", _id: id, [back.rankAlias!]: "3eaaaaae" },
    ]);
    expect(backwardPage.rows).toEqual([{ title: "higher" }, { title: "lower" }]);
    expect(backwardPage.previousCursor).toBeTypeOf("string");
    expect(backwardPage.nextCursor).toBeTypeOf("string");
  });
  test("preserves a selected source column whose name collides with the private rank alias", async () => {
    const selected = { ...input, columns: { title: true, searchRank: true } };
    const plan = await prepareSearchPage(descriptor, selected, context, secret, resolved());
    const page = await finishSearchPage(plan, [
      { title: "one", searchRank: "public value", _id: id, [plan.rankAlias!]: "3eaaaaab" },
    ]);
    expect(page.rows).toEqual([{ title: "one", searchRank: "public value" }]);
  });
  test("separates v1/v2 and rejects authenticated malformed envelopes, expiry and key rotation", async () => {
    const codec = createSearchCursor(secret, descriptor, input, context, undefined, resolved());
    const token = await codec.issue(["3eaaaaab", id], "forward");
    const { payload, protectedHeader } = await jwtDecrypt(token, Buffer.from(secret, "hex"));
    expect(protectedHeader.typ).toBe("kello.search.cursor.v2");
    expect(payload.keys).toEqual([
      { kind: "rank-float4", value: "3eaaaaab" },
      { kind: "uuid", value: id },
    ]);
    for (const changed of [
      { ...payload, v: 1 },
      { ...payload, unexpected: true },
      {
        ...payload,
        keys: [
          { kind: "rank-float4", value: "3eaaaaab" },
          { kind: "uuid", value: id },
          { kind: "uuid", value: id },
        ],
      },
      {
        ...payload,
        keys: [
          { kind: "number", value: 0.3333333432674408 },
          { kind: "uuid", value: id },
        ],
      },
    ]) {
      const forged = await new EncryptJWT(changed)
        .setProtectedHeader({ alg: "dir", enc: "A256GCM", typ: "kello.search.cursor.v2" })
        .encrypt(Buffer.from(secret, "hex"));
      await expect(codec.read(forged, "forward")).rejects.toMatchObject({ code: "INVALID_CURSOR" });
    }
    const legacy = createSearchCursor(secret, descriptor, { columns: { title: true } }, context);
    await expect(legacy.read(token, "forward")).rejects.toMatchObject({ code: "INVALID_CURSOR" });
    await expect(codec.read(await legacy.issue([42, id], "forward"), "forward")).rejects.toMatchObject({
      code: "INVALID_CURSOR",
    });
    await expect(
      createSearchCursor("02".repeat(32), descriptor, input, context, undefined, resolved()).read(token, "forward"),
    ).rejects.toMatchObject({ code: "INVALID_CURSOR" });
    await expect(
      createSearchCursor(secret, descriptor, input, context, () => new Date(Date.now() + 3601000), resolved()).read(
        token,
        "forward",
      ),
    ).rejects.toMatchObject({ code: "INVALID_CURSOR" });
    await expect(codec.read(token + "x", "forward")).rejects.toMatchObject({ code: "INVALID_CURSOR" });
  });
  test("strict v2 binds raw and canonical query but allows root page size changes", async () => {
    const codec = createSearchCursor(secret, descriptor, input, context, undefined, resolved());
    const token = await codec.issue(["3eaaaaab", id], "forward");
    expect(
      await createSearchCursor(secret, descriptor, { ...input, limit: 2 }, context, undefined, resolved()).read(
        token,
        "forward",
      ),
    ).toEqual(["3eaaaaab", id]);
    for (const keys of [
      ["80000000", id],
      ["7f800000", id],
      ["3eaaaaab", "wrong"],
      [0.333333, id],
      ["3eaaaaab", id, id],
    ])
      await expect(codec.issue(keys, "forward")).rejects.toMatchObject({ code: "INVALID_CURSOR" });
    await expect(codec.read(token, "backward")).rejects.toMatchObject({ code: "INVALID_CURSOR" });
    const changed = { ...input, fullText: { ...input.fullText, query: "cats" } };
    await expect(
      createSearchCursor(
        secret,
        descriptor,
        changed,
        context,
        undefined,
        resolveFullText(descriptor, changed, parsed),
      ).read(token, "forward"),
    ).rejects.toMatchObject({ code: "INVALID_CURSOR" });
    await expect(
      createSearchCursor(
        secret,
        descriptor,
        input,
        context,
        undefined,
        resolveFullText(descriptor, input, { ...parsed, canonical: "'cats'" }),
      ).read(token, "forward"),
    ).rejects.toMatchObject({ code: "INVALID_CURSOR" });
  });
  test("empty parsed query still compiles current authorization and yields normal empty envelope", async () => {
    const empty = resolveFullText(descriptor, input, { canonical: "", nodes: 0, tree: "" });
    const plan = await prepareSearchPage(descriptor, input, context, secret, empty);
    const query = dialect.sqlToQuery(plan.where(schema.tables.articles));
    expect(query.sql).toContain("false");
    expect(query.sql).toContain("<>");
    expect(await finishSearchPage(plan, [])).toEqual({ rows: [], nextCursor: null, previousCursor: null });
  });
});
