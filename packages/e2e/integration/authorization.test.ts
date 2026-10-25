import assert from "node:assert/strict";
import { expect, test } from "bun:test";
import {
  connectDatabase,
  defineSchema,
  bindRpcDatabaseProcedure,
  createDatabaseMiddleware,
  createProjectProcedures,
  Invocation,
} from "kello/server";
import type { InvocationIdentity } from "kello/server";
import { call } from "@orpc/server";
import { Context } from "effect";
import { bootstrapDatabase } from "kello/tooling";
import { defineRelations, sql } from "drizzle-orm";
import pg from "pg";
import * as v from "valibot";

const connectionString = process.env.LOOM_TEST_DATABASE_URL;
test.skipIf(!connectionString)(
  "verified invocation identity drives RLS without leaking through a pooled session",
  async () => {
    if (!connectionString) throw new Error("Missing database URL");
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const metadataNamespace = `loom_auth_${suffix}`;
    const runtimeRole = `loom_runtime_${suffix}`;
    const admin = new pg.Client({ connectionString });
    await admin.connect();
    try {
      await bootstrapDatabase({ connectionString, metadataNamespace, runtimeRole });
      await admin.query(`ALTER ROLE "${runtimeRole}" LOGIN PASSWORD 'loom-test-only'`);
      await admin.query(`CREATE TABLE "${metadataNamespace}".documents (
      id text PRIMARY KEY, issuer text NOT NULL, owner text NOT NULL, tenant text NOT NULL, title text NOT NULL
    )`);
      await admin.query(`INSERT INTO "${metadataNamespace}".documents VALUES
      ('a', 'trusted', 'alice', 'one', 'Alice'), ('b', 'trusted', 'bob', 'two', 'Bob')`);
      await admin.query(`ALTER TABLE "${metadataNamespace}".documents ENABLE ROW LEVEL SECURITY`);
      await admin.query(`CREATE POLICY document_owner ON "${metadataNamespace}".documents USING (
      issuer = (nullif(current_setting('loom.identity', true), '')::jsonb ->> 'issuer')
      AND owner = (nullif(current_setting('loom.identity', true), '')::jsonb ->> 'subject')
      AND tenant = (nullif(current_setting('loom.identity', true), '')::jsonb ->> 'tenantId')
    )`);
      await admin.query(`GRANT SELECT, UPDATE ON "${metadataNamespace}".documents TO "${runtimeRole}"`);
      const address = new URL(connectionString);
      address.username = runtimeRole;
      address.password = "loom-test-only";
      const schema = defineSchema(() => ({}));
      const relations = defineRelations(schema.tables);
      const connection = await connectDatabase({
        schema,
        relations,
        connectionString: address.href,
        maxConnections: 1,
      });
      try {
        const table = sql`${sql.identifier(metadataNamespace)}.${sql.identifier("documents")}`;
        const { procedure } = createProjectProcedures(schema);
        const options = {
          connection,
          replay: { deployment: "authorization-test", metadataNamespace },
          authorize: async ({ db, identity }: { db: typeof connection.db; identity: InvocationIdentity | null }) => {
            const bound = await db.execute<{ identity: string; legacy_identity: string | null }>(
              sql`SELECT current_setting('kello.identity') AS identity,
                         current_setting('loom.identity', true) AS legacy_identity`,
            );
            expect(bound.rows[0]?.identity).toBe(JSON.stringify(identity));
            expect(bound.rows[0]?.legacy_identity).toBe(JSON.stringify(identity));
          },
        };
        const read = bindRpcDatabaseProcedure(
          procedure
            .use(createDatabaseMiddleware(relations, "read", schema))
            .input(v.string())
            .handler(async ({ context, input: id }) => {
              const rows = await context.db.execute<{ title: string }>(
                sql`SELECT title FROM ${table} WHERE id = ${id}`,
              );
              const session = await context.db.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
              return {
                titles: rows.rows.map((row) => row.title),
                subject: context.identity?.subject ?? null,
                requestId: context.requestId,
                pid: session.rows[0]?.pid ?? -1,
              };
            }),
          options,
        );
        const changeTenant = bindRpcDatabaseProcedure(
          procedure
            .use(createDatabaseMiddleware(relations, "write", schema))
            .input(v.string())
            .handler(async ({ context, input: tenant }) => {
              await context.db.execute(sql`UPDATE ${table} SET tenant = ${tenant} WHERE id = 'a'`);
              return null;
            }),
          options,
        );
        const who = procedure.handler(({ context }) => context.identity?.subject ?? null);
        const contextFor = (identity: InvocationIdentity | null) => {
          const invocation = { identity, requestId: crypto.randomUUID(), signal: new AbortController().signal };
          return {
            ...invocation,
            idempotencyKey: crypto.randomUUID(),
            "effect/context": Context.make(Invocation, invocation),
          };
        };
        const alice = { issuer: "trusted", subject: "alice", tenantId: "one" };
        const bob = { issuer: "trusted", subject: "bob", tenantId: "two" };
        const firstContext = contextFor(alice);
        const first = await call(read, "a", { context: firstContext });
        expect(first).toMatchObject({ titles: ["Alice"], subject: "alice", requestId: firstContext.requestId });
        const second = await call(read, "b", { context: contextFor(bob) });
        expect(second).toMatchObject({ titles: ["Bob"], subject: "bob" });
        expect(first.pid).toBe(second.pid);
        expect(await call(read, "b", { context: contextFor(alice) })).toMatchObject({ titles: [] });
        for (const identity of [
          null,
          { ...alice, issuer: "other" },
          { ...alice, tenantId: "two" },
          { issuer: "trusted", subject: "alice" },
        ]) {
          expect(await call(read, "a", { context: contextFor(identity) })).toMatchObject({ titles: [] });
        }
        await assert.rejects(call(changeTenant, "two", { context: contextFor(alice), path: ["documents", "move"] }), {
          code: "INTERNAL_SERVER_ERROR",
        });
        expect((await admin.query(`SELECT tenant FROM "${metadataNamespace}".documents WHERE id = 'a'`)).rows).toEqual([
          { tenant: "one" },
        ]);
        const outside = await connection.pool.query<{ identity: string | null; legacy_identity: string | null }>(
          "SELECT nullif(current_setting('kello.identity', true), '') AS identity, nullif(current_setting('loom.identity', true), '') AS legacy_identity",
        );
        expect(outside.rows[0]?.identity).toBeNull();
        expect(outside.rows[0]?.legacy_identity).toBeNull();
        expect((await connection.db.execute<{ id: string; tenant: string }>(sql`SELECT * FROM ${table}`)).rows).toEqual(
          [],
        );
        await assert.rejects(
          connection.db.execute<{ id: string; tenant: string }>(
            sql`CREATE TABLE ${sql.identifier(metadataNamespace)}.forbidden (id integer)`,
          ),
        );
        expect(await call(read, "a", { context: contextFor(alice) })).toMatchObject({ titles: ["Alice"] });
        expect(await call(who, undefined, { context: contextFor(bob) })).toBe("bob");
        expect(connection.pool.totalCount).toBe(1);
        expect(connection.pool.idleCount).toBe(1);
      } finally {
        await connection.close();
      }
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS "${metadataNamespace}" CASCADE`);
      await admin.query(`DROP ROLE IF EXISTS "${runtimeRole}"`);
      await admin.end();
    }
  },
);
