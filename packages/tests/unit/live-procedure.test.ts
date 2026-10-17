import { expect, expectTypeOf, test, vi } from "vite-plus/test";
import { call, implement, ORPCError } from "@orpc/server";
import { drizzle } from "drizzle-orm/node-postgres";
import { and, defineRelations, eq, gt, sql } from "drizzle-orm";
import pg from "pg";
import { pgTable, text } from "drizzle-orm/pg-core";
import { oc, defineContract, resolveContract } from "../../../apps/kello/src/core/contract";
import "../../../apps/kello/src/core/server/realtime/procedure";
import {
  defineApplication,
  prepareApplicationEnvironment,
} from "../../../apps/kello/src/core/server/application/definition";
import { defineSchema } from "../../../apps/kello/src/core/schema/define-schema";
import { defineTable } from "../../../apps/kello/src/core/schema/table";
import { liveRowsSource } from "../../../apps/kello/src/tooling/codegen/live-query";
import { applicationClientArtifacts } from "../../../apps/kello/src/tooling/codegen/application";
import { discoverProcedures } from "../../../apps/kello/src/tooling/codegen/procedures";
import { generateRpcOpenAPI } from "../../../apps/kello/src/core/server/rpc/openapi";
import { bindRpcDatabaseProcedure } from "../../../apps/kello/src/core/server/rpc/database";
import { rpcErrorBoundary } from "../../../apps/kello/src/core/server/rpc/procedure";
import type { ProcedureContext } from "../../../apps/kello/src/core/server/rpc/procedure";
import { rpcContext } from "../../../apps/kello/src/core/adapters/neon/rpc-context";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import * as v from "valibot";
import { z } from "zod";

const rows = v.array(v.strictObject({ id: v.string(), title: v.string() }));
const list = oc
  .input(
    v.strictObject({
      limit: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100)),
      after: v.optional(v.string()),
    }),
  )
  .output(rows)
  .live();
const table = pgTable("tasks", { id: text().notNull(), title: text().notNull(), tenant: text().notNull() });
const db = drizzle.mock();
const identity = { issuer: "https://issuer.test", subject: "alice", tenantId: "tenant-a" };
const expiresAt = () => Math.floor(Date.now() / 1000) + 3600;
function context() {
  return {
    identity,
    signal: new AbortController().signal,
    expiresAt: expiresAt(),
    login: { ...identity, id: "verified-login-A", expiresAt: expiresAt() },
    liveQueries: {
      secret: "nrt_live_1" + Buffer.alloc(32, 1).toString("base64url"),
      database: "test-db",
      deployment: "test-deployment",
    },
  };
}
const os = implement({ list, ordinary: oc.input(v.string()).output(v.string()) }).$context<
  ReturnType<typeof context>
>();
const queries: { sql: string; params: unknown[] }[] = [];
const router = os.router({
  list: os.list.live(({ context, input }) => {
    const query = db
      .select({ id: table.id, title: table.title })
      .from(table)
      .where(and(eq(table.tenant, context.identity.tenantId), input.after ? gt(table.id, input.after) : undefined))
      .orderBy(table.id)
      .limit(input.limit);
    queries.push(query.toSQL());
    return query;
  }),
  ordinary: os.ordinary.handler(({ input }) => input.toUpperCase()),
});

test("a live contract keeps validated pagination input and declares rows", async () => {
  const list = oc
    .input(v.strictObject({ limit: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100)) }))
    .output(v.array(v.strictObject({ id: v.string(), title: v.string() })))
    .live();
  const contract = resolveContract(defineContract({ list }), { validators: { tables: {}, id: () => v.string() } });
  const input = contract.list["~orpc"].inputSchemas![0]!;
  expect((await input["~standard"].validate({ limit: 10 })).issues).toBeUndefined();
  expect((await input["~standard"].validate({ limit: 101 })).issues).toBeDefined();
  expect((await contract.list["~orpc"].outputSchemas![0]!["~standard"].validate([])).issues).toBeDefined();
  const document = await generateRpcOpenAPI(router);
  expect(document.paths?.["/list"]).toBeDefined();
});

