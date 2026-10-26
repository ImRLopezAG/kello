import { startHttpHandlerServer } from "../fixtures/http-handler-server";
import assert from "node:assert/strict";
import { channel } from "node:diagnostics_channel";
import { expect, test } from "bun:test";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { oc, eventIterator } from "kello/contract";
import type { RouterClient } from "@orpc/server";
import { defineRelations, sql } from "drizzle-orm";
import pg from "pg";
import * as v from "valibot";
import { bootstrapDatabase } from "kello-cli";
import { createRpcHttpApp, createNeonRpcService, createNeonRpcWorker } from "kello/neon";
import type { RpcRuntimeOptions } from "kello/server";
import {
  createRpcRuntime,
  defineRpcAuth,
  defineSchema,
  createProjectProcedures,
  createDatabaseMiddleware,
  procedureCron,
  defineApplication,
  createApplicationRpc,
} from "kello/server";

const connectionString = process.env.LOOM_TEST_DATABASE_URL;
test.skipIf(!connectionString)(
  "assembled native runtime owns HTTP calls, internal jobs, activation and shutdown",
  async () => {
    if (!connectionString) throw new Error("Missing database URL");
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const metadataNamespace = `loom_rpc_runtime_${suffix}`;
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
      const application = defineApplication({
        env: { PORT: v.pipe(v.string(), v.transform(Number)) },
        rpc: ({ os }) => ({ os }),
      });
      const { os } = createApplicationRpc(application, {
        schema,
        relations,
        contract: {
          environment: oc.errors({ UNAUTHORIZED: {} }).output(v.object({ port: v.number(), owner: v.string() })),
        },
      });
      const environmentProcedure = os.environment.handler(({ context }) => ({
        port: context.env.PORT,
        owner: context.identity?.subject ?? "anonymous",
      }));
      const { procedure } = createProjectProcedures(schema);
      const table = sql`${sql.identifier(metadataNamespace)}.${sql.identifier("counter")}`;
      const jobStarted = Promise.withResolvers<void>();
      const jobResume = Promise.withResolvers<void>();
      let holdJob = true;
      const increment = procedure
        .use(createDatabaseMiddleware(relations, "write", schema))
        .input(v.number())
        .output(v.number())
        .handler(async ({ context, input }) => {
          if (holdJob) {
            jobStarted.resolve();
            await jobResume.promise;
          }
          const result = await context.db.execute<{ value: number }>(
            sql`UPDATE ${table} SET value = value + ${input} RETURNING value`,
          );
          return result.rows[0]!.value;
        });
      const enqueue = procedure
        .use(createDatabaseMiddleware(relations, "write", schema))
        .handler(({ context }) => context.scheduler.runAfter(0, increment, 4, { maxAttempts: 2 }));
      const read = procedure
        .use(createDatabaseMiddleware(relations, "read", schema))

        .output(v.number())
        .handler(
          async ({ context }) =>
            (await context.db.execute<{ value: number }>(sql`SELECT value FROM ${table}`)).rows[0]!.value,
        );
      const oversized = procedure
        .use(createDatabaseMiddleware(relations, "write", schema))
        .handler(async ({ context }) => {
          await context.db.execute(sql`UPDATE ${table} SET value = value + 100`);
          return "x".repeat(2048);
        });
      let conflictAttempts = 0;
      const conflict = procedure
        .use(createDatabaseMiddleware(relations, "automatic", schema))
        .handler(async ({ context }) => {
          conflictAttempts++;
          await context.db.execute(
            sql`DO $$ BEGIN RAISE EXCEPTION 'private conflict detail' USING ERRCODE = '40001'; END $$`,
          );
          return null;
        });
      const stream = procedure
        .use(createDatabaseMiddleware(relations, "automatic", schema))
        .output(eventIterator(v.number()))
        .handler(async ({ context }) => {
          const authority = await context.db.execute<{ transaction_read_only: string }>(
            sql`SHOW transaction_read_only`,
          );
          expect(authority.rows[0]?.transaction_read_only).toBe("on");
          const result = await context.db.execute<{ value: number }>(sql`SELECT value FROM ${table}`);
          const value = result.rows[0]!.value;
          return (async function* () {
            yield value;
            yield value + 1;
          })();
        });
      let streamCleaned = false;
      const waitingStream = procedure
        .use(createDatabaseMiddleware(relations, "automatic", schema))
        .output(eventIterator(v.string()))
        .handler(async function* ({ context }) {
          try {
            yield "ready";
            if (!context.signal.aborted)
              await new Promise<void>((resolve) =>
                context.signal.addEventListener("abort", () => resolve(), { once: true }),
              );
          } finally {
            streamCleaned = true;
          }
        });
      let active = true;
      const authorized: string[] = [];
      const version = "c".repeat(64);
      const runtimeOptions = {
        application,
        environment: { PORT: "3000" },
        schema,
        relations,
        connectionString: address.href,
        metadataNamespace,
        deployment: "assembled",
        config: {
          auth: { origins: ["https://kello.test"] },
          jobs: { maxAttempts: 2, retryBaseMs: 7000, leaseMs: 5000 },
          rpc: { maxResultBytes: 1024 },
        },
        version,
        procedures: [
          { path: ["conflict"], visibility: "public", procedure: conflict },
          { path: ["waitingStream"], visibility: "public", procedure: waitingStream },
          { path: ["stream"], visibility: "public", procedure: stream },
          { path: ["environment"], visibility: "public", procedure: environmentProcedure },
          { path: ["enqueue"], visibility: "public", procedure: enqueue },
          { path: ["oversized"], visibility: "public", procedure: oversized },
          { path: ["read"], visibility: "public", procedure: read },
          { path: ["toString", "read"], visibility: "public", procedure: read },
          { path: ["increment"], visibility: "internal", procedure: increment },
        ],
        crons: { increment: procedureCron("* * * * *", increment, 2) },
        auth: defineRpcAuth({
          allowAnonymous: true,
          authorize: async (context) => {
            assert.ok(context.db);
            assert.ok(context.databasePolicy);
            authorized.push(context.path.join("."));
          },
        }),
        assertActive: async () => {
          if (!active) throw new Error("retired");
        },
      } satisfies RpcRuntimeOptions<typeof relations>;
      active = false;
      await assert.rejects(
        createRpcRuntime({
          ...runtimeOptions,
          environment: {},
          connectionString: "postgres://localhost:1/unreachable",
        }),
        /Invalid application environment variable: PORT/,
      );
      await assert.rejects(
        createRpcRuntime({ ...runtimeOptions, connectionString: "postgres://localhost:1/unreachable" }),
        /activation/i,
      );
      active = true;
      await assert.rejects(
        createRpcRuntime({ ...runtimeOptions, crons: { "invalid name": procedureCron("* * * * *", increment, 1) } }),
      );
      await assert.rejects(
        createNeonRpcWorker({ ...runtimeOptions, bindings: { "": { kind: "wake", name: "worker" } } }),
      );
      const runtime = await createRpcRuntime(runtimeOptions);
      try {
        let app = createRpcHttpApp({ ...runtime.auth, router: runtime.router, version });
        const client = createORPCClient<
          RouterClient<{
            conflict: typeof conflict;
            environment: typeof environmentProcedure;
            enqueue: typeof enqueue;
            read: typeof read;
            oversized: typeof oversized;
            stream: typeof stream;
            waitingStream: typeof waitingStream;
          }>
        >(
          new RPCLink({
            origin: "https://kello.test",
            url: "/api/kello/rpc",
            headers: { "x-loom-protocol": "loom-orpc-2", "x-loom-version": version, "idempotency-key": "enqueue" },
            fetch: (url, init) => app.fetch(new Request(url, init)),
          }),
        );
        expect(await client.environment()).toEqual({ port: 3000, owner: "anonymous" });
        const id = await client.enqueue();
        expect(id).toMatch(/^[a-f0-9-]{36}$/);
        expect(await client.enqueue()).toBe(id);
        expect(
          (
            await admin.query(`SELECT max_attempts, retry_delay_seconds FROM "${metadataNamespace}".jobs WHERE id=$1`, [
              id,
            ])
          ).rows[0],
        ).toMatchObject({ max_attempts: 2, retry_delay_seconds: 7 });
        const work = runtime.worker.run();
        await jobStarted.promise;
        try {
          const lease = await admin.query(
            `SELECT extract(epoch FROM lease_expires_at-clock_timestamp())::float8 AS seconds FROM "${metadataNamespace}".jobs WHERE id=$1`,
            [id],
          );
          expect(lease.rows[0]?.seconds).toBeLessThanOrEqual(5);
        } finally {
          holdJob = false;
          jobResume.resolve();
        }
        expect(await work).toMatchObject({ claimed: 1, completed: 1 });
        expect(await client.read()).toBe(4);
        expect(authorized).toEqual(["environment", "enqueue", "enqueue", "increment", "read"]);
        await assert.rejects(client.conflict(), { code: "CONFLICT", message: "Transaction conflict" });
        expect(conflictAttempts).toBe(1);
        const values = await client.stream();
        expect(await values.next()).toEqual({ done: false, value: 4 });
        expect(await values.next()).toEqual({ done: false, value: 5 });
        expect(await values.next()).toEqual({ done: true, value: undefined });
        const metrics = channel("kello.runtime.metric");
        const failures = channel("kello.procedure.failure");
        const events: unknown[] = [];
        const errors: unknown[] = [];
        const collect: Parameters<typeof metrics.subscribe>[0] = (event) => {
          if (v.parse(v.object({ type: v.string() }), event).type === "rpc.procedure") events.push(event);
        };
        const collectError: Parameters<typeof failures.subscribe>[0] = (event) => {
          errors.push(event);
        };
        metrics.subscribe(collect);
        failures.subscribe(collectError);
        try {
          await assert.rejects(client.oversized());
          expect(events).toHaveLength(1);
          expect(errors).toHaveLength(1);
          expect(errors[0]).toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
        } finally {
          metrics.unsubscribe(collect);
          failures.unsubscribe(collectError);
        }
        expect(await client.read()).toBe(4);
        expect("increment" in runtime.router).toBe(false);
        expect(Object.getPrototypeOf(runtime.router["toString"])).toBeNull();
        expect(Object.getPrototypeOf(runtime.router)).toBeNull();
        await runtime.crons.dispatch("increment", new Date(0));
        expect(await runtime.worker.run()).toMatchObject({ completed: 1 });
        expect(await client.read()).toBe(6);
        active = false;
        await assert.rejects(client.read());
        await assert.rejects(runtime.worker.run(), /ACTIVATION_DENIED/);
        active = true;
        const waiting = await client.waitingStream();
        expect(await waiting.next()).toEqual({ done: false, value: "ready" });
        expect(streamCleaned).toBe(false);
        const stopping = runtime.stop();
        expect(runtime.stop()).toBe(stopping);
        await stopping;
        expect(streamCleaned).toBe(true);
        await assert.rejects(client.read());
        await assert.rejects(runtime.worker.run(), /stopped/);
        const service = await createNeonRpcService(runtimeOptions);
        try {
          app = service;
          expect(await client.read()).toBe(6);
          expect((await service.fetch(new Request("https://kello.test/api/kello/triggers"))).status).toBe(404);
        } finally {
          const stopping = service.stop();
          expect(service.stop()).toBe(stopping);
          await stopping;
          expect((await service.fetch(new Request("https://kello.test/api/kello/rpc/read"))).status).toBe(503);
        }
        await assert.rejects(
          createRpcRuntime({ ...runtimeOptions, config: { ...runtimeOptions.config, openapi: true } }),
          /explicit output schema required/,
        );
        const restOptions = {
          ...runtimeOptions,
          config: { ...runtimeOptions.config, openapi: true },
          procedures: [
            { path: ["read"], visibility: "public", procedure: read },
            { path: ["increment"], visibility: "internal", procedure: increment },
          ],
        } satisfies RpcRuntimeOptions<typeof relations>;
        const restService = await createNeonRpcService(restOptions);
        const restDevelopment = await startHttpHandlerServer(await createRpcRuntime(restOptions));
        try {
          const headers = { "x-loom-protocol": "loom-orpc-2", "x-loom-version": version };
          for (const fetchRest of [
            (path: string, supplied: HeadersInit = headers) =>
              restService.fetch(
                new Request(`https://kello.test/api/kello/openapi/${path}`, { method: "POST", headers: supplied }),
              ),
            (path: string, supplied: HeadersInit = headers) =>
              fetch(new URL(`/api/kello/openapi/${path}`, restDevelopment.url), { method: "POST", headers: supplied }),
          ]) {
            const response = await fetchRest("read");
            expect(response.status).toBe(200);
            expect(await response.json()).toBe(6);
            expect((await fetchRest("increment")).status).toBe(404);
            expect((await fetchRest("read", { ...headers, authorization: "invalid" })).status).toBe(401);
            expect((await fetchRest("read", { ...headers, "x-loom-version": "0".repeat(64) })).status).toBe(409);
          }
        } finally {
          await restService.stop();
          await restDevelopment.stop();
        }
        const worker = await createNeonRpcWorker({
          ...runtimeOptions,
          bindings: { timer: { kind: "cron", name: "increment", cron: "increment" } },
        });
        try {
          expect((await worker.fetch(new Request("https://kello.test/api/kello/rpc/read"))).status).toBe(404);
          const request = () =>
            new Request("https://kello.test/api/kello/triggers", {
              method: "POST",
              headers: { "content-type": "application/json", "x-neon-trigger-invocation-id": "native-entry" },
              body: JSON.stringify({
                version: 1,
                invocation_id: "native-entry",
                trigger: { type: "schedule", id: "timer", name: "increment" },
                data: { scheduled_at: "2026-01-01T00:00:00Z" },
              }),
            });
          expect(
            (await worker.fetch(new Request("https://kello.test/api/kello/triggers", { method: "POST" }))).status,
          ).toBe(403);
          expect((await worker.fetch(request())).status).toBe(200);
          expect((await worker.fetch(request())).status).toBe(200);
          expect((await admin.query(`SELECT value FROM "${metadataNamespace}".counter`)).rows).toEqual([{ value: 8 }]);
          const reading = Promise.withResolvers<void>();
          const body = new ReadableStream<Uint8Array>(
            {
              pull() {
                reading.resolve();
              },
            },
            { highWaterMark: 0 },
          );
          const pending = worker.fetch(
            new Request("https://kello.test/api/kello/triggers", { method: "POST", headers: request().headers, body }),
          );
          await reading.promise;
          const stopping = worker.stop();
          expect(worker.stop()).toBe(stopping);
          expect((await pending).status).toBe(499);
          await stopping;
          expect((await worker.fetch(new Request("https://kello.test"))).status).toBe(503);
        } finally {
          await worker.stop();
        }
      } finally {
        jobResume.resolve();
        await runtime.stop();
      }
      const drainedAt = Date.now() + 2000;
      let connections = 0;
      do {
        connections = (
          await admin.query<{ count: number }>("SELECT count(*)::int AS count FROM pg_stat_activity WHERE usename=$1", [
            runtimeRole,
          ])
        ).rows[0]!.count;
        if (!connections) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      } while (Date.now() < drainedAt);
      expect(connections).toBe(0);
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS "${metadataNamespace}" CASCADE`);
      await admin.query(`DROP ROLE IF EXISTS "${runtimeRole}"`);
      await admin.end();
    }
  },
);
