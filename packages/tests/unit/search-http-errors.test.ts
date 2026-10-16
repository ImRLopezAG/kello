import { expect, test } from "vite-plus/test";
import { ORPCError, ValidationError } from "@orpc/server";
import { defineRelations } from "drizzle-orm";
import { createRpcHttpApp, createRpcOpenApiApp } from "../../../apps/kello/src/core/adapters/neon/rpc-http";
import { createProjectProcedures } from "../../../apps/kello/src/core/server/rpc/procedure";
import { defineSchema } from "../../../apps/kello/src/core/schema/define-schema";
import { defineTable } from "../../../apps/kello/src/core/schema/table";
import { fields } from "../../../apps/kello/src/core/schema/fields";
import { searchErrors } from "../../../apps/kello/src/core/search/errors";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import * as v from "valibot";

test("search errors retain codes and HTTP 400 in RPC, REST and OpenAPI", async () => {
  const { procedure } = createProjectProcedures(defineSchema(() => ({})));
  const codes = ["INVALID_SELECTION", "INVALID_CURSOR", "QUERY_BUDGET_EXCEEDED"] as const;
  const router = Object.fromEntries(
    codes.map((code) => [
      code,
      procedure
        .errors(searchErrors)
        .output(v.null())
        .handler(() => {
          if (code === "INVALID_CURSOR") throw new ORPCError(code, { data: { restart: true } });
          throw new ORPCError(code);
        }),
    ]),
  );
  const version = "a".repeat(64);
  const options = {
    router,
    version,
    origins: [],
    allowAnonymous: true,
    verify: async () => {
      throw new Error("Anonymous fixture must not verify");
    },
  };
  const rpc = createRpcHttpApp(options);
  const rest = await createRpcOpenApiApp(options);
  for (const code of codes) {
    expect(rest.document.paths?.[`/${code}`]?.post?.responses?.["400"]).toBeDefined();
    for (const [prefix, app, body] of [
      ["rpc", rpc, '{"json":null}'],
      ["openapi", rest, "null"],
    ] as const) {
      const response = await app.fetch(
        new Request(`https://service.test/api/kello/${prefix}/${code}`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-loom-version": version, "x-loom-protocol": "loom-orpc-2" },
          body,
        }),
      );
      expect(response.status).toBe(400);
      const payload =
        prefix === "rpc"
          ? v.parse(v.object({ json: v.object({ code: v.string() }) }), await response.json()).json
          : v.parse(v.object({ code: v.string() }), await response.json());
      expect(payload.code).toBe(code);
    }
  }
});

function searchFixture() {
  const schema = defineSchema(() => ({
    articles: defineTable(
      { title: fields.text().notNull() },
      {
        fullText: {
          content: { config: "pg_catalog.english", fields: [{ field: "title", weight: "A" }], version: "1" },
        },
      },
    ),
  }));
  const bindings = createProjectProcedures(schema, defineRelations(schema.tables));
  const policy = {
    scope: "public",
    columns: ["title"],
    filter: ["title"],
    text: ["title"],
    budgets: { textLength: 4, fullTextQueryBytes: 6 },
    fullText: ["content"],
  } as const;
  const pair = bindings.validators.tables.articles.search(policy);
  const legacy = bindings.validators.tables.articles.search({ scope: "public", columns: ["title"] });
  return { ...bindings, pair, legacy };
}

const invalidFullTextInputs = [
  {
    name: "raw UTF16 budget before trimming",
    input: { fullText: { document: "content", query: " a   " } },
    code: "QUERY_BUDGET_EXCEEDED",
  },
  {
    name: "raw UTF8 budget within UTF16 limit",
    input: { fullText: { document: "content", query: "😀😀" } },
    code: "QUERY_BUDGET_EXCEEDED",
  },
  { name: "malformed selection", input: [], code: "INVALID_SELECTION" },
  { name: "missing query", input: { fullText: { document: "content" } }, code: "INVALID_SELECTION" },
  { name: "non-string query", input: { fullText: { document: "content", query: 1 } }, code: "INVALID_SELECTION" },
  {
    name: "unknown document precedes budget",
    input: { fullText: { document: "hidden", query: "oversized" } },
    code: "INVALID_SELECTION",
  },
  {
    name: "extra SQL control",
    input: { fullText: { document: "content", query: "a", sql: "SELECT *" } },
    code: "INVALID_SELECTION",
  },
  {
    name: "forged config",
    input: { fullText: { document: "content", query: "a", config: "pg_catalog.simple" } },
    code: "INVALID_SELECTION",
  },
  { name: "forged rank", input: { fullText: { document: "content", query: "a", rank: 1 } }, code: "INVALID_SELECTION" },
  { name: "NUL", input: { fullText: { document: "content", query: "a\0b" } }, code: "INVALID_SELECTION" },
  {
    name: "malformed Unicode",
    input: { fullText: { document: "content", query: "\ud800" } },
    code: "INVALID_SELECTION",
  },
  {
    name: "competing ordering",
    input: { fullText: { document: "content", query: "a" }, orderBy: [] },
    code: "INVALID_SELECTION",
  },
] as const;

