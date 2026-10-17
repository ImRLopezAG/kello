import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test("Node 24 imports compiled exports and serves the HTTP protocol without Bun globals", async () => {
  const process = Bun.spawn(
    [
      "node",
      "--input-type=module",
      "-e",
      `import assert from "node:assert/strict";
     assert.equal(Number(process.versions.node.split(".")[0]), 24);
     assert.equal("Bun" in globalThis, false);
     await import("kello/server");
     await import("kello/client");
     await import("kello/react");
     await import("@neon/functions/hono");
     const { createProjectProcedures, defineSchema } = await import("kello/server");
     const { createORPCClient } = await import("kello/client");
     const { RPCLink } = await import("@orpc/client/fetch");
     const { createRpcHttpApp } = await import("kello/neon");
     const { procedure } = createProjectProcedures(defineSchema(() => ({})));
     const version = "a".repeat(64);
     const app = createRpcHttpApp({
       version,
       origins: [],
       verify: async () => ({ identity: {issuer: "test", subject: "alice"}, expiresAt: Date.now()/1000 + 60 }),
       router: { read: procedure.handler(({ context }) => ({
         subject: context.identity.subject, date: new Date("2026-09-24T00:00:00Z"), count: 9n
       })) }
     });
     const client = createORPCClient(new RPCLink({
       origin: "https://node.example.test", url: "/api/kello/rpc",
       headers: {authorization: "Bearer test", "x-loom-protocol": "loom-orpc-2", "x-loom-version": version},
       fetch: (request, init) => app.fetch(new Request(request, init))
     }));
     assert.deepEqual(await client.read(), {
       subject: "alice", date: new Date("2026-09-24T00:00:00Z"), count: 9n
     });
     const refused = await app.fetch(new Request("https://node.example.test/api/kello/call", {
       method: "POST", headers: {"content-type": "application/json"}, body: "{}"
     }));
     assert.equal(refused.status, 404);`,
    ],
    { cwd: fileURLToPath(new URL("../../../../apps/kello/", import.meta.url)), stdout: "pipe", stderr: "pipe" },
  );
  const stderr = await new Response(process.stderr).text();
  expect({ code: await process.exited, stderr }).toEqual({ code: 0, stderr: "" });
  const browser = await Bun.build({
    entrypoints: [fileURLToPath(new URL("../../../../apps/kello/dist/core/client/index.js", import.meta.url))],
    target: "browser",
  });
  expect(browser.success).toBe(true);
  const code = await browser.outputs[0]?.text();
  expect(code).toContain("createRpcHttpTransport");
  expect(code).not.toContain("createRpcTransport");
  expect(code).not.toContain("node:");
  expect(code).not.toContain("DATABASE_URL");
});

test.skipIf(!process.env.LOOM_TEST_DATABASE_URL)("Node 24 enforces database invocation lifetime", async () => {
  const child = Bun.spawn(
    [
      "node",
      "--input-type=module",
      "-e",
      `
    import assert from "node:assert/strict";
    import { connectDatabase, defineSchema, runFunctionTransaction } from "kello/server";
    import { defineRelations, sql } from "drizzle-orm";
    const schema = defineSchema(() => ({}));
    const connection = await connectDatabase({ schema, relations: defineRelations(schema.tables), connectionString: process.env.LOOM_TEST_DATABASE_URL });
    try {
      const late = await runFunctionTransaction(connection, "query", async tx => {
        assert.deepEqual((await tx.execute(sql.raw("SELECT 1 AS value"))).rows, [{value: 1}]);
        const saved = tx.execute(sql.raw("SELECT 2 AS value"));
        return async () => { await saved; };
      });
      await assert.rejects(late(), /inactive/i);
      assert.equal(connection.pool.idleCount, connection.pool.totalCount);
    } finally { await connection.close(); }
    `,
    ],
    { cwd: fileURLToPath(new URL("../../../../apps/kello/", import.meta.url)), stdout: "pipe", stderr: "pipe" },
  );
  const stderr = await new Response(child.stderr).text();
  expect({ code: await child.exited, stderr }).toEqual({ code: 0, stderr: "" });
});

test.skipIf(!process.env.LOOM_TEST_DATABASE_URL)(
  "patched introspection initializes independently in Node ESM and CommonJS",
  async () => {
    for (const mode of ["esm", "cjs"]) {
      const child = Bun.spawn(
        [
          "node",
          "--input-type=module",
          "-e",
          `
      import assert from "node:assert/strict";
      import { createRequire } from "node:module";
      import { drizzle } from "drizzle-orm/node-postgres";
      import pg from "pg";
      const api = process.argv[1] === "esm" ? await import("drizzle-kit/api-postgres")
        : createRequire(import.meta.url)("drizzle-kit/api-postgres");
      const namespace = "verify_" + crypto.randomUUID().replaceAll("-", "");
      const client = new pg.Client({ connectionString: process.env.LOOM_TEST_DATABASE_URL });
      await client.connect();
      try {
        await client.query('CREATE SCHEMA "' + namespace + '"');
        await client.query('CREATE TABLE "' + namespace + '".tasks (id integer PRIMARY KEY)');
        await client.query('BEGIN READ ONLY');
        const db = drizzle({ client });
        const snapshot = await api.inspectSchema(db, [namespace]);
        assert(snapshot.ddl.some(entity => entity.entityType === "tables" && entity.name === "tasks"));
        assert(snapshot.ddl.every(entity => !("schema" in entity) || entity.schema === namespace));
        await assert.rejects(api.inspectSchema(db, []), /explicit schema/);
      } finally {
        await client.query('ROLLBACK');
        await client.query('DROP SCHEMA "' + namespace + '" CASCADE');
        await client.end();
      }
    `,
          mode,
        ],
        {
          cwd: fileURLToPath(new URL("../../", import.meta.url)),
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const stderr = await new Response(child.stderr).text();
      expect({ mode, code: await child.exited, stderr }).toEqual({ mode, code: 0, stderr: "" });
    }
  },
);
