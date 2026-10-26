import assert from "node:assert/strict";
import { test, expect } from "bun:test";
import { call, os } from "@orpc/server";
import type { RouterClient } from "@orpc/server";
import { createORPCClient, RPCSerializer } from "@orpc/client";
import { RPCLink as HttpLink } from "@orpc/client/fetch";
import { RPCLink as SocketLink } from "@orpc/client/websocket";
import { RPCHandler as HttpHandler } from "@orpc/server/fetch";
import { RPCHandler as SocketHandler } from "@orpc/server/websocket";
import { Context, Effect } from "effect";
import { defineRelations, sql } from "drizzle-orm";
import pg from "pg";
import * as v from "valibot";
import { bootstrapDatabase } from "kello-cli";
import type { ProcedureContext } from "kello/server";
import { oc } from "kello/contract";
import {
  bindRpcDatabaseProcedure,
  createDatabaseMiddleware,
  createProjectProcedures,
  connectDatabase,
  defineSchema,
  Invocation,
  createProjectServices,
  defineApplication,
  createApplicationRpc,
  prepareApplicationEnvironment,
} from "kello/server";

const applicationSchema = defineSchema(() => ({}));
const applicationRelations = defineRelations(applicationSchema.tables);
const applicationContract = {
  environment: oc.errors({ UNAUTHORIZED: {} }).output(v.object({ port: v.number(), owner: v.string() })),
};
declare module "kello/contract" {
  interface ProjectRegistration {
    schema: typeof applicationSchema;
    relations: typeof applicationRelations;
    contract: typeof applicationContract;
  }
}

