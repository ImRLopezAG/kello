import assert from "node:assert/strict";
import { test } from "bun:test";
import pg from "pg";
import { defineRelations, sql } from "drizzle-orm";
import * as v from "valibot";
import { bootstrapDatabase } from "kello-cli";
import {
  connectDatabase,
  IngressRetiredError,
  createStorageIntents,
  createRpcStorageEventDispatcher,
  createRpcJobQueue,
  createRpcJobWorker,
  defineSchema,
  createProjectProcedures,
  createDatabaseMiddleware,
  bindRpcDatabaseProcedure,
  storageObjectCreatedValidator,
} from "kello/server";
import { createNeonTriggers } from "kello/neon";
import { storageProviderFixture } from "../fixtures/storage-provider";

const connectionString = process.env.LOOM_TEST_DATABASE_URL;
test.skipIf(!connectionString)(
  "native storage event receipts reconcile uploads and enqueue one internal effect across duplicate deliveries",
  async () => {
    if (!connectionString) throw new Error("Missing database");
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const metadataNamespace = `loom_${suffix}`;
    const runtimeRole = `runtime_${suffix}`;
    const admin = new pg.Client({ connectionString });
    const provider = storageProviderFixture();
    await admin.connect();
    try {
      await bootstrapDatabase({ connectionString, metadataNamespace, runtimeRole });
      await admin.query(`CREATE TABLE "${metadataNamespace}".effects (intent_id uuid PRIMARY KEY)`);
      await admin.query(`GRANT SELECT, INSERT ON "${metadataNamespace}".effects TO "${runtimeRole}"`);
      await admin.query(`ALTER ROLE "${runtimeRole}" LOGIN PASSWORD 'loom-test-only'`);
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
        const version = "e".repeat(64);
        const { procedure } = createProjectProcedures(schema);
        const handler = procedure
          .use(createDatabaseMiddleware(relations, "write", schema))
          .input(storageObjectCreatedValidator)
          .output(v.null())
          .handler(async ({ context, input: event }) => {
            assert.equal(context.identity, null);
            assert.equal(event.uploadedBy.tenantId, "tenant");
            await context.db.execute(
              sql`INSERT INTO ${sql.identifier(metadataNamespace)}.effects VALUES (${event.intentId}::uuid)`,
            );
            return null;
          });
        const internal = [{ path: ["files", "created"], procedure: handler }];
        const common = { db: connection.db, metadataNamespace, deployment: "app" };
        const queue = createRpcJobQueue({ ...common, version, internal });
        const assertActive = async () => {};
        const intents = createStorageIntents({
          ...common,
          projectId: "project",
          branchId: "br-preview",
          buckets: ["uploads"],
          storage: provider.storage,
          assertActive,
          authorize: async () => {},
        });
        const eventOptions = {
          ...common,
          projectId: "project",
          branchId: "br-preview",
          intents,
          queue,
          assertActive,
          version,
          handlers: { uploads: { path: ["files", "created"], maxAttempts: 1 } },
        };
        const first = createRpcStorageEventDispatcher(eventOptions);
        const second = createRpcStorageEventDispatcher(eventOptions);
        const alice = { issuer: "https://identity.test", subject: "alice", tenantId: "tenant" };
        const { id: _id, ...upload } = provider.intent;
        const saved = await intents.create(alice, upload, "one");
        const signed = await intents.signUpload(alice, saved.id);
        await fetch(signed.url, { method: signed.method, headers: signed.headers, body: provider.body });
        const delivery = {
          invocationId: "delivery-1",
          triggerId: "storage-trigger",
          triggerName: "uploads",
          bucket: "uploads",
          key: signed.key,
        };
        const [a, b] = await Promise.all([first.receive(delivery), second.receive(delivery)]);
        assert.deepEqual(a, b);
        assert.equal(a.state, "dispatched");
        assert.deepEqual(await first.receive({ ...delivery, invocationId: "delivery-2" }), a);
        assert.equal((await intents.status(alice, saved.id)).state, "ready");
        assert.equal(
          (await admin.query(`SELECT count(*)::int AS count FROM "${metadataNamespace}".jobs`)).rows[0].count,
          1,
        );
        const bound = bindRpcDatabaseProcedure(handler, { connection, replay: common, authorize: async () => {} });
        const worker = createRpcJobWorker({
          queue,
          internal: [{ path: ["files", "created"], procedure: bound }],
          assertActive,
        });
        try {
          assert.equal((await worker.run()).completed, 1);
          assert.deepEqual(await second.receive({ ...delivery, invocationId: "delivery-3" }), a);
          assert.equal((await worker.run()).claimed, 0);
          assert.equal(
            (await admin.query(`SELECT count(*)::int AS count FROM "${metadataNamespace}".effects`)).rows[0].count,
            1,
          );
          await assert.rejects(first.receive({ ...delivery, key: "unbound-key" }));
          await assert.rejects(
            first.receive({ ...delivery, key: signed.key.replace(saved.id, saved.id.toUpperCase()) }),
          );
          const another = await intents.create(alice, upload, "two");
          const otherUpload = await intents.signUpload(alice, another.id);
          await fetch(otherUpload.url, {
            method: otherUpload.method,
            headers: otherUpload.headers,
            body: provider.body,
          });
          await assert.rejects(first.receive({ ...delivery, key: otherUpload.key }), /conflict/i);
          assert.equal((await intents.status(alice, another.id)).state, "pending");
          await admin.query(
            `CREATE FUNCTION "${metadataNamespace}".fail_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture receipt failure'; END $$`,
          );
          await admin.query(
            `CREATE TRIGGER fail_receipt BEFORE UPDATE ON "${metadataNamespace}".storage_receipts FOR EACH ROW WHEN (NEW.state = 'dispatched') EXECUTE FUNCTION "${metadataNamespace}".fail_receipt()`,
          );
          await assert.rejects(first.receive({ ...delivery, invocationId: "delivery-http", key: otherUpload.key }));
          assert.equal((await intents.status(alice, another.id)).state, "ready");
          assert.equal(
            (await admin.query(`SELECT count(*)::int AS count FROM "${metadataNamespace}".jobs`)).rows[0].count,
            1,
          );
          assert.equal(
            (
              await admin.query(
                `SELECT state FROM "${metadataNamespace}".storage_receipts WHERE invocation_id = 'delivery-http'`,
              )
            ).rows[0].state,
            "pending",
          );
          await admin.query(`DROP TRIGGER fail_receipt ON "${metadataNamespace}".storage_receipts`);
          const app = createNeonTriggers({
            bindings: { "storage-trigger": { kind: "storage", name: "uploads", bucket: "uploads" } },
            crons: {
              dispatch: async () => {
                throw new Error("Unexpected cron");
              },
              recordWake: async () => {},
            },
            storage: second,
            worker,
          });
          const body = {
            version: 1,
            invocation_id: "delivery-http",
            trigger: { type: "storage_object_created", id: "storage-trigger", name: "uploads" },
            data: { bucket_name: "uploads", object_key: otherUpload.key },
          };
          const request = () =>
            new Request("https://example.test/api/kello/triggers", {
              method: "POST",
              headers: { "content-type": "application/json", "x-neon-trigger-invocation-id": "delivery-http" },
              body: JSON.stringify(body),
            });
          assert.equal((await app.fetch(request())).status, 202);
          assert.equal((await app.fetch(request())).status, 202);
          assert.equal(
            (await admin.query(`SELECT count(*)::int AS count FROM "${metadataNamespace}".effects`)).rows[0].count,
            1,
          );
          assert.equal((await worker.run()).completed, 1);
          const failed = await intents.create(alice, upload, "bad");
          const bad = await intents.signUpload(alice, failed.id);
          await fetch(bad.url, { method: bad.method, headers: bad.headers, body: Buffer.from("tampered upload") });
          assert.deepEqual(await first.receive({ ...delivery, invocationId: "bad", key: bad.key }), {
            state: "failed",
          });
          assert.deepEqual(await first.receive({ ...delivery, invocationId: "bad", key: bad.key }), {
            state: "failed",
          });
          assert.equal((await worker.run()).claimed, 0);
          const delayed = await intents.create(alice, upload, "delayed");
          const delayedUpload = await intents.signUpload(alice, delayed.id);
          const delayedEvent = { ...delivery, invocationId: "delayed", key: delayedUpload.key };
          await assert.rejects(first.receive(delayedEvent));
          assert.equal(
            (
              await admin.query(
                `SELECT state FROM "${metadataNamespace}".storage_receipts WHERE invocation_id = 'delayed'`,
              )
            ).rows[0].state,
            "pending",
          );
          assert.deepEqual(await first.reconcile(1), {
            claimed: 1,
            dispatched: 0,
            failed: 0,
            pending: 1,
            inactive: false,
          });
          assert.equal((await second.reconcile(1)).claimed, 0);
          await fetch(delayedUpload.url, {
            method: delayedUpload.method,
            headers: delayedUpload.headers,
            body: provider.body,
          });

          const cutover = await intents.create(alice, upload, "cutover");
          const cutoverUpload = await intents.signUpload(alice, cutover.id);
          await fetch(cutoverUpload.url, {
            method: cutoverUpload.method,
            headers: cutoverUpload.headers,
            body: provider.body,
          });
          let ingressChecks = 0;
          const fenced = createRpcStorageEventDispatcher({
            ...eventOptions,
            assertIngress: async (_signal, transaction) => {
              assert.notEqual(transaction, connection.db);
              if (++ingressChecks === 2) throw new Error("Ingress changed during object verification");
            },
          });
          const cutoverEvent = { ...delivery, invocationId: "cutover", key: cutoverUpload.key };
          await assert.rejects(fenced.receive(cutoverEvent), /Ingress changed/);
          assert.equal(ingressChecks, 2);
          assert.equal(
            (
              await admin.query(`SELECT event_job_id FROM "${metadataNamespace}".storage_intents WHERE id=$1`, [
                cutover.id,
              ])
            ).rows[0].event_job_id,
            null,
          );
          assert.equal(
            (
              await admin.query(
                `SELECT state FROM "${metadataNamespace}".storage_receipts WHERE invocation_id='cutover'`,
              )
            ).rows[0].state,
            "pending",
          );
          for (const scope of [
            { branchId: "other-branch" },
            { deployment: "other-app" },
            { projectId: "other-project" },
          ]) {
            const isolated = createRpcStorageEventDispatcher({ ...eventOptions, ...scope });
            assert.equal((await isolated.reconcile(1)).claimed, 0);
          }
          const recovered = await Promise.all([first.reconcile(1), second.reconcile(1)]);
          assert.equal(
            recovered.reduce((count, result) => count + result.claimed, 0),
            1,
          );
          assert.equal(
            recovered.reduce((count, result) => count + result.dispatched, 0),
            1,
          );
          assert.deepEqual(await second.reconcile(1), {
            claimed: 0,
            dispatched: 0,
            failed: 0,
            pending: 0,
            inactive: false,
          });
          const retired = createRpcStorageEventDispatcher({
            ...eventOptions,
            assertIngress: async () => {
              throw new IngressRetiredError();
            },
          });
          assert.deepEqual(await retired.reconcile(1), {
            claimed: 0,
            dispatched: 0,
            failed: 0,
            pending: 0,
            inactive: true,
          });
          const denied = createRpcStorageEventDispatcher({
            ...eventOptions,
            assertIngress: async () => {
              throw new Error("Authority unavailable");
            },
          });
          await assert.rejects(denied.reconcile(1), /Authority unavailable/);
          const cancelled = new AbortController();
          cancelled.abort();
          await assert.rejects(first.reconcile(1, cancelled.signal));
          await admin.query(
            `UPDATE "${metadataNamespace}".storage_receipts SET reconcile_after=clock_timestamp() WHERE invocation_id='delayed'`,
          );
          assert.equal((await second.reconcile(1)).dispatched, 1);
          await assert.rejects(first.reconcile(0));
          await assert.rejects(first.reconcile(1001));
          assert.equal((await worker.run()).completed, 2);
        } finally {
          await worker.stop();
        }
      } finally {
        await connection.close();
      }
    } finally {
      await provider.cleanup();
      await admin.query(`DROP SCHEMA IF EXISTS "${metadataNamespace}" CASCADE`);
      await admin.query(`DROP ROLE IF EXISTS "${runtimeRole}"`);
      await admin.end();
    }
  },
);
