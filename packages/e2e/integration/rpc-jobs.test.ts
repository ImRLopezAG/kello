import assert from "node:assert/strict";
import { expect, test } from "bun:test";
import { call } from "@orpc/server";
import { Context } from "effect";
import { defineRelations, sql } from "drizzle-orm";
import pg from "pg";
import * as v from "valibot";
import type { RpcScheduler } from "kello/server";
import { bootstrapDatabase } from "kello-cli";
import {
  defineSchema,
  connectDatabase,
  createProjectProcedures,
  createDatabaseMiddleware,
  bindRpcDatabaseProcedure,
  createRpcJobQueue,
  createRpcJobWorker,
  createTransactionalRpcScheduler,
  encodeRpcJobCall,
  decodeRpcJobInput,
  Invocation,
} from "kello/server";

const connectionString = process.env.LOOM_TEST_DATABASE_URL;
test.skipIf(!connectionString)(
  "native jobs validate, roll back, preserve rich inputs and replay after lost acknowledgement",
  async () => {
    if (!connectionString) throw new Error("Missing database URL");
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const metadataNamespace = `loom_rpc_jobs_${suffix}`;
    const runtimeRole = `loom_runtime_${suffix}`;
    const admin = new pg.Client({ connectionString });
    await admin.connect();
    try {
      await bootstrapDatabase({ connectionString, metadataNamespace, runtimeRole });
      await admin.query(`ALTER ROLE "${runtimeRole}" LOGIN PASSWORD 'loom-test-only'`);
      await admin.query(`CREATE TABLE "${metadataNamespace}".counter (value integer NOT NULL)`);
      await admin.query(`INSERT INTO "${metadataNamespace}".counter VALUES (0)`);
      await admin.query(`GRANT SELECT, UPDATE ON "${metadataNamespace}".counter TO "${runtimeRole}"`);
      const address = new URL(connectionString);
      address.username = runtimeRole;
      address.password = "loom-test-only";
      const schema = defineSchema(() => ({}));
      const relations = defineRelations(schema.tables);
      const connection = await connectDatabase({ schema, relations, connectionString: address.href });
      try {
        const version = "a".repeat(64);
        const replay = { metadataNamespace, deployment: "native-jobs" };
        const table = sql`${sql.identifier(metadataNamespace)}.${sql.identifier("counter")}`;
        const { procedure } = createProjectProcedures(schema);
        const write = createDatabaseMiddleware(relations, "write", schema);
        let executions = 0;
        let authorizations = 0;
        const options = {
          connection,
          replay,
          authorize: async () => {
            authorizations++;
          },
        };
        const task = procedure
          .use(write)
          .input(v.strictObject({ at: v.date(), amount: v.bigint() }))
          .handler(async ({ context, input }) => {
            expect(context.identity?.subject).toBe("owner");
            expect(context.job?.id).toBeDefined();
            executions++;
            await context.db.execute(sql`UPDATE ${table} SET value = value + ${Number(input.amount)}`);
            return { at: input.at, amount: input.amount };
          });
        const internal = [{ path: ["counter", "increment"], procedure: task }];
        const queue = createRpcJobQueue({ ...replay, version, db: connection.db, internal });
        const scheduler = createTransactionalRpcScheduler({ version, internal, queue });
        const input = { at: new Date("2026-01-01T00:00:00Z"), amount: 3n };
        const invocation = {
          identity: { issuer: "test", subject: "owner" },
          requestId: "enqueue",
          signal: new AbortController().signal,
        };
        const context = {
          ...invocation,
          idempotencyKey: "enqueue",
          "effect/context": Context.make(Invocation, invocation),
        };
        let escaped: RpcScheduler | undefined;
        const enqueue = bindRpcDatabaseProcedure(
          procedure.use(write).handler(({ context }) => {
            escaped = context.scheduler;
            return context.scheduler.runAt(new Date(0), task, input, { deduplicationKey: "one", maxAttempts: 2 });
          }),
          { ...options, scheduler },
        );
        const id = await call(enqueue, undefined, { context, path: ["enqueue"] });
        expect(executions).toBe(0);
        expect(() => escaped?.runAfter(0, task, input)).toThrow("RPC invocation is inactive");
        expect(await call(enqueue, undefined, { context, path: ["enqueue"] })).toBe(id);
        const claim = await queue.claim("lost-worker", 1);
        expect(claim?.id).toBe(id);
        expect(claim && decodeRpcJobInput(claim.call)).toEqual(input);
        const bound = bindRpcDatabaseProcedure(task, options);
        const boundInternal = [{ path: internal[0]!.path, procedure: bound }];
        // Drop the acknowledgement after the write commits, leaving recovery to a new lease.
        const lost = createRpcJobWorker({
          queue: {
            ...queue,
            claim: async () => claim,
            complete: async () => {
              throw new Error("connection lost");
            },
          },
          internal: boundInternal,
          assertActive: async () => {},
          leaseSeconds: 1,
        });
        await assert.rejects(lost.run(1));
        await lost.stop();
        expect(executions).toBe(1);
        await admin.query(
          `UPDATE "${metadataNamespace}".jobs SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1`,
          [id],
        );
        const recovered = createRpcJobWorker({
          queue,
          internal: boundInternal,
          assertActive: async () => {},
          leaseSeconds: 1,
        });
        expect(await recovered.run(1)).toEqual({ claimed: 1, completed: 1, failed: 0, leaseLost: 0 });
        expect(executions).toBe(1);
        expect(await queue.inspect(id)).toMatchObject({ state: "succeeded", attempts: 2 });
        if (!claim) throw new Error("Missing claim");
        expect(await queue.complete(claim, null)).toBe(false);
        expect((await admin.query(`SELECT value FROM "${metadataNamespace}".counter`)).rows).toEqual([{ value: 3 }]);
        expect(authorizations).toBe(4);
        await recovered.stop();

        const outsider = procedure.handler(() => null);
        const poisoned = bindRpcDatabaseProcedure(
          procedure.use(write).handler(async ({ context }) => {
            await context.db.execute(sql`UPDATE ${table} SET value = 99`);
            await context.scheduler.runAfter(0, outsider, undefined).catch(() => undefined);
            return null;
          }),
          { ...options, scheduler },
        );
        await assert.rejects(
          call(poisoned, undefined, { context: { ...context, idempotencyKey: "poisoned" }, path: ["poisoned"] }),
        );
        expect((await admin.query(`SELECT value FROM "${metadataNamespace}".counter`)).rows).toEqual([{ value: 3 }]);
        const beforeInvalidOutput = (
          await admin.query(`SELECT count(*)::integer AS count FROM "${metadataNamespace}".mutation_results`)
        ).rows;
        const invalidOutput = bindRpcDatabaseProcedure(
          procedure
            .use(write)
            .output(v.pipe(v.number(), v.maxValue(0)))
            .handler(async ({ context }) => {
              await context.db.execute(sql`UPDATE ${table} SET value = 99`);
              void context.scheduler.runAfter(0, task, input, { deduplicationKey: "rolled-back" });
              return 1;
            }),
          { ...options, scheduler },
        );
        await assert.rejects(
          call(invalidOutput, undefined, {
            context: { ...context, idempotencyKey: "invalid-output" },
            path: ["invalidOutput"],
          }),
        );
        expect((await admin.query(`SELECT value FROM "${metadataNamespace}".counter`)).rows).toEqual([{ value: 3 }]);
        expect(
          (await admin.query(`SELECT count(*)::integer AS count FROM "${metadataNamespace}".mutation_results`)).rows,
        ).toEqual(beforeInvalidOutput);
        const invalid = encodeRpcJobCall(version, internal[0]!.path, { at: "invalid", amount: 3n });
        await assert.rejects(
          queue.enqueue(connection.db, invalid, invocation.identity, {
            dueAt: new Date(0),
            deduplicationKey: "invalid",
          }),
        );
        expect((await admin.query(`SELECT count(*)::integer AS count FROM "${metadataNamespace}".jobs`)).rows).toEqual([
          { count: 1 },
        ]);
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
