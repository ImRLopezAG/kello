import assert from "node:assert/strict";
import { test } from "bun:test";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { defineRelations } from "drizzle-orm";
import pg from "pg";
import * as v from "valibot";
import { defineApplication, defineComponent } from "kello";
import { createRpcHttpApp } from "kello/neon";
import { bootstrapDatabase } from "kello-cli";
import {
  createProjectProcedures,
  createRpcRuntime,
  defineProcedureStorage,
  defineRpcAuth,
  defineSchema,
  storageUploadValidator,
} from "kello/server";
import { storageProviderFixture } from "../fixtures/storage-provider";

const connectionString = process.env.LOOM_TEST_DATABASE_URL;
test.skipIf(!connectionString)(
  "assembled component runtime inherits ready files without exposing sibling storage",
  async () => {
    assert(connectionString);
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const metadataNamespace = `loom_files_${suffix}`;
    const runtimeRole = `runtime_${suffix}`;
    const schema = defineSchema(() => ({}), { namespace: `app_${suffix}` });
    const componentSchema = defineSchema(() => ({}), { namespace: `files_${suffix}` });
    const parent = storageProviderFixture();
    const child = storageProviderFixture("br-child");
    const admin = new pg.Client({ connectionString });
    const runtimes: Array<Awaited<ReturnType<typeof createRpcRuntime>>> = [];
    await admin.connect();
    try {
      await bootstrapDatabase({ connectionString, metadataNamespace, runtimeRole });
      await admin.query(`ALTER ROLE "${runtimeRole}" LOGIN PASSWORD 'loom-test-only'`);
      const address = new URL(connectionString);
      address.username = runtimeRole;
      address.password = "loom-test-only";
      const application = defineApplication({ rpc: ({ os }) => ({ os }) });
      const component = defineComponent({ name: "files" });
      application.use(component, { name: "left" });
      application.use(component, { name: "right" });
      const { procedure } = createProjectProcedures(componentSchema);
      const router = {
        create: procedure
          .input(v.object({ upload: storageUploadValidator, key: v.string() }))
          .handler(({ context, input }) => context.storage.create(input.upload, input.key)),
        signUpload: procedure.input(v.string()).handler(({ context, input }) => context.storage.signUpload(input)),
        finalize: procedure.input(v.string()).handler(({ context, input }) => context.storage.finalize(input)),
        status: procedure.input(v.string()).handler(({ context, input }) => context.storage.status(input)),
        download: procedure.input(v.string()).handler(({ context, input }) => context.storage.signDownload(input)),
      };
      const definition = defineProcedureStorage({ buckets: { uploads: {} }, authorize: async () => {} });
      async function start(provider: ReturnType<typeof storageProviderFixture>, deployment: string) {
        const version = "a".repeat(64);
        const runtime = await createRpcRuntime({
          schema,
          relations: defineRelations(schema.tables),
          application,
          connectionString: address.href,
          metadataNamespace,
          deployment,
          version,
          assertActive: async () => {},
          auth: defineRpcAuth({ authorize: async () => {} }),
          scopes: [
            { name: "", dependencies: { left: "left", right: "right" }, schema },
            { name: "left", dependencies: {}, schema: componentSchema, storage: definition },
            { name: "right", dependencies: {}, schema: componentSchema, storage: definition },
          ],
          exposures: [
            { scope: "left", prefix: "left" },
            { scope: "right", prefix: "right" },
          ],
          procedures: ["left", "right"].flatMap((scope) =>
            Object.entries(router).map(([name, procedure]) => ({
              scope,
              path: [name],
              visibility: "exported" as const,
              procedure,
            })),
          ),
          storageBackend: { ...provider.storage.target, connect: provider.connect },
        });
        runtimes.push(runtime);
        const app = createRpcHttpApp({
          ...runtime.auth,
          router: runtime.router,
          version,
          verify: async () => ({
            identity: { issuer: "storage-test", subject: "alice" },
            expiresAt: Date.now() / 1000 + 60,
          }),
        });
        return createORPCClient<RouterClient<{ left: typeof router; right: typeof router }>>(
          new RPCLink({
            origin: "https://storage.test",
            url: "/api/kello/rpc",
            headers: { authorization: "Bearer fixture", "x-loom-protocol": "loom-orpc-2", "x-loom-version": version },
            fetch: (url, init) => app.fetch(new Request(url, init)),
          }),
        );
      }
      const before = await start(parent, "parent-deployment");
      const { id: _id, ...upload } = parent.intent;
      const intent = await before.left.create({ upload, key: "file" });
      const signed = await before.left.signUpload(intent.id);
      assert.equal(
        (await fetch(signed.url, { method: signed.method, headers: signed.headers, body: parent.body })).status,
        200,
      );
      assert.equal((await before.left.finalize(intent.id)).state, "ready");
      const ownership = await admin.query<{ owner_scope: string }>(
        `SELECT owner_scope FROM "${metadataNamespace}".storage_intents WHERE id = $1`,
        [intent.id],
      );
      assert.equal(ownership.rows[0]?.owner_scope, JSON.stringify([schema.metadata.namespace, "left"]));
      // Model the forked object snapshot while keeping separate branch provider connections.
      for (const [key, value] of parent.objects) child.objects.set(key, value);
      const after = await start(child, "child-deployment");
      assert.equal((await after.left.status(intent.id)).state, "ready");
      const download = await after.left.download(intent.id);
      assert.notEqual(new URL(download.url).origin, new URL(signed.url).origin);
      assert.deepEqual(Buffer.from(await (await fetch(download.url)).arrayBuffer()), parent.body);
      await assert.rejects(after.right.status(intent.id), { code: "FORBIDDEN" });
      await assert.rejects(after.right.download(intent.id), { code: "FORBIDDEN" });
      await assert.rejects(after.left.signUpload(intent.id), { code: "FORBIDDEN" });
      await assert.rejects(after.left.finalize(intent.id), { code: "FORBIDDEN" });
    } finally {
      for (const runtime of runtimes.reverse()) await runtime.stop();
      await child.cleanup();
      await parent.cleanup();
      await admin.query(`DROP SCHEMA IF EXISTS "${metadataNamespace}" CASCADE`);
      await admin.query(`DROP ROLE IF EXISTS "${runtimeRole}"`);
      await admin.end();
    }
  },
  30000,
);
