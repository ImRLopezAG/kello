import assert from "node:assert/strict";
import { expect, test } from "bun:test";
import { call, Procedure } from "@orpc/server";
import type { RouterClient } from "@orpc/server";
import { Context, Layer } from "effect";
import { defineRelations, sql } from "drizzle-orm";
import pg from "pg";
import * as v from "valibot";
import { bootstrapDatabase } from "kello/tooling";
// The graph is an internal module; use its source dependencies so middleware
// capability registries are the same module instances as the graph under test.
import { bindRuntimeGraph } from "../../../apps/kello/src/core/server/rpc/runtime-graph";
import { createProjectProcedures } from "../../../apps/kello/src/core/server/rpc/procedure";
import { createDatabaseMiddleware } from "../../../apps/kello/src/core/server/rpc/database";
import { createEffectRuntime, Invocation } from "../../../apps/kello/src/core/server/effect/runtime";
import { connectDatabase } from "../../../apps/kello/src/core/server/database/connection";
import { defineSchema } from "../../../apps/kello/src/core/schema/define-schema";

const connectionString = process.env.LOOM_TEST_DATABASE_URL;
test.skipIf(!connectionString)(
  "assembled component calls preserve one retry owner and automatic calls execute once",
  async () => {
    if (!connectionString) throw new Error("Missing database URL");
    const namespace = `loom_scope_retry_${crypto.randomUUID().replaceAll("-", "")}`;
    const role = `${namespace}_role`;
    const admin = new pg.Client({ connectionString });
    await admin.connect();
    const schema = defineSchema(() => ({}));
    const childSchema = defineSchema(() => ({}), { namespace });
    const relations = defineRelations(schema.tables);
    const childRelations = defineRelations(childSchema.tables);
    const connection = await connectDatabase({ schema, relations, connectionString });
    const effects = createEffectRuntime(Layer.empty);
    try {
      await bootstrapDatabase({ connectionString, metadataNamespace: namespace, runtimeRole: role });
      await admin.query(`CREATE TABLE "${namespace}".counter (value integer NOT NULL)`);
      await admin.query(`INSERT INTO "${namespace}".counter VALUES (0)`);
      const table = sql`${sql.identifier(namespace)}.${sql.identifier("counter")}`;
      let attempts = 0;
      const child = createProjectProcedures(childSchema)
        .procedure.use(createDatabaseMiddleware(childRelations, "write", childSchema))
        .handler(async ({ context }) => {
          attempts++;
          await context.db.execute(sql`UPDATE ${table} SET value = value + 1`);
          if (attempts === 1)
            await context.db.execute(sql`DO $$ BEGIN RAISE EXCEPTION USING ERRCODE = '40001'; END $$`);
          return true;
        });
      const parent = createProjectProcedures(schema)
        .procedure.use(createDatabaseMiddleware(relations, "write", schema))
        .input(v.boolean())
        .handler(async ({ context, input }) => {
          await context.db.execute(sql`UPDATE ${table} SET value = value + 1`);
          // SAFETY: this fixture declares the exact child router in bindRuntimeGraph below.
          const scoped = context as typeof context & {
            components: { child: { rpc: RouterClient<{ write: typeof child }> } };
          };
          const result = scoped.components.child.rpc.write();
          if (input) await result;
          return true;
        });
      let externalEffects = 0;
      const automatic = createProjectProcedures(childSchema)
        .procedure.use(createDatabaseMiddleware(childRelations, "automatic", childSchema))
        .handler(async ({ context }) => {
          externalEffects++;
          await context.db.execute(sql`DO $$ BEGIN RAISE EXCEPTION USING ERRCODE = '40001'; END $$`);
          return true;
        });
      let denied = false;
      let sdkInitializations = 0;
      const graph = bindRuntimeGraph({
        entries: [
          { path: ["parent"], visibility: "public", procedure: parent },
          { path: ["automatic"], visibility: "public", procedure: automatic },
          { scope: "child", path: ["write"], visibility: "exported", procedure: child },
        ],
        scopes: [
          { name: "", dependencies: { child: "child" } },
          { name: "child", dependencies: {} },
        ],
        application: {
          serviceFactories: {
            child: () => {
              sdkInitializations++;
              return { sdk: {} };
            },
          },
          run: (work) => work(),
          runComponent: (_scope, work) => work(),
        },
        effects,
        activate: async () => {},
        authorize: async () => {},
        database: {
          connection,
          replay: { metadataNamespace: namespace, deployment: "test" },
          authorize: async () => {
            if (denied) throw new Error("Denied");
          },
        },
      });
      try {
        const invocation = { requestId: "retry-owner", identity: null, signal: new AbortController().signal };
        const context = { ...invocation, "effect/context": Context.make(Invocation, invocation) };
        const route = graph.router.parent;
        assert(route instanceof Procedure);
        for (const awaited of [true, false]) {
          attempts = 0;
          await admin.query(`UPDATE "${namespace}".counter SET value = 0`);
          expect(
            await call(route, awaited, {
              context: { ...context, idempotencyKey: crypto.randomUUID() },
              path: ["parent"],
            }),
          ).toBe(true);
          expect(attempts).toBe(2);
          expect((await admin.query(`SELECT value FROM "${namespace}".counter`)).rows[0].value).toBe(2);
        }
        const single = graph.router.automatic;
        assert(single instanceof Procedure);
        expect(sdkInitializations).toBe(0);
        denied = true;
        await assert.rejects(call(single, undefined, { context }));
        expect(sdkInitializations).toBe(0);
        denied = false;
        await assert.rejects(call(single, undefined, { context }), { code: "CONFLICT" });
        expect(sdkInitializations).toBe(1);
        expect(externalEffects).toBe(1);
      } finally {
        await graph.stop();
      }
    } finally {
      await effects.stop();
      await connection.close();
      await admin.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
      await admin.query(`DROP OWNED BY "${role}"`);
      await admin.query(`DROP ROLE IF EXISTS "${role}"`);
      await admin.end();
    }
  },
);