test("functions return a typed paginated SELECT; native validation runs before issuance without executing it", async () => {
  const issued = await call(router.list, { limit: 10 }, { context: context() });
  expectTypeOf(issued.query).toMatchTypeOf<{ capability: string }>();
  expect(issued.query.capability).toEqual(expect.any(String));
  expect(issued.scope).toEqual({ database: "test-db", deployment: "test-deployment" });
  expect(queries.at(-1)?.params).toEqual(["tenant-a", 10]);
  expect(queries.at(-1)?.sql).toContain("order by");
  const next = await call(router.list, { limit: 5, after: "task-10" }, { context: context() });
  expect(queries.at(-1)?.params).toEqual(["tenant-a", "task-10", 5]);
  expect(next.query.queryFingerprint).not.toBe(issued.query.queryFingerprint);
  const count = queries.length;
  await expect(call(router.list, { limit: 101 }, { context: context() })).rejects.toMatchObject({
    code: "BAD_REQUEST",
  });
  expect(queries.length).toBe(count);
  expect(await call(router.ordinary, "ordinary", { context: context() })).toBe("ORDINARY");
});

test("async native middleware can reject before query construction; trusted login is still required", async () => {
  const handler = vi.fn(() => db.select({ id: table.id, title: table.title }).from(table));
  const denied = os.list
    .use(async () => {
      throw new ORPCError("FORBIDDEN");
    })
    .live(handler);
  await expect(call(denied, { limit: 1 }, { context: context() })).rejects.toMatchObject({ code: "FORBIDDEN" });
  expect(handler).not.toHaveBeenCalled();
  await expect(
    call(router.list, { limit: 1 }, { context: { ...context(), login: { ...context().login, subject: "other" } } }),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  const abort = context();
  abort.signal = AbortSignal.abort();
  await expect(call(router.list, { limit: 1 }, { context: abort })).rejects.toThrow();
});

test("custom Drizzle decoders are refused rather than silently changing live rows", async () => {
  const custom = os.list.live(() =>
    db.select({ id: table.id, title: sql<string>`${table.title}`.mapWith(String).as("title") }).from(table),
  );
  await expect(call(custom, { limit: 1 }, { context: context() })).rejects.toThrow("mapWith");
});

test("renamed columns require SQL aliases because Neon does not run Drizzle's result mapper", async () => {
  const renamed = pgTable("renamed_tasks", { key: text("_id").notNull(), title: text().notNull() });
  const mismatched = os.list.live(() => db.select({ id: renamed.key, title: renamed.title }).from(renamed));
  await expect(call(mismatched, { limit: 1 }, { context: context() })).rejects.toThrow("explicit SQL alias");
  const wrongAlias = os.list.live(() =>
    db.select({ id: sql<string>`${renamed.key}`.as("wrong"), title: renamed.title }).from(renamed),
  );
  await expect(call(wrongAlias, { limit: 1 }, { context: context() })).rejects.toThrow("aliases must match");
  const aliased = os.list.live(() =>
    db.select({ id: sql<string>`${renamed.key}`.as("id"), title: renamed.title }).from(renamed),
  );
  expect((await call(aliased, { limit: 1 }, { context: context() })).version).toBe(1);
});

test("live declarations force read-only acquisition even when the caller requests mutation intent", async () => {
  const relations = defineRelations({ table });
  const db = drizzle.mock({ relations });
  const pool = new pg.Pool();
  // Refuse before SQL: this check observes the actual transaction configuration,
  // without opening a connection or pretending to prove PostgreSQL enforcement.
  const transaction = vi.fn(async (..._args: Parameters<typeof db.transaction>): Promise<never> => {
    throw new Error("offline acquisition boundary");
  });
  const base = implement({ list }).$context<ProcedureContext>();
  const leaf = base.list.use(rpcErrorBoundary).live(() => db.select({ id: table.id, title: table.title }).from(table));
  const bound = bindRpcDatabaseProcedure(leaf, {
    connection: { db, pool, transaction, close: () => pool.end() },
    replay: { deployment: "test", metadataNamespace: "loom_test" },
    authorize: async () => {},
  });
  try {
    const authority = context();
    await expect(
      call(
        bound,
        { limit: 1 },
        {
          context: {
            ...rpcContext(
              { identity, expiresAt: authority.expiresAt },
              authority.signal,
              undefined,
              "mutation",
              authority.login,
            ),
            liveQueries: authority.liveQueries,
          },
        },
      ),
    ).rejects.toThrow();
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(transaction.mock.calls[0]?.[1]).toEqual({ isolationLevel: "repeatable read", accessMode: "read only" });
  } finally {
    await pool.end();
  }
});

test("generated React validators preserve flat scalar validation and reject unrepresentable codecs", async () => {
  const schema = v.array(
    v.strictObject({
      id: v.pipe(v.string(), v.uuid()),
      title: v.pipe(v.string(), v.minLength(3)),
      done: v.boolean(),
      count: v.nullable(v.pipe(v.number(), v.integer(), v.minValue(0))),
    }),
  );
  const source = liveRowsSource(schema);
  // Exercise the generated browser validator, without importing server bindings.
  const generated: unknown = new Function("v", `return ${source}`)(v);
  const validate = v.parse(v.object({ "~standard": v.object({ validate: v.function() }) }), generated)["~standard"]
    .validate;
  const valid = [{ id: "4a3b1915-33ab-4eec-99fe-7d11a38a98fa", title: "task", done: true, count: null }];
  expect(await validate(valid)).toEqual(await schema["~standard"].validate(valid));
  for (const input of [[{ ...valid[0], title: "x" }], [{ ...valid[0], id: "invalid" }], [{ ...valid[0], count: -1 }]]) {
    expect(await validate(input)).toMatchObject({ issues: expect.any(Array) });
  }
  expect(() => liveRowsSource(v.array(v.object({ nested: v.object({ title: v.string() }) })))).toThrow("flat");
  expect(() =>
    liveRowsSource(
      v.array(
        v.object({
          title: v.pipe(
            v.string(),
            v.check((value) => value === "special"),
          ),
        }),
      ),
    ),
  ).toThrow();
  expect(() =>
    liveRowsSource(
      v.array(
        v.object({
          title: v.pipe(
            v.string(),
            v.transform((value) => value.toUpperCase()),
          ),
        }),
      ),
    ),
  ).toThrow();
});

test("normal function discovery emits opt-in HTTP live bindings without server runtime imports or Query caching", () => {
  const project = {
    backend: "/project/kello",
    version: "a".repeat(64),
    procedures: discoverProcedures([{ path: "tasks.ts", visibility: "public", exports: { default: router } }]),
  };
  const files = applicationClientArtifacts(project, "/project/src/generated");
  expect(files["api.js"]).toContain('const livePaths = [["tasks","list"]]');
  expect(files["api.js"]).not.toMatch(/createRpcTransport\b/);
  expect(files["api.js"]).toContain("options.realtimeUrl ?? configuration.realtimeUrl");
  expect(files["api.js"]).toContain("live.dispose(); transport.dispose()");
  expect(files["api.js"]).toContain("Use the generated useLiveQuery hook");
  expect(files["react.js"]).toContain("createLiveQueryHooks");
  expect(files["react.js"]).not.toMatch(/contract-registry|kello\/server|kello\/contract|test-db|nrt_live_/);
  const ordinary = applicationClientArtifacts(
    { ...project, procedures: project.procedures.filter((entry) => entry.path.at(-1) === "ordinary") },
    "/project/src/generated",
  );
  expect(ordinary["react.js"]).toBeUndefined();
  expect(ordinary["api.js"]).not.toContain("createNeonLiveClient");
});

test("application environment binds the managed Realtime secret and the genuine session resolver once", async () => {
  const resolveLogin = vi.fn(async () => context().login);
  const app = defineApplication({
    liveQueries: ({ realtime }) => ({ ...context().liveQueries, secret: realtime.secret, resolveLogin }),
    rpc: ({ os }) => ({ os }),
  });
  const prepared = await prepareApplicationEnvironment(
    app,
    { LOOM_REALTIME_SECRET: "private-test-value" },
    { database: "test-db", deployment: "test-deployment" },
  );
  expect(prepared.liveQueries?.secret).toBe("private-test-value");
  expect(prepared.liveQueries?.resolveLogin).toBe(resolveLogin);
  expect(resolveLogin).not.toHaveBeenCalled();
  // Without the deployment-managed secret, live issuance stays unconfigured (fails closed).
  expect((await prepareApplicationEnvironment(app, {})).liveQueries).toBeUndefined();
});

test("generated modules execute with real public exports, HTTP issuance and SSR-safe typed hooks", async () => {
  const root = await mkdtemp(join(process.cwd(), ".live-procedure-"));
  const generated = join(root, "client");
  const backend = join(root, "kello");
  try {
    await mkdir(generated);
    await mkdir(join(backend, "_generated"), { recursive: true });
    await writeFile(
      join(backend, "_generated/config.js"),
      'export const configuration = {serviceUrl:"https://api.test"};',
    );
    const files = applicationClientArtifacts(
      {
        backend,
        version: "a".repeat(64),
        procedures: discoverProcedures([{ path: "tasks.ts", visibility: "public", exports: { default: router } }]),
      },
      generated,
    );
    for (const [name, body] of Object.entries(files)) await writeFile(join(generated, name), body);
    const issued = await call(router.list, { limit: 10 }, { context: context() });
    await writeFile(
      join(root, "check.mjs"),
      `
import assert from "node:assert/strict";
import React from "react";
import { renderToString } from "react-dom/server";
import { createClient } from "./client/react.js";
const requests = [];
globalThis.fetch = async (url, options) => {
  requests.push({url:String(url), headers:options.headers});
  return Response.json({json:${JSON.stringify(issued)}});
};
const connection = createClient({url:"https://api.test", realtimeUrl:"wss://realtime.test", getToken:async()=>"test-token", cachePrefix:"login-A"});
try {
  function List() {
    const result = connection.api.tasks.list.useLiveQuery({limit:10});
    return React.createElement("output", null, result.status);
  }
  assert.equal(renderToString(React.createElement(List)), "<output>connecting</output>");
  assert.equal(requests.length, 0, "SSR must not issue or subscribe");
  const result = await connection.client.tasks.list({limit:10});
  assert.equal(result.query.queryFingerprint, ${JSON.stringify(issued.query.queryFingerprint)});
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /api\\/kello\\/rpc\\/tasks\\/list/);
  const options = connection.rpc.tasks.list.queryOptions({input:{limit:10}});
  await assert.rejects(() => options.queryFn({signal:new AbortController().signal}), /useLiveQuery/);
  assert.equal(requests.length, 1, "Query utilities must never cache live capabilities");
} finally { connection.dispose(); }
console.log("generated-live-ok");
`,
    );
    const result = spawnSync(process.execPath, [join(root, "check.mjs")], {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    });
    expect({ status: result.status, stderr: result.stderr, error: result.error }).toEqual({
      status: 0,
      stderr: "",
      error: undefined,
    });
    expect(result.stdout.trim()).toBe("generated-live-ok");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("generated live rows accept framework ID branding without accepting arbitrary transforms", async () => {
  const schema = defineSchema((s) => ({ tasks: defineTable({ title: s.text().notNull() }) }));
  const rows = v.array(v.object({ _id: schema.id("tasks"), title: v.string() }));
  const source = liveRowsSource(rows);
  const generated: unknown = new Function("v", `return ${source}`)(v);
  const validate = v.parse(v.object({ "~standard": v.object({ validate: v.function() }) }), generated)["~standard"]
    .validate;
  const valid = [{ _id: "4a3b1915-33ab-4eec-99fe-7d11a38a98fa", title: "task" }];
  expect(await validate(valid)).toEqual(await rows["~standard"].validate(valid));
  expect(await validate([{ _id: "not-a-uuid", title: "task" }])).toMatchObject({ issues: expect.any(Array) });
  expect(() =>
    liveRowsSource(
      v.array(
        v.object({
          _id: v.pipe(
            schema.id("tasks"),
            v.transform(() => "changed"),
          ),
        }),
      ),
    ),
  ).toThrow();
});

test("Zod live rows retain UUID and string checks and reject transforms", () => {
  const source = liveRowsSource(z.array(z.object({ _id: z.uuid(), text: z.string().min(1).max(200) })));
  expect(source).toContain("z.fromJSONSchema(");
  const generated = new Function("z", `return ${source}`)(z);
  expect(generated.safeParse([{ _id: "00000000-0000-4000-8000-000000000001", text: "note" }]).success).toBe(true);
  expect(generated.safeParse([{ _id: "invalid", text: "note" }]).success).toBe(false);
  expect(generated.safeParse([{ _id: "00000000-0000-4000-8000-000000000001", text: "" }]).success).toBe(false);
  expect(generated.safeParse([{ _id: "00000000-0000-4000-8000-000000000001", text: "x".repeat(201) }]).success).toBe(
    false,
  );
  expect(() => liveRowsSource(z.array(z.object({ text: z.string().transform((text) => text.length) })))).toThrow();
});

test("Zod live generation refuses checks and actions missing from JSON Schema", () => {
  const unsupported = [
    z.array(z.object({ text: z.string().refine((text) => text === "allowed") })),
    z.array(z.object({ text: z.string() }).refine((row) => row.text === "allowed")),
    z.array(z.object({ text: z.string() })).superRefine((_rows, context) => {
      context.addIssue({ code: "custom", message: "not allowed" });
    }),
    z.array(z.object({ text: z.string().trim() })),
    z.array(z.object({ text: z.string().toLowerCase() })),
    z.array(z.object({ text: z.coerce.string() })),
  ];
  for (const rows of unsupported) expect(() => liveRowsSource(rows)).toThrow();
});

test("Zod live generation refuses regex flags rather than widening validation", () => {
  const rows = z.array(z.object({ text: z.string().regex(/^[^a]+$/i) }));
  expect(rows.safeParse([{ text: "A" }]).success).toBe(false);
  expect(() => liveRowsSource(rows)).toThrow();
  const source = liveRowsSource(z.array(z.object({ text: z.string().regex(/^[^a]+$/) })));
  const generated = new Function("z", `return ${source}`)(z);
  expect(generated.safeParse([{ text: "A" }]).success).toBe(true);
  expect(generated.safeParse([{ text: "a" }]).success).toBe(false);
});

test.each([
  ["schema protocol", z.url({ protocol: /^https$/ }), "http://example.com"],
  ["check protocol", z.string().check(z.url({ protocol: /^https$/ })), "http://example.com"],
  ["hostname", z.url({ hostname: /^allowed\.example$/ }), "https://other.example/path"],
])("Zod live generation refuses unrepresented URL %s restrictions", (_name, field, text) => {
  const rows = z.array(z.object({ text: field }));
  expect(rows.safeParse([{ text }]).success).toBe(false);
  expect(() => liveRowsSource(rows)).toThrow();
});

test.each([z.url({ normalize: true }), z.string().check(z.url({ normalize: true }))])(
  "Zod live generation refuses URL normalization",
  (field) => {
    const rows = z.array(z.object({ text: field }));
    const input = [{ text: "https://EXAMPLE.com:443/a/../b" }];
    expect(rows.parse(input)).not.toEqual(input);
    expect(() => liveRowsSource(rows)).toThrow();
  },
);
