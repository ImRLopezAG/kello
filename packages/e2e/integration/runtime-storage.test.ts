import assert from "node:assert/strict";
import { test } from "bun:test";
import pg from "pg";
import { defineRelations } from "drizzle-orm";
import * as v from "valibot";
import {
  bootstrapDatabase,
  defineConfig,
  prepareNeonStorageBuckets,
  prepareNeonStorageTriggers,
  activateNeonTriggers,
} from "kello-cli";
import {
  createRpcRuntime,
  defineRpcAuth,
  defineSchema,
  defineProcedureStorage,
  createProjectProcedures,
  procedureObjectCreated,
  storageObjectCreatedValidator,
} from "kello/server";
import { createNeonRpcWorker } from "kello/neon";
import { storageProviderFixture } from "../fixtures/storage-provider";
import { storageControlPlaneFixture } from "../fixtures/storage-control-plane";

const connectionString = process.env.LOOM_TEST_DATABASE_URL;
test.skipIf(!connectionString)(
  "runtime storage captures inputs, dispatches provider events and drains before closing",
  async () => {
    if (!connectionString) throw new Error("Missing database");
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const metadataNamespace = `loom_${suffix}`;
    const runtimeRole = `runtime_${suffix}`;
    const admin = new pg.Client({ connectionString });
    const provider = storageProviderFixture();
    const control = storageControlPlaneFixture();
    await admin.connect();
    let runtime: Awaited<ReturnType<typeof createRpcRuntime>> | undefined;
    let worker: Awaited<ReturnType<typeof createNeonRpcWorker>> | undefined;
    const release = Promise.withResolvers<void>();
    try {
      const target = {
        config: defineConfig({
          project: "tasks",
          provider: { projectId: "project", targets: { preview: { branchId: "br-preview" } } },
        }),
        environment: "preview" as const,
      };
      const bucketOptions = { ...target, buckets: ["uploads"] };
      await prepareNeonStorageBuckets(bucketOptions, control.provider);
      const triggerOptions = { ...target, workerSlug: "loomworker", buckets: [{ name: "uploads", bucket: "uploads" }] };
      const prepared = await prepareNeonStorageTriggers(triggerOptions, control.provider);
      const trigger = prepared.triggers[0];
      assert.ok(trigger?.prefix);
      assert.equal(trigger.enabled, false);
      await prepareNeonStorageBuckets(bucketOptions, control.provider);
      const repeated = await prepareNeonStorageTriggers(triggerOptions, control.provider);
      assert.deepEqual(repeated.bindings, prepared.bindings);
      assert.deepEqual(control.writes, ["bucket", "trigger"]);
      await bootstrapDatabase({ connectionString, metadataNamespace, runtimeRole });
      await admin.query(`ALTER ROLE "${runtimeRole}" LOGIN PASSWORD 'loom-test-only'`);
      const address = new URL(connectionString);
      address.username = runtimeRole;
      address.password = "loom-test-only";
      const schema = defineSchema(() => ({}));
      const version = "a".repeat(64);
      let active = true;
      let waiting = false;
      let effects = 0;
      let closed = 0;
      const started = Promise.withResolvers<void>();
      const cancelled = Promise.withResolvers<void>();
      const { procedure } = createProjectProcedures(schema);
      const created = procedure
        .input(storageObjectCreatedValidator)
        .output(v.null())
        .handler(() => {
          effects++;
          return null;
        });
      const storage = defineProcedureStorage({
        buckets: { uploads: { onObjectCreated: procedureObjectCreated(created) } },
        authorize: async ({ identity, signal }) => {
          assert.equal(identity.subject, "alice");
          if (waiting) {
            started.resolve();
            signal.addEventListener("abort", () => cancelled.resolve(), { once: true });
            await release.promise;
            signal.throwIfAborted();
          }
        },
      });
      const options = {
        schema,
        relations: defineRelations(schema.tables),
        connectionString: address.href,
        deployment: "storage-runtime",
        version,
        metadataNamespace,
        storage,
        auth: defineRpcAuth({
          authorize: ({ path, identity, job }) => {
            assert.deepEqual(path, ["files", "created"]);
            assert.equal(identity, null);
            assert.ok(job);
          },
        }),
        assertActive: async () => {
          if (!active) throw new Error("inactive");
        },
        procedures: [{ path: ["files", "created"], visibility: "internal" as const, procedure: created }],
      };
      await assert.rejects(createRpcRuntime(options), /Storage backend required/);
      let connected = 0;
      const storageBackend = {
        projectId: "project",
        branchId: "br-preview",
        connect: () => {
          connected++;
          const backend = provider.connect();
          return {
            ...backend,
            close: () => {
              closed++;
              backend.close();
            },
          };
        },
      };
      await assert.rejects(
        createRpcRuntime({ ...options, storage: { ...storage }, storageBackend }),
        /defineProcedureStorage/,
      );
      await assert.rejects(
        createRpcRuntime({ ...options, procedures: [], storageBackend }),
        /registered internal procedure/,
      );
      await assert.rejects(
        createRpcRuntime({ ...options, storage: defineProcedureStorage(), storageBackend }),
        /requires declared buckets/,
      );
      assert.equal(connected, 0);
      await assert.rejects(
        createRpcRuntime({ ...options, storageBackend: { ...storageBackend, branchId: "br-other" } }),
        /target mismatch/,
      );
      assert.equal(closed, 1);
      active = false;
      await assert.rejects(createRpcRuntime({ ...options, storageBackend }), /activation/i);
      assert.equal(connected, 1);
      active = true;
      runtime = await createRpcRuntime({ ...options, storageBackend });
      assert.ok(runtime.storage);
      const { id: _id, ...upload } = provider.intent;
      const identity = { issuer: "issuer", subject: "alice", tenantId: "tenant" };
      const changing = { ...identity };
      const creating = runtime.storage.intents.create(changing, upload, "one");
      changing.subject = "bob";
      const saved = await creating;
      await assert.rejects(runtime.storage.intents.status({ ...identity, tenantId: "other" }, saved.id));
      const signed = await runtime.storage.intents.signUpload(identity, saved.id);
      assert.ok(signed.key.startsWith(trigger.prefix));
      await fetch(signed.url, { method: signed.method, headers: signed.headers, body: provider.body });
      worker = await createNeonRpcWorker({
        ...options,
        storageBackend,
        bindings: {
          ...prepared.bindings,
          "wake-id": { kind: "wake", name: "worker" },
        },
      });
      const activation = {
        ...triggerOptions,
        target: prepared.target,
        triggers: prepared.triggers,
        workerFunctionId: "fn-worker",
        workerDeploymentId: 1,
        assertActive: options.assertActive,
      };
      control.state.accessLevel = "public_read";
      await assert.rejects(activateNeonTriggers(activation, control.provider), /Trigger activation incomplete/);
      control.state.accessLevel = "private";
      active = false;
      await assert.rejects(activateNeonTriggers(activation, control.provider), /Trigger activation incomplete/);
      active = true;
      assert.deepEqual(control.writes, ["bucket", "trigger"]);
      const enabled = await activateNeonTriggers(activation, control.provider);
      assert.equal(enabled.triggers[0]?.enabled, true);
      await activateNeonTriggers(activation, control.provider);
      assert.deepEqual(control.writes, ["bucket", "trigger", "enable"]);
      const delivery = (id: string, type: "storage_object_created" | "schedule", triggerId: string, name: string) =>
        new Request("https://worker.test/api/kello/triggers", {
          method: "POST",
          headers: { "content-type": "application/json", "x-neon-trigger-invocation-id": id },
          body: JSON.stringify({
            version: 1,
            invocation_id: id,
            trigger: { id: triggerId, name, type },
            data:
              type === "schedule"
                ? { scheduled_at: "2026-01-01T00:00:00Z" }
                : { bucket_name: "uploads", object_key: signed.key },
          }),
        });
      assert.equal(
        (await worker.fetch(delivery("object", "storage_object_created", trigger.triggerId, trigger.name))).status,
        202,
      );
      assert.equal(
        (await worker.fetch(delivery("object", "storage_object_created", trigger.triggerId, trigger.name))).status,
        202,
      );
      assert.equal(effects, 0);
      assert.equal((await runtime.storage.intents.status(identity, saved.id)).state, "ready");
      const download = await runtime.storage.intents.signDownload(identity, saved.id);
      assert.equal(await (await fetch(download.url)).text(), provider.body.toString());
      await admin.query(
        `UPDATE "${metadataNamespace}".storage_intents SET upload_expires_at = now() - interval '2 days', cleanup_after = now() - interval '1 day' WHERE id = $1`,
        [saved.id],
      );
      assert.equal((await worker.fetch(delivery("wake", "schedule", "wake-id", "worker"))).status, 200);
      assert.equal(effects, 1);
      assert.ok(!provider.objects.has(new URL(signed.url).pathname));
      await runtime.storage.intents.signDownload(identity, saved.id);
      await worker.stop();
      assert.equal(closed, 2);
      active = false;
      await assert.rejects(runtime.storage.intents.status(identity, saved.id), /activation/i);
      active = true;
      waiting = true;
      const pending = runtime.storage.intents.status(identity, saved.id);
      const rejected = assert.rejects(pending);
      await started.promise;
      const stopping = runtime.stop();
      assert.equal(runtime.stop(), stopping);
      await cancelled.promise;
      assert.equal(closed, 2);
      release.resolve();
      await rejected;
      await stopping;
      assert.equal(closed, 3);
      await assert.rejects(runtime.storage.intents.status(identity, saved.id), /stopped/);
      await assert.rejects(runtime.storage.cleanup.run(), /stopped/);
      await assert.rejects(
        runtime.storage.events.receive({
          invocationId: "later",
          triggerId: trigger.triggerId,
          triggerName: "uploads",
          bucket: "uploads",
          key: signed.key,
        }),
        /stopped/,
      );
    } finally {
      release.resolve();
      await worker?.stop();
      await runtime?.stop();
      await provider.cleanup();
      await control.cleanup();
      await admin.query(`DROP SCHEMA IF EXISTS "${metadataNamespace}" CASCADE`);
      await admin.query(`DROP ROLE IF EXISTS "${runtimeRole}"`);
      await admin.end();
    }
  },
);

test("Neon bucket privacy requires explicit known provider metadata", async () => {
  const control = storageControlPlaneFixture();
  try {
    const options = {
      config: defineConfig({
        project: "tasks",
        provider: { projectId: "project", targets: { preview: { branchId: "br-preview" } } },
      }),
      environment: "preview" as const,
      buckets: ["uploads"],
    };
    await prepareNeonStorageBuckets(options, control.provider);
    control.state.accessLevel = "public_write";
    await assert.rejects(prepareNeonStorageBuckets(options, control.provider), /Could not prepare/);
    control.state.omitAccessLevel = true;
    await assert.rejects(prepareNeonStorageBuckets(options, control.provider), /Could not prepare/);
    control.state.omitAccessLevel = false;
    control.state.accessLevel = "public_read";
    await assert.rejects(prepareNeonStorageBuckets(options, control.provider), /Could not prepare/);
    control.state.accessLevel = "private";
    await prepareNeonStorageBuckets(options, control.provider);
    assert.deepEqual(control.writes, ["bucket"]);
  } finally {
    await control.cleanup();
  }
});