test("FTS validation returns native issues and preserves valid values and oRPC issues identity", async () => {
  const { pair, legacy } = searchFixture();
  for (const { name, input } of invalidFullTextInputs) {
    const result = await pair.input["~standard"].validate(input);
    expect(result.issues, name).toEqual([{ message: "Invalid search input" }]);
    const issues = result.issues!;
    expect(new ValidationError({ message: "Invalid input", issues, invalidData: input }).issues).toBe(issues);
    expect(JSON.parse(JSON.stringify(issues))).toEqual([{ message: "Invalid search input" }]);
  }
  const input = { fullText: { document: "content", query: " é " } };
  const result = await pair.input["~standard"].validate(input);
  expect(result).toEqual({ value: input });
  if ("value" in result) expect(result.value).toBe(input);
  const legacyInvalid = await legacy.input["~standard"].validate({ unexpected: true });
  expect(legacyInvalid.issues).toEqual([{ message: "Invalid search input" }]);
});

test("owned FTS input rejects before the handler in RPC and OpenAPI without trusting copied issues", async () => {
  const { procedure, pair, legacy } = searchFixture();
  const rejected = await pair.input["~standard"].validate(invalidFullTextInputs[0].input);
  const copied = rejected.issues!.map((issue) => ({ ...issue }));
  const copiedArray = [...rejected.issues!];
  const serialized: readonly StandardSchemaV1.Issue[] = JSON.parse(JSON.stringify(rejected.issues));
  const forged = [{ message: "QUERY_BUDGET_EXCEEDED", code: "QUERY_BUDGET_EXCEEDED" }];
  let calls = 0;
  const page = { rows: [{ title: "sentinel" }], nextCursor: null, previousCursor: null };
  const handler = () => {
    calls++;
    return page;
  };
  function untrustedInput(issues: readonly StandardSchemaV1.Issue[]) {
    return {
      "~standard": { ...pair.input["~standard"], validate: () => ({ issues }) },
    };
  }
  const router = {
    search: procedure.errors(searchErrors).input(pair.input).output(pair.output).handler(handler),
    legacy: procedure.errors(searchErrors).input(legacy.input).output(legacy.output).handler(handler),
    copied: procedure.errors(searchErrors).input(untrustedInput(copied)).output(pair.output).handler(handler),
    copiedArray: procedure.errors(searchErrors).input(untrustedInput(copiedArray)).output(pair.output).handler(handler),
    serialized: procedure.errors(searchErrors).input(untrustedInput(serialized)).output(pair.output).handler(handler),
    forged: procedure.errors(searchErrors).input(untrustedInput(forged)).output(pair.output).handler(handler),
    undeclared: procedure.input(pair.input).output(pair.output).handler(handler),
  };
  const version = "a".repeat(64);
  const options = {
    router,
    version,
    origins: [],
    allowAnonymous: true,
    verify: async () => {
      throw new Error("Anonymous fixture must not verify");
    },
  };
  const rpc = createRpcHttpApp(options);
  const rest = await createRpcOpenApiApp(options);
  const errorResponse = v.object({ code: v.string(), message: v.string() });
  expect(rest.document.paths?.["/search"]?.post?.responses?.["400"]).toBeDefined();
  for (const [prefix, app] of [
    ["rpc", rpc],
    ["openapi", rest],
  ] as const) {
    async function request(route: string, serializedInput: string) {
      return app.fetch(
        new Request(`https://service.test/api/kello/${prefix}/${route}`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-loom-version": version, "x-loom-protocol": "loom-orpc-2" },
          body: prefix === "rpc" ? `{"json":${serializedInput}}` : serializedInput,
        }),
      );
    }
    for (const { name, input, code } of invalidFullTextInputs) {
      const before = calls;
      const response = await request("search", JSON.stringify(input));
      expect(response.status, `${prefix}: ${name}`).toBe(400);
      const body: unknown = await response.json();
      const error =
        prefix === "rpc" ? v.parse(v.object({ json: errorResponse }), body).json : v.parse(errorResponse, body);
      expect(error.code, `${prefix}: ${name}`).toBe(code);
      expect(error.message).toBe(searchErrors[code].message);
      expect(calls).toBe(before);
    }
    for (const route of ["legacy", "copied", "copiedArray", "serialized", "forged", "undeclared"]) {
      const before = calls;
      const response = await request(route, JSON.stringify({ unexpected: true }));
      expect(response.status).toBe(400);
      const body: unknown = await response.json();
      const error =
        prefix === "rpc" ? v.parse(v.object({ json: errorResponse }), body).json : v.parse(errorResponse, body);
      expect(error).toMatchObject({ code: "BAD_REQUEST", message: "Invalid input" });
      expect(calls).toBe(before);
    }
    const before = calls;
    const response = await request("search", JSON.stringify({ fullText: { document: "content", query: " é " } }));
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(prefix === "rpc" ? v.parse(v.object({ json: v.unknown() }), body).json : body).toEqual(page);
    expect(calls).toBe(before + 1);
  }
});