const connectionString = process.env.LOOM_TEST_DATABASE_URL;
test.skipIf(!connectionString)(
  "native procedures validate, rollback, replay and reauthorize inside PostgreSQL",
  async () => {
    if (!connectionString) throw new Error("Missing database URL");
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const metadataNamespace = `loom_rpc_${suffix}`;
    const runtimeRole = `loom_runtime_${suffix}`;
    const admin = new pg.Client({ connectionString });
    await admin.connect();
    try {
      await bootstrapDatabase({ connectionString, metadataNamespace, runtimeRole });
      await admin.query(`GRANT "${runtimeRole}" TO CURRENT_USER`);
      await admin.query(`ALTER ROLE "${runtimeRole}" LOGIN PASSWORD 'loom-test-only'`);
      await admin.query(
        `CREATE TABLE "${metadataNamespace}".counter (value integer NOT NULL, allowed boolean NOT NULL)`,
      );
      await admin.query(`INSERT INTO "${metadataNamespace}".counter VALUES (0, true)`);
      await admin.query(`GRANT SELECT, UPDATE ON "${metadataNamespace}".counter TO "${runtimeRole}"`);
      const address = new URL(connectionString);
      address.username = runtimeRole;
      address.password = "loom-test-only";
      const schema = defineSchema(() => ({}));
      const relations = defineRelations(schema.tables);
      const connection = await connectDatabase({ schema, relations, connectionString: address.href });
      try {
        const table = sql`${sql.identifier(metadataNamespace)}.${sql.identifier("counter")}`;
        const write = createDatabaseMiddleware(relations, "write", schema);
        const read = createDatabaseMiddleware(relations, "read", schema);
        const { procedure } = createProjectProcedures(schema);
        let authorizations = 0;
        let calls = 0;
        let inputTransforms = 0;
        const options = {
          connection,
          replay: { metadataNamespace, deployment: "native-test" },
          authorize: async ({ db }: { db: typeof connection.db }) => {
            authorizations++;
            const result = await db.execute<{ allowed: boolean }>(sql`SELECT allowed FROM ${table}`);
            if (!result.rows[0]?.allowed) throw new Error("Access revoked");
          },
        };
        const increment = bindRpcDatabaseProcedure(
          procedure
            .use(write)
            .input(
              v.pipe(
                v.string(),
                v.transform((value) => {
                  inputTransforms++;
                  return Number(value);
                }),
                v.number(),
              ),
            )
            .output(v.number())
            .handler(async ({ context, input }) => {
              calls++;
              const result = await context.db.execute<{ value: number }>(
                sql`UPDATE ${table} SET value = value + ${input} RETURNING value`,
              );
              return result.rows[0]!.value;
            }),
          options,
        );
        const invocation = {
          identity: { issuer: "test", subject: "owner" },
          requestId: "rpc-test",
          signal: new AbortController().signal,
        };
        const context = {
          ...invocation,
          idempotencyKey: "increment",
          "effect/context": Context.make(Invocation, invocation),
        };
        expect(await call(increment, "1", { context, path: ["counter", "increment"] })).toBe(1);
        expect(await call(increment, "1", { context, path: ["counter", "increment"] })).toBe(1);
        expect(calls).toBe(1);
        expect(authorizations).toBe(2);
        expect(inputTransforms).toBe(2);
        await assert.rejects(call(increment, "2", { context, path: ["counter", "increment"] }), {
          code: "IDEMPOTENCY_CONFLICT",
        });
        const beforeInvalid = authorizations;
        await assert.rejects(call(increment, "bad", { context, path: ["counter", "increment"] }), {
          code: "BAD_REQUEST",
        });
        expect(authorizations).toBe(beforeInvalid);

        const invalid = bindRpcDatabaseProcedure(
          procedure
            .output(v.pipe(v.number(), v.minValue(0)))
            .use(write)
            .handler(async ({ context }) => {
              await context.db.execute(sql`UPDATE ${table} SET value = 999`);
              return -1;
            }),
          options,
        );
        await assert.rejects(call(invalid, undefined, { context: { ...context, idempotencyKey: "invalid" } }));
        const unencodable = bindRpcDatabaseProcedure(
          procedure.use(write).handler(async ({ context }) => {
            await context.db.execute(sql`UPDATE ${table} SET value = 999`);
            return () => "not serializable";
          }),
          options,
        );
        await assert.rejects(call(unencodable, undefined, { context: { ...context, idempotencyKey: "unencodable" } }));
        expect((await admin.query(`SELECT value FROM "${metadataNamespace}".counter`)).rows).toEqual([{ value: 1 }]);
        expect(
          (await admin.query(`SELECT count(*)::int AS count FROM "${metadataNamespace}".mutation_results`)).rows,
        ).toEqual([{ count: 1 }]);

        const illegalWrite = bindRpcDatabaseProcedure(
          procedure.use(read).handler(async ({ context }) => {
            await context.db.execute(sql`UPDATE ${table} SET value = 999`);
            return "bad";
          }),
          options,
        );
        await assert.rejects(call(illegalWrite, undefined, { context }));

        let nestedCalls = 0;
        const child = bindRpcDatabaseProcedure(
          procedure.use(write).handler(async ({ context }) => {
            nestedCalls++;
            await context.db.execute(sql`UPDATE ${table} SET value = value + 1`);
            if (nestedCalls === 1)
              await context.db.execute(sql`DO $$ BEGIN RAISE EXCEPTION USING ERRCODE = '40001'; END $$`);
            return { at: new Date("2026-09-24T00:00:00Z"), count: 1n };
          }),
          options,
        );
        const parent = bindRpcDatabaseProcedure(
          procedure.use(write).handler(({ context }) => call(child, undefined, { context, path: ["nested", "child"] })),
          options,
        );
        const nestedContext = { ...context, idempotencyKey: "nested" };
        const nestedValue = await call(parent, undefined, { context: nestedContext, path: ["nested", "parent"] });
        expect(nestedCalls).toBe(2);
        expect(nestedValue).toEqual({ at: new Date("2026-09-24T00:00:00Z"), count: 1n });
        expect(await call(parent, undefined, { context: nestedContext, path: ["nested", "parent"] })).toEqual(
          nestedValue,
        );
        expect(nestedCalls).toBe(2);
        expect((await admin.query(`SELECT value FROM "${metadataNamespace}".counter`)).rows).toEqual([{ value: 2 }]);
        const { Database } = createProjectServices<typeof schema, typeof relations>();
        const effectRead = bindRpcDatabaseProcedure(
          procedure.use(read).effect(function* () {
            const db = yield* Database;
            const result = yield* Effect.tryPromise({
              try: async () => db.execute<{ value: number }>(sql`SELECT value FROM ${table}`),
              catch: (cause) => cause,
            });
            return result.rows[0]!.value;
          }),
          options,
        );
        expect(await call(effectRead, undefined, { context })).toBe(2);
        let mutableAttempts = 0;
        let mutableOutputs = 0;
        const mutableInput = bindRpcDatabaseProcedure(
          procedure
            .use(write)
            .input(v.object({ amount: v.number(), at: v.date(), tags: v.set(v.string()), url: v.instance(URL) }))
            .output(
              v.pipe(
                v.number(),
                v.transform((value) => {
                  mutableOutputs++;
                  return { value };
                }),
              ),
            )
            .handler(async ({ context, input }) => {
              mutableAttempts++;
              const amount = input.amount;
              expect(input.at.toISOString()).toBe("2026-09-24T00:00:00.000Z");
              expect([...input.tags]).toEqual(["original"]);
              expect(input.url.pathname).toBe("/original");
              input.at.setUTCFullYear(2000);
              input.tags.add("mutated");
              input.url.pathname = "/mutated";
              input.amount = 1000;
              if (mutableAttempts === 1)
                await context.db.execute(sql`DO $$ BEGIN RAISE EXCEPTION USING ERRCODE = '40001'; END $$`);
              return amount;
            }),
          options,
        );
        const originalInput = {
          amount: 2,
          at: new Date("2026-09-24"),
          tags: new Set(["original"]),
          url: new URL("https://example.test/original"),
        };
        expect(
          await call(mutableInput, originalInput, { context: { ...context, idempotencyKey: "mutable-input" } }),
        ).toEqual({ value: 2 });
        expect(originalInput).toEqual({
          amount: 2,
          at: new Date("2026-09-24"),
          tags: new Set(["original"]),
          url: new URL("https://example.test/original"),
        });
        expect(mutableOutputs).toBe(1);
        expect(mutableAttempts).toBe(2);
        const beforeAbort = authorizations;
        await assert.rejects(call(effectRead, undefined, { context, signal: AbortSignal.abort() }));
        expect(authorizations).toBe(beforeAbort);
        const duringAuthorization = new AbortController();
        let cancelledHandlerCalls = 0;
        const cancelledDuringAuthorization = bindRpcDatabaseProcedure(
          procedure.use(write).handler(() => {
            cancelledHandlerCalls++;
            return null;
          }),
          {
            ...options,
            authorize: async () => {
              duringAuthorization.abort();
            },
          },
        );
        await assert.rejects(
          call(cancelledDuringAuthorization, undefined, {
            context: { ...context, signal: duringAuthorization.signal, idempotencyKey: "cancelled-authorization" },
          }),
        );
        expect(cancelledHandlerCalls).toBe(0);
        let routerMiddlewareCalls = 0;
        const routed = os
          .$context<ProcedureContext>()
          .use(({ next }) => {
            routerMiddlewareCalls++;
            return next();
          })
          .router({
            read: procedure.use(read).handler(() => "routed"),
          });
        expect(await call(bindRpcDatabaseProcedure(routed.read, options), undefined, { context })).toBe("routed");
        expect(routerMiddlewareCalls).toBe(1);
        const router = { nested: { parent } };
        const serializer = new RPCSerializer({ omitUndefinedProperties: false });
        const http = new HttpHandler(router, { serializer });
        const sockets = new SocketHandler(router, { serializer });
        const server = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          async fetch(request, server) {
            if (new URL(request.url).pathname === "/ws" && server.upgrade(request)) return;
            const result = await http.handle(request, { context: nestedContext });
            return result.response ?? new Response("Not found", { status: 404 });
          },
          websocket: {
            async message(socket, message) {
              await sockets.message(socket, message, { context: nestedContext });
            },
            async close(socket) {
              await sockets.close(socket);
            },
          },
        });
        const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
        try {
          const httpClient = createORPCClient<RouterClient<typeof router>>(
            new HttpLink({ origin: server.url.origin, serializer }),
          );
          const socketClient = createORPCClient<RouterClient<typeof router>>(
            new SocketLink({ connect: () => socket, serializer }),
          );
          expect(await httpClient.nested.parent()).toEqual(nestedValue);
          expect(await socketClient.nested.parent()).toEqual(nestedValue);
          expect(nestedCalls).toBe(2);
        } finally {
          socket.close();
          await server.stop(true);
        }
        const readonlyParent = bindRpcDatabaseProcedure(
          procedure.use(read).handler(({ context }) => call(child, undefined, { context })),
          options,
        );
        await assert.rejects(call(readonlyParent, undefined, { context }));
        const invalidChild = bindRpcDatabaseProcedure(
          procedure
            .use(write)
            .output(v.pipe(v.number(), v.minValue(0)))
            .handler(async ({ context }) => {
              await context.db.execute(sql`UPDATE ${table} SET value = 999`);
              return -1;
            }),
          options,
        );
        const catchesFailure = bindRpcDatabaseProcedure(
          procedure.use(write).handler(async ({ context }) => {
            try {
              await call(invalidChild, undefined, { context });
            } catch {
              return "caught";
            }
            return "unexpected";
          }),
          options,
        );
        await assert.rejects(call(catchesFailure, undefined, { context: { ...context, idempotencyKey: "caught" } }));
        expect((await admin.query(`SELECT value FROM "${metadataNamespace}".counter`)).rows).toEqual([{ value: 2 }]);
        await admin.query(`UPDATE "${metadataNamespace}".counter SET allowed = false`);
        await assert.rejects(call(increment, "1", { context, path: ["counter", "increment"] }));
        expect(calls).toBe(1);
        await admin.query(`UPDATE "${metadataNamespace}".counter SET allowed = true`);
        await admin.query(
          `UPDATE "${metadataNamespace}".mutation_results SET result = '{"protocol":"old","payload":null}'::jsonb`,
        );
        await assert.rejects(call(increment, "1", { context, path: ["counter", "increment"] }), {
          code: "RPC_VERSION_MISMATCH",
        });
        expect(calls).toBe(1);
        const automatic = createDatabaseMiddleware(relations, "automatic", schema);
        let protectedHandlerCalls = 0;
        const protectedAutomatic = bindRpcDatabaseProcedure(
          procedure.use(automatic).handler(() => {
            protectedHandlerCalls++;
            return "external effect";
          }),
          {
            ...options,
            authorize: async ({ databasePolicy }) => {
              if (databasePolicy !== "read") throw new Error("Write permission required");
            },
          },
        );
        await assert.rejects(call(protectedAutomatic, undefined, { context: { ...context, operation: "query" } }));
        expect(protectedHandlerCalls).toBe(0);
        const inspectAutomatic = bindRpcDatabaseProcedure(
          procedure.use(automatic).handler(async ({ context }) => {
            const result = await context.db.execute<{ readonly: string; isolation: string }>(
              sql`SELECT current_setting('transaction_read_only') AS readonly, current_setting('transaction_isolation') AS isolation`,
            );
            return result.rows[0];
          }),
          {
            ...options,
            authorize: async (authorization) => {
              expect(authorization.databasePolicy).toBe("automatic");
              await options.authorize(authorization);
            },
          },
        );
        for (const operation of ["query", "live", "streamed", "infinite"] as const) {
          expect(await call(inspectAutomatic, undefined, { context: { ...context, operation } })).toEqual({
            readonly: "on",
            isolation: "repeatable read",
          });
        }
        for (const operation of ["mutation", "call", undefined] as const) {
          const automaticContext = { ...context, idempotencyKey: crypto.randomUUID() };
          expect(
            await call(inspectAutomatic, undefined, {
              context: operation ? { ...automaticContext, operation } : automaticContext,
            }),
          ).toEqual({
            readonly: "off",
            isolation: "serializable",
          });
        }
        const directContext = { ...invocation, "effect/context": Context.make(Invocation, invocation) };
        expect(await call(inspectAutomatic, undefined, { context: directContext })).toEqual({
          readonly: "off",
          isolation: "serializable",
        });
        const automaticWrite = bindRpcDatabaseProcedure(
          procedure.use(automatic).handler(async ({ context }) => {
            await context.db.execute(sql`UPDATE ${table} SET value = value`);
            return "written";
          }),
          options,
        );
        await assert.rejects(call(automaticWrite, undefined, { context: { ...context, operation: "query" } }));
        expect(
          await call(automaticWrite, undefined, {
            context: { ...context, operation: "mutation", idempotencyKey: crypto.randomUUID() },
          }),
        ).toBe("written");
        let automaticAttempts = 0;
        const conflict = bindRpcDatabaseProcedure(
          procedure.use(automatic).handler(async ({ context }) => {
            automaticAttempts++;
            await context.db.execute(sql`DO $$ BEGIN RAISE EXCEPTION 'retry test' USING ERRCODE = '40001'; END $$`);
            return "unreachable";
          }),
          options,
        );
        await assert.rejects(
          call(conflict, undefined, {
            context: { ...context, operation: "mutation", idempotencyKey: crypto.randomUUID() },
          }),
          { code: "CONFLICT" },
        );
        expect(automaticAttempts).toBe(1);
        const app = defineApplication({
          env: { PORT: v.pipe(v.string(), v.transform(Number)) },
          rpc: ({ os }) => ({
            auth: os.use(({ context, next, errors }) => {
              if (!context.identity) throw errors.UNAUTHORIZED();
              return next({ context: { user: { id: context.identity.subject } } });
            }),
          }),
        });
        const { auth } = createApplicationRpc(app, { schema, relations, contract: applicationContract });
        const environmentProcedure = bindRpcDatabaseProcedure(
          auth.environment.handler(async ({ context }) => {
            await context.db.execute(sql`SELECT pg_sleep(0.01)`);
            return { port: context.env.PORT, owner: context.user.id };
          }),
          options,
        );
        const firstEnvironment = await prepareApplicationEnvironment(app, { PORT: "3000" });
        const secondEnvironment = await prepareApplicationEnvironment(app, { PORT: "4000" });
        const request = () => call(environmentProcedure, undefined, { context: { ...context, operation: "query" } });
        expect(
          await Promise.all([
            firstEnvironment.run(request),
            secondEnvironment.run(request),
            firstEnvironment.run(request),
          ]),
        ).toEqual([
          { port: 3000, owner: "owner" },
          { port: 4000, owner: "owner" },
          { port: 3000, owner: "owner" },
        ]);
        await assert.rejects(request());
        const otherApp = defineApplication({ env: { PORT: v.string() }, rpc: ({ os }) => ({ os }) });
        const otherEnvironment = await prepareApplicationEnvironment(otherApp, { PORT: "5000" });
        await assert.rejects(otherEnvironment.run(request));
        await assert.rejects(prepareApplicationEnvironment(app, {}));
        const retryableParent = bindRpcDatabaseProcedure(
          procedure.use(write).handler(({ context }) => call(conflict, undefined, { context })),
          options,
        );
        await assert.rejects(
          call(retryableParent, undefined, { context: { ...context, idempotencyKey: crypto.randomUUID() } }),
        );
        expect(automaticAttempts).toBe(1);
      } finally {
        await connection.close();
      }
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS "${metadataNamespace}" CASCADE`);
      await admin.query(`DROP OWNED BY "${runtimeRole}"`);
      await admin.query(`DROP ROLE IF EXISTS "${runtimeRole}"`);
      await admin.end();
    }
  },
);
