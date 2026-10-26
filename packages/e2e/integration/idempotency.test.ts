import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { call, ORPCError } from "@orpc/server";
import { Context } from "effect";
import type { InvocationIdentity } from "kello/server";
import {
  connectDatabase,
  bindRpcDatabaseProcedure,
  createDatabaseMiddleware,
  createProjectProcedures,
  Invocation,
  defineSchema,
  mutationReplayWindowSeconds,
} from "kello/server";
import { bootstrapDatabase } from "kello-cli";
import { defineRelations, sql } from "drizzle-orm";
import pg from "pg";
import * as v from "valibot";

const connectionString = process.env.LOOM_TEST_DATABASE_URL;
test.skipIf(!connectionString)(
  "mutation replay is atomic, scoped, reauthorized and expires without executing again",
  async () => {
    if (!connectionString) throw new Error("Missing database URL");
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const metadataNamespace = `loom_replay_${suffix}`;
    const runtimeRole = `loom_runtime_${suffix}`;
    const admin = new pg.Client({ connectionString });
    await admin.connect();
    try {
      await bootstrapDatabase({ connectionString, metadataNamespace, runtimeRole });
      await admin.query(`ALTER ROLE "${runtimeRole}" LOGIN PASSWORD 'loom-test-only'`);
      await admin.query(
        `CREATE TABLE "${metadataNamespace}".counter (value integer NOT NULL, allowed boolean NOT NULL)`,
      );
      await admin.query(`INSERT INTO "${metadataNamespace}".counter VALUES (0, true)`);
      await admin.query(`GRANT SELECT, UPDATE ON "${metadataNamespace}".counter TO "${runtimeRole}"`);
      await admin.query(`CREATE TABLE "${metadataNamespace}".effects (id uuid PRIMARY KEY)`);
      await admin.query(`GRANT INSERT ON "${metadataNamespace}".effects TO "${runtimeRole}"`);
      const address = new URL(connectionString);
      address.username = runtimeRole;
      address.password = "loom-test-only";
      const schema = defineSchema(() => ({}));
      const relations = defineRelations(schema.tables);
      const connection = await connectDatabase({
        schema,
        relations,
        connectionString: address.href,
      });
      try {
        const table = sql`${sql.identifier(metadataNamespace)}.${sql.identifier("counter")}`;
        let handlerCalls = 0;
        let authorizations = 0;
        let race = false;
        let arrivals = 0;
        const barrier = Promise.withResolvers<void>();
        const insertBarrier = Promise.withResolvers<void>();
        let insertArrivals = 0;
        const { procedure } = createProjectProcedures(schema);
        const write = createDatabaseMiddleware(relations, "write", schema);
        const options = {
          connection,
          replay: { deployment: "test-deployment", metadataNamespace },
          authorize: async ({ db }: { db: typeof connection.db }) => {
            authorizations++;
            const result = await db.execute<{ allowed: boolean }>(sql`SELECT allowed FROM ${table}`);
            if (!result.rows[0]?.allowed) throw new ORPCError("FORBIDDEN");
          },
        };
        const append = bindRpcDatabaseProcedure(
          procedure.use(write).handler(async ({ context }) => {
            await context.db.execute(
              sql`INSERT INTO ${sql.identifier(metadataNamespace)}.effects VALUES (gen_random_uuid())`,
            );
            if (++insertArrivals === 2) insertBarrier.resolve();
            await insertBarrier.promise;
            return "saved";
          }),
          options,
        );
        const incrementDefinition = procedure
          .use(write)
          .input(v.object({ amount: v.number(), label: v.string(), invalid: v.optional(v.boolean()) }))
          .output(v.number())
          .handler(async ({ context, input }) => {
            handlerCalls++;
            if (race) {
              if (++arrivals === 2) barrier.resolve();
              await barrier.promise;
            }
            const result = await context.db.execute<{ value: number }>(
              sql`UPDATE ${table} SET value = value + ${input.amount} RETURNING value`,
            );
            return input.invalid ? Number.NaN : (result.rows[0]?.value ?? -1);
          });
        const increment = bindRpcDatabaseProcedure(incrementDefinition, options);
        const contextFor = (identity: InvocationIdentity | null, idempotencyKey = "one") => {
          const invocation = { identity, requestId: crypto.randomUUID(), signal: new AbortController().signal };
          return { ...invocation, idempotencyKey, "effect/context": Context.make(Invocation, invocation) };
        };
        const path = ["counter", "increment"];
        const input = { amount: 1, label: "test" };
        const identity = { issuer: "issuer", subject: "subject", tenantId: "tenant" };
        const firstContext = contextFor(identity);
        expect(await call(increment, input, { context: firstContext, path })).toBe(1);
        const replayContext = contextFor(identity);
        expect(
          await call(
            bindRpcDatabaseProcedure(incrementDefinition, options),
            { label: "test", amount: 1 },
            { context: replayContext, path },
          ),
        ).toBe(1);
        expect(replayContext.requestId).not.toBe(firstContext.requestId);
        expect(handlerCalls).toBe(1);
        expect(authorizations).toBe(2);
        await assert.rejects(call(increment, { ...input, amount: 2 }, { context: contextFor(identity), path }), {
          code: "IDEMPOTENCY_CONFLICT",
        });
        await assert.rejects(call(increment, input, { context: contextFor(identity, ""), path }), {
          code: "INVALID_IDEMPOTENCY_KEY",
        });
        await admin.query(`UPDATE "${metadataNamespace}".counter SET allowed = false`);
        await assert.rejects(call(increment, input, { context: contextFor(identity), path }), { code: "FORBIDDEN" });
        expect(handlerCalls).toBe(1);
        await admin.query(`UPDATE "${metadataNamespace}".counter SET allowed = true`);
        for (const other of [
          null,
          { ...identity, subject: "other" },
          { ...identity, issuer: "other" },
          { ...identity, tenantId: "other" },
        ]) {
          expect(await call(increment, input, { context: contextFor(other), path })).toBeGreaterThan(1);
        }
        expect(handlerCalls).toBe(5);
        const deployed = bindRpcDatabaseProcedure(incrementDefinition, {
          ...options,
          replay: { ...options.replay, deployment: "other" },
        });
        expect(await call(deployed, input, { context: contextFor(identity), path })).toBe(6);
        // Regenerating native code must not turn an existing intent into a new write.
        expect(
          await call(bindRpcDatabaseProcedure(incrementDefinition, options), input, {
            context: contextFor(identity),
            path,
          }),
        ).toBe(1);
        await assert.rejects(
          call(increment, { ...input, invalid: true }, { context: contextFor(identity, "invalid"), path }),
          { code: "INTERNAL_SERVER_ERROR" },
        );
        expect((await admin.query(`SELECT value FROM "${metadataNamespace}".counter`)).rows).toEqual([{ value: 6 }]);
        expect(
          (await admin.query(`SELECT count(*)::integer AS count FROM "${metadataNamespace}".mutation_results`)).rows,
        ).toEqual([{ count: 6 }]);
        expect(await call(increment, input, { context: contextFor(identity, "invalid"), path })).toBe(7);
        race = true;
        const results = await Promise.all([
          call(increment, input, { context: contextFor(identity, "concurrent"), path }),
          call(increment, input, { context: contextFor(identity, "concurrent"), path }),
        ]);
        race = false;
        for (const result of results) expect(result).toBe(8);
        expect(arrivals).toBe(2);
        const appended = await Promise.all([
          call(append, undefined, { context: contextFor(identity, "concurrent-inserts"), path: ["counter", "append"] }),
          call(append, undefined, { context: contextFor(identity, "concurrent-inserts"), path: ["counter", "append"] }),
        ]);
        for (const result of appended) expect(result).toBe("saved");
        expect(insertArrivals).toBe(2);
        expect(
          (await admin.query(`SELECT count(*)::integer AS count FROM "${metadataNamespace}".effects`)).rows,
        ).toEqual([{ count: 1 }]);
        expect((await admin.query(`SELECT value FROM "${metadataNamespace}".counter`)).rows).toEqual([{ value: 8 }]);
        expect(await call(increment, input, { context: contextFor(identity), path: ["counter", "other"] })).toBe(9);
        expect(mutationReplayWindowSeconds).toBe(86_400);
        await admin.query(
          `UPDATE "${metadataNamespace}".mutation_results SET expires_at = clock_timestamp() - interval '1 second'`,
        );
        const beforeExpiry = handlerCalls;
        await assert.rejects(call(increment, input, { context: contextFor(identity), path }), {
          code: "IDEMPOTENCY_EXPIRED",
        });
        expect(handlerCalls).toBe(beforeExpiry);
        expect(connection.pool.idleCount).toBe(connection.pool.totalCount);
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
