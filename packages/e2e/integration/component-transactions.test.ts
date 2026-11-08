import assert from "node:assert/strict";
import { expect, test } from "bun:test";
import { call } from "@orpc/server";
import { Context } from "effect";
import { defineRelations, sql } from "drizzle-orm";
import pg from "pg";
import * as v from "valibot";
import {
  createComponentCallRegistry,
  defineSchema,
  connectDatabase,
  createProjectProcedures,
  createDatabaseMiddleware,
  bindRpcDatabaseProcedure,
  Invocation,
} from "kello/server";

const connectionString = process.env.KELLO_TEST_DATABASE_URL;
test.skipIf(!connectionString)(
  "different relation graphs share one owned transaction and rollback on caught child failure",
  async () => {
    if (!connectionString) throw new Error("Missing database URL");
    const namespace = `kello_component_tx_${crypto.randomUUID().replaceAll("-", "")}`;
    const admin = new pg.Client({ connectionString });
    await admin.connect();
    const appSchema = defineSchema(() => ({}));
    const childSchema = defineSchema((s) => ({ child: { value: s.integer().notNull() } }), { namespace });
    const appRelations = defineRelations(appSchema.tables);
    const childRelations = defineRelations(childSchema.tables);
    const connection = await connectDatabase({ schema: appSchema, relations: appRelations, connectionString });
    try {
      await admin.query(`CREATE SCHEMA "${namespace}"`);
      await admin.query(`CREATE TABLE "${namespace}".counter (value integer NOT NULL)`);
      await admin.query(`INSERT INTO "${namespace}".counter VALUES (0)`);
      await admin.query(`CREATE TABLE "${namespace}".child (value integer NOT NULL)`);
      await admin.query(`INSERT INTO "${namespace}".child VALUES (10)`);
      const table = sql`${sql.identifier(namespace)}.${sql.identifier("counter")}`;
      const options = {
        connection,
        replay: { metadataNamespace: namespace, deployment: "test" },
        authorize: async () => {},
      };
      const child = bindRpcDatabaseProcedure(
        createProjectProcedures(childSchema)
          .procedure.use(createDatabaseMiddleware(childRelations, "automatic", childSchema))
          .input(v.boolean())
          .output(v.string())
          .handler(async ({ context, input }) => {
            const rows = await context.db.query.child.findMany({ columns: { value: true } });
            expect(rows[0]?.value).toBe(10);
            await new Promise((resolve) => setTimeout(resolve, 15));
            await context.db.execute(sql`UPDATE ${table} SET value = value + 1`);
            const tx = await context.db.execute<{ id: string }>(sql`SELECT pg_current_xact_id()::text AS id`);
            if (input) throw new Error("child failure");
            return tx.rows[0]!.id;
          }),
        options,
      );
      const parent = bindRpcDatabaseProcedure(
        createProjectProcedures(appSchema)
          .procedure.use(createDatabaseMiddleware(appRelations, "automatic", appSchema))
          .input(v.boolean())
          .output(v.boolean())
          .handler(async ({ context, input }) => {
            await context.db.execute(sql`UPDATE ${table} SET value = value + 1`);
            const tx = await context.db.execute<{ id: string }>(sql`SELECT pg_current_xact_id()::text AS id`);
            try {
              return (await call(child, input, { context })) === tx.rows[0]!.id;
            } catch {
              return false;
            }
          }),
        options,
      );
      const invocation = { requestId: "nested", identity: null, signal: new AbortController().signal };
      const context = { ...invocation, "effect/context": Context.make(Invocation, invocation) };
      expect(await call(parent, false, { context })).toBe(true);
      expect((await admin.query(`SELECT value FROM "${namespace}".counter`)).rows[0].value).toBe(2);
      await assert.rejects(call(parent, true, { context }));
      expect((await admin.query(`SELECT value FROM "${namespace}".counter`)).rows[0].value).toBe(2);
      const registry = createComponentCallRegistry([
        { name: "app", internal: { child }, exported: {}, dependencies: {} },
      ]);
      const unawaited = bindRpcDatabaseProcedure(
        createProjectProcedures(appSchema)
          .procedure.use(createDatabaseMiddleware(appRelations, "automatic", appSchema))
          .input(v.boolean())
          .output(v.boolean())
          .handler(({ context, input }) =>
            registry.run("app", context, async ({ internal }) => {
              void internal.child(input);
              return true;
            }),
          ),
        options,
      );
      expect(await call(unawaited, false, { context })).toBe(true);
      expect((await admin.query(`SELECT value FROM "${namespace}".counter`)).rows[0].value).toBe(3);
      await assert.rejects(call(unawaited, true, { context }));
      expect((await admin.query(`SELECT value FROM "${namespace}".counter`)).rows[0].value).toBe(3);

      // A scoped adapter and its prepared queries keep the original invocation guard.
      let retainedRead: (() => Promise<{ value: number }[]>) | undefined;
      let retainedPrepared: (() => Promise<{ value: number }[]>) | undefined;
      const capture = bindRpcDatabaseProcedure(
        createProjectProcedures(childSchema)
          .procedure.use(createDatabaseMiddleware(childRelations, "automatic", childSchema))
          .handler(({ context }) => {
            retainedRead = () => context.db.query.child.findMany({ columns: { value: true } });
            const prepared = context.db.query.child.findMany({ columns: { value: true } }).prepare("retained_child");
            retainedPrepared = () => prepared.execute();
            return true;
          }),
        options,
      );
      const captureParent = bindRpcDatabaseProcedure(
        createProjectProcedures(appSchema)
          .procedure.use(createDatabaseMiddleware(appRelations, "automatic", appSchema))
          .handler(({ context }) => call(capture, undefined, { context })),
        options,
      );
      await call(captureParent, undefined, { context });
      assert(retainedRead && retainedPrepared);
      await assert.rejects(retainedRead());
      await assert.rejects(retainedPrepared());
      const foreign = bindRpcDatabaseProcedure(
        createProjectProcedures(appSchema)
          .procedure.use(createDatabaseMiddleware(appRelations, "automatic", appSchema))
          .handler(async () => {
            assert(retainedRead && retainedPrepared);
            await assert.rejects(retainedRead());
            await assert.rejects(retainedPrepared());
            return true;
          }),
        options,
      );
      expect(
        await call(foreign, undefined, {
          context: { ...context, requestId: "other", identity: { issuer: "test", subject: "other" } },
        }),
      ).toBe(true);

      const readonly = bindRpcDatabaseProcedure(
        createProjectProcedures(appSchema)
          .procedure.use(createDatabaseMiddleware(appRelations, "read", appSchema))
          .handler(({ context }) => call(child, false, { context: { ...context, operation: "mutation" } })),
        options,
      );
      await assert.rejects(call(readonly, undefined, { context }));
      const cancelled = new AbortController();
      const abortParent = bindRpcDatabaseProcedure(
        createProjectProcedures(appSchema)
          .procedure.use(createDatabaseMiddleware(appRelations, "automatic", appSchema))
          .handler(({ context }) =>
            registry.run("app", context, async ({ internal }) => {
              void internal.child(false);
              cancelled.abort();
              return true;
            }),
          ),
        options,
      );
      await assert.rejects(call(abortParent, undefined, { context: { ...context, signal: cancelled.signal } }));
      expect((await admin.query(`SELECT value FROM "${namespace}".counter`)).rows[0].value).toBe(3);
      const invalidInput = bindRpcDatabaseProcedure(
        createProjectProcedures(appSchema)
          .procedure.use(createDatabaseMiddleware(appRelations, "automatic", appSchema))
          .handler(({ context }) =>
            registry.run("app", context, async ({ internal }) => {
              await context.db.execute(sql`UPDATE ${table} SET value = 999`);
              try {
                // @ts-expect-error Malformed JavaScript callers still require runtime validation.
                await internal.child("invalid");
              } catch {
                return true;
              }
              return false;
            }),
          ),
        options,
      );
      await assert.rejects(call(invalidInput, undefined, { context }));
      expect((await admin.query(`SELECT value FROM "${namespace}".counter`)).rows[0].value).toBe(3);
      // Pool remains usable after cancellation and child rollback.
      expect(await call(parent, false, { context })).toBe(true);
      expect((await admin.query(`SELECT value FROM "${namespace}".counter`)).rows[0].value).toBe(5);
    } finally {
      await connection.close();
      await admin.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
      await admin.end();
    }
  },
);
