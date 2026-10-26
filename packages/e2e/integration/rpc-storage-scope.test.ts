import assert from "node:assert/strict";
import { test } from "bun:test";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { Effect } from "effect";
import { defineRelations, sql } from "drizzle-orm";
import pg from "pg";
import * as v from "valibot";
import { bootstrapDatabase } from "kello-cli";
import { createRpcHttpApp } from "kello/neon";
import {
  createRpcRuntime,
  createProjectProcedures,
  createDatabaseMiddleware,
  defineSchema,
  defineRpcAuth,
  defineProcedureStorage,
  Storage,
  storageUploadValidator,
} from "kello/server";
import type { InvocationStorage } from "kello/server";
import { storageProviderFixture } from "../fixtures/storage-provider";

const connectionString = process.env.LOOM_TEST_DATABASE_URL;
test.skipIf(!connectionString)(
  "native storage services bind identity and drain invocation work",
  async () => {
    assert(connectionString);
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const metadataNamespace = `loom_storage_${suffix}`;
    const runtimeRole = `runtime_${suffix}`;
    const admin = new pg.Client({ connectionString });
    const provider = storageProviderFixture();
    let runtime: Awaited<ReturnType<typeof createRpcRuntime>> | undefined;
    let release = Promise.withResolvers<void>();
    let entered = Promise.withResolvers<void>();
    const cancelled = Promise.withResolvers<void>();
    let block = false;
    await admin.connect();
    try {
      await bootstrapDatabase({ connectionString, metadataNamespace, runtimeRole });
      await admin.query(`ALTER ROLE "${runtimeRole}" LOGIN PASSWORD 'loom-test-only'`);
      await admin.query(`CREATE TABLE "${metadataNamespace}".scope_counter(value integer NOT NULL)`);
      await admin.query(`INSERT INTO "${metadataNamespace}".scope_counter VALUES (0)`);
      await admin.query(`GRANT SELECT, UPDATE ON "${metadataNamespace}".scope_counter TO "${runtimeRole}"`);
      const address = new URL(connectionString);
      address.username = runtimeRole;
      address.password = "loom-test-only";
      const schema = defineSchema(() => ({}));
      const relations = defineRelations(schema.tables);
      const { procedure } = createProjectProcedures(schema);
      let escaped: InvocationStorage | undefined;
      const create = procedure.input(v.object({ upload: storageUploadValidator, key: v.string() })).effect(function* ({
        input,
      }) {
        const storage = yield* Storage;
        escaped = storage;
        return yield* Effect.promise(() => storage.create(input.upload, input.key));
      });
      const status = procedure.input(v.string()).handler(({ context, input }) => context.storage.status(input));
      const effectStatus = procedure.input(v.string()).effect(function* ({ input }) {
        const storage = yield* Storage;
        return yield* Effect.tryPromise({ try: () => storage.status(input), catch: (cause) => cause });
      });
      const unawaited = procedure.input(v.string()).handler(({ context, input }) => {
        void context.storage.status(input);
        return "drained";
      });
      const read = procedure
        .use(createDatabaseMiddleware(relations, "read", schema))
        .input(v.string())
        .handler(({ context, input }) => context.storage.status(input));
      const write = procedure
        .use(createDatabaseMiddleware(relations, "write", schema))
        .input(v.string())
        .effect(function* ({ input }) {
          const storage = yield* Storage;
          return yield* Effect.promise(() => storage.status(input));
        });
      const caught = procedure
        .use(createDatabaseMiddleware(relations, "write", schema))
        .input(v.string())
        .handler(async ({ context, input }) => {
          await context.storage.status(input).catch(() => undefined);
          await context.db.execute(sql`UPDATE ${sql.identifier(metadataNamespace)}.scope_counter SET value=1`);
          return "must roll back";
        });
      const automatic = procedure
        .use(createDatabaseMiddleware(relations, "automatic", schema))
        .input(v.string())
        .handler(({ context, input }) => context.storage.status(input));
      const automaticCaught = procedure
        .use(createDatabaseMiddleware(relations, "automatic", schema))
        .input(v.string())
        .handler(async ({ context, input }) => {
          await context.storage.status(input).catch(() => undefined);
          await context.db.execute(sql`UPDATE ${sql.identifier(metadataNamespace)}.scope_counter SET value=2`);
          return "must roll back";
        });
      const router = { create, status, effectStatus, unawaited, read, write, caught, automatic, automaticCaught };
      const version = "9".repeat(64);
      runtime = await createRpcRuntime({
        schema,
        relations,
        connectionString: address.href,
        deployment: "scope",
        version,
        metadataNamespace,
        procedures: Object.entries(router).map(([name, procedure]) => ({
          path: [name],
          visibility: "public",
          procedure,
        })),
        auth: defineRpcAuth({ authorize: async () => {} }),
        assertActive: async () => {},
        storage: defineProcedureStorage({
          buckets: { uploads: {} },
          authorize: async ({ identity, signal }) => {
            assert.equal(identity.subject, "alice");
            if (block) {
              entered.resolve();
              signal.addEventListener("abort", () => cancelled.resolve(), { once: true });
              await release.promise;
              signal.throwIfAborted();
            }
          },
        }),
        storageBackend: { projectId: "project", branchId: "br-preview", connect: provider.connect },
      });
      let subject = "alice";
      let operation = "call";
      const app = createRpcHttpApp({
        ...runtime.auth,
        router: runtime.router,
        version,
        verify: async () => ({ identity: { issuer: "scope-test", subject }, expiresAt: Date.now() / 1000 + 60 }),
      });
      const client = createORPCClient<RouterClient<typeof router>>(
        new RPCLink({
          origin: "https://scope.test",
          url: "/api/kello/rpc",
          headers: () => ({
            "x-loom-operation": operation,
            authorization: "Bearer verified-fixture",
            "x-loom-protocol": "loom-orpc-2",
            "x-loom-version": version,
            "idempotency-key": "storage-scope",
          }),
          fetch: (url, init) => app.fetch(new Request(url, init)),
        }),
      );
      const { id: _id, ...upload } = provider.intent;
      const created = await client.create({ upload, key: "scope-create" });
      assert.equal(created.state, "pending");
      const ownership = await admin.query<{ owner_scope: string }>(
        `SELECT owner_scope FROM "${metadataNamespace}".storage_intents WHERE id = $1`,
        [created.id],
      );
      assert.equal(ownership.rows[0]?.owner_scope, JSON.stringify([schema.metadata.namespace, ""]));
      assert(escaped);
      await assert.rejects(escaped.status(created.id), /invocation has ended/);
      assert.equal((await client.status(created.id)).id, created.id);
      assert.equal((await client.automatic(created.id)).id, created.id);
      operation = "query";
      await assert.rejects(client.automatic(created.id), { code: "FORBIDDEN" });
      operation = "call";
      assert.equal((await client.effectStatus(created.id)).id, created.id);
      subject = "bob";
      await assert.rejects(client.automaticCaught(created.id), { code: "FORBIDDEN" });
      await assert.rejects(client.status(created.id), { code: "FORBIDDEN" });
      await assert.rejects(client.effectStatus(created.id), { code: "FORBIDDEN" });
      subject = "alice";
      await assert.rejects(client.read(created.id), { code: "FORBIDDEN" });
      await assert.rejects(client.write(created.id), { code: "FORBIDDEN" });
      await assert.rejects(client.caught(created.id), { code: "FORBIDDEN" });
      assert.deepEqual((await admin.query(`SELECT value FROM "${metadataNamespace}".scope_counter`)).rows, [
        { value: 0 },
      ]);
      // Even caught/unawaited work must settle before the response releases its scope.
      block = true;
      let completed = false;
      const pending = client.unawaited(created.id).then((value) => {
        completed = true;
        return value;
      });
      await entered.promise;
      assert.equal(completed, false);
      release.resolve();
      assert.equal(await pending, "drained");
      release = Promise.withResolvers<void>();
      entered = Promise.withResolvers<void>();
      const interrupted = assert.rejects(client.unawaited(created.id));
      await entered.promise;
      let stopped = false;
      const stopping = runtime.stop().then(() => {
        stopped = true;
      });
      await cancelled.promise;
      assert.equal(stopped, false, "Shutdown must drain the blocked storage operation");
      release.resolve();
      await interrupted;
      await stopping;
    } finally {
      release.resolve();
      await runtime?.stop();
      await provider.cleanup();
      await admin.query(`DROP SCHEMA IF EXISTS "${metadataNamespace}" CASCADE`);
      await admin.query(`DROP ROLE IF EXISTS "${runtimeRole}"`);
      await admin.end();
    }
  },
  30000,
);
