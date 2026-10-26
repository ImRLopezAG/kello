import assert from "node:assert/strict";
import { test } from "bun:test";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { bootstrapDatabase } from "kello-cli";
import { createStorageIntents } from "kello/server";
import { storageProviderFixture } from "../fixtures/storage-provider";

const connectionString = process.env.LOOM_TEST_DATABASE_URL;
test.skipIf(!connectionString)(
  "storage intents authorize owners and recover object writes across database failure",
  async () => {
    if (!connectionString) throw new Error("Missing test database");
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const metadataNamespace = `loom_${suffix}`;
    const runtimeRole = `runtime_${suffix}`;
    const admin = new pg.Client({ connectionString });
    const provider = storageProviderFixture();
    await admin.connect();
    let pool: pg.Pool | undefined;
    try {
      await bootstrapDatabase({ connectionString, metadataNamespace, runtimeRole });
      await admin.query(`ALTER ROLE "${runtimeRole}" LOGIN PASSWORD 'loom-test-only'`);
      const address = new URL(connectionString);
      address.username = runtimeRole;
      address.password = "loom-test-only";
      pool = new pg.Pool({ connectionString: address.href });
      let active = true;
      let permitted = true;
      async function requireFence() {
        const held = await admin.query<{ held: boolean }>(
          `SELECT EXISTS(SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
            WHERE a.usename=$1 AND l.relation=$2::regclass AND l.mode='AccessShareLock' AND l.granted) AS held`,
          [runtimeRole, `"${metadataNamespace}".deployment_activations`],
        );
        assert.equal(held.rows[0]?.held, true, "Storage provider calls must retain the retirement barrier");
      }
      const options = {
        db: drizzle({ client: pool }),
        metadataNamespace,
        deployment: "app",
        projectId: "project",
        branchId: "br-preview",
        buckets: ["uploads"],
        storage: {
          ...provider.storage,
          async signUpload(...args: Parameters<typeof provider.storage.signUpload>) {
            await requireFence();
            return provider.storage.signUpload(...args);
          },
          async sealUpload(...args: Parameters<typeof provider.storage.sealUpload>) {
            await requireFence();
            return provider.storage.sealUpload(...args);
          },
          async signDownload(...args: Parameters<typeof provider.storage.signDownload>) {
            await requireFence();
            return provider.storage.signDownload(...args);
          },
        },
        assertActive: async () => {
          if (!active) throw new Error("Quarantined");
        },
        authorize: async () => {
          if (!permitted) throw new Error("Policy denied");
        },
      };
      const intents = createStorageIntents(options);
      const alice = { issuer: "https://identity.test", subject: "alice", tenantId: "a" };
      const otherTenant = { ...alice, tenantId: "b" };
      const { id: _id, ...upload } = provider.intent;
      const [first, repeated] = await Promise.all([
        intents.create(alice, upload, "request-1"),
        intents.create(alice, upload, "request-1"),
      ]);
      assert.equal(first.id, repeated.id);
      assert.equal(first.state, "pending");
      assert.equal(first.id[14], "7");
      await assert.rejects(
        pool.query(`UPDATE "${metadataNamespace}".storage_intents SET upload = '{}'::jsonb WHERE id = $1`, [first.id]),
        /permission denied/,
      );
      assert.notEqual((await intents.create(otherTenant, upload, "request-1")).id, first.id);
      await assert.rejects(intents.create(alice, { ...upload, sha256: "0".repeat(64) }, "request-1"));
      await assert.rejects(intents.create(alice, { ...upload, bucket: "other-bucket" }, "wrong-bucket"));
      await assert.rejects(intents.signUpload(otherTenant, first.id));
      await assert.rejects(intents.signDownload(alice, first.id));
      assert.throws(() => createStorageIntents({ ...options, branchId: "br-clone" }));
      const clone = storageProviderFixture("br-clone");
      try {
        const copied = createStorageIntents({ ...options, branchId: "br-clone", storage: clone.storage });
        await assert.rejects(copied.status(alice, first.id));
      } finally {
        await clone.cleanup();
      }
      const signed = await intents.signUpload(alice, first.id.toUpperCase());
      assert.ok(signed.key.endsWith(first.id));
      await fetch(signed.url, { method: signed.method, headers: signed.headers, body: provider.body });
      // The object write succeeds, then the metadata update fails in PostgreSQL.
      await admin.query(
        `CREATE FUNCTION "${metadataNamespace}".fail_ready() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture database failure'; END $$`,
      );
      await admin.query(
        `CREATE TRIGGER fail_ready BEFORE UPDATE ON "${metadataNamespace}".storage_intents FOR EACH ROW WHEN (NEW.state = 'ready') EXECUTE FUNCTION "${metadataNamespace}".fail_ready()`,
      );
      await assert.rejects(intents.finalize(alice, first.id));
      assert.equal((await intents.status(alice, first.id)).state, "pending");
      await admin.query(`DROP TRIGGER fail_ready ON "${metadataNamespace}".storage_intents`);
      // Recovery must use the ready object even when the original upload has gone away.
      provider.objects.delete(new URL(signed.url).pathname);
      const finalized = await Promise.all([intents.finalize(alice, first.id), intents.finalize(alice, first.id)]);
      assert.ok(finalized.every((result) => result.state === "ready"));
      const download = await intents.signDownload(alice, first.id);
      assert.deepEqual(Buffer.from(await (await fetch(download.url)).arrayBuffer()), provider.body);
      await assert.rejects(intents.signDownload(otherTenant, first.id));
      const inherited = storageProviderFixture("br-child");
      try {
        for (const [key, value] of provider.objects) inherited.objects.set(key, value);
        const child = createStorageIntents({
          ...options,
          deployment: "child-app",
          branchId: "br-child",
          storage: inherited.storage,
        });
        assert.equal((await child.status(alice, first.id)).state, "ready");
        const download = await child.signDownload(alice, first.id);
        assert.deepEqual(Buffer.from(await (await fetch(download.url)).arrayBuffer()), provider.body);
        await assert.rejects(child.signDownload(otherTenant, first.id));
        await assert.rejects(child.finalize(alice, first.id));
        await assert.rejects(child.signUpload(alice, first.id));
        const sibling = createStorageIntents({
          ...options,
          deployment: "component:other",
          branchId: "br-child",
          storage: inherited.storage,
          ownerScope: "other",
        });
        await assert.rejects(sibling.status(alice, first.id));
        const otherApplication = createStorageIntents({
          ...options,
          deployment: "other-app",
          applicationNamespace: "other_app",
          branchId: "br-child",
          storage: inherited.storage,
        });
        await assert.rejects(otherApplication.status(alice, first.id));
        await assert.rejects(otherApplication.signDownload(alice, first.id));
        const component = createStorageIntents({ ...options, deployment: "component:parent", ownerScope: "archive" });
        const componentFile = await component.create(alice, upload, "component-file");
        const componentUpload = await component.signUpload(alice, componentFile.id);
        await fetch(componentUpload.url, { method: "PUT", headers: componentUpload.headers, body: provider.body });
        await component.finalize(alice, componentFile.id);
        for (const [key, value] of provider.objects) inherited.objects.set(key, value);
        const childComponent = createStorageIntents({
          ...options,
          deployment: "component:child",
          branchId: "br-child",
          ownerScope: "archive",
          storage: inherited.storage,
        });
        assert.equal((await childComponent.status(alice, componentFile.id)).state, "ready");
        assert.deepEqual(
          Buffer.from(
            await (await fetch((await childComponent.signDownload(alice, componentFile.id)).url)).arrayBuffer(),
          ),
          provider.body,
        );
        await assert.rejects(child.status(alice, componentFile.id));
        await assert.rejects(childComponent.status(alice, first.id));
        const pending = await intents.create(alice, upload, "inherited-pending");
        await assert.rejects(child.status(alice, pending.id));
        await assert.rejects(child.finalize(alice, pending.id));
        assert.notEqual((await child.create(alice, upload, "request-1")).id, first.id);
        // Historical rows remain branch-bound until an administrator supplies an explicit ownership mapping.
        await admin.query(`UPDATE "${metadataNamespace}".storage_intents SET owner_scope = NULL WHERE id = $1`, [
          first.id,
        ]);
        await assert.rejects(child.status(alice, first.id));
        assert.equal((await intents.status(alice, first.id)).state, "ready");
        await assert.rejects(
          pool.query(`UPDATE "${metadataNamespace}".storage_intents SET owner_scope = '' WHERE id = $1`, [first.id]),
          /permission denied/,
        );
      } finally {
        await inherited.cleanup();
      }
      permitted = false;
      await assert.rejects(intents.signDownload(alice, first.id));
      await assert.rejects(intents.create(alice, upload, "denied"));
      permitted = true;
      active = false;
      await assert.rejects(intents.status(alice, first.id));
      active = true;
      const failed = await intents.create(alice, upload, "request-2");
      const bad = await intents.signUpload(alice, failed.id);
      await fetch(bad.url, { method: bad.method, headers: bad.headers, body: Buffer.from("tampered upload") });
      await assert.rejects(intents.finalize(alice, failed.id), /verification/i);
      assert.deepEqual(await intents.status(alice, failed.id), {
        id: failed.id,
        state: "failed",
        errorCode: "VERIFICATION_FAILED",
      });
      await assert.rejects(intents.signDownload(alice, failed.id));
      const pending = await intents.create(alice, upload, "request-3");
      await assert.rejects(intents.finalize(alice, pending.id));
      assert.equal((await intents.status(alice, pending.id)).state, "pending");
      await admin.query(
        `UPDATE "${metadataNamespace}".storage_intents SET upload_expires_at = now() - interval '1 second' WHERE id = $1`,
        [pending.id],
      );
      await assert.rejects(intents.signUpload(alice, pending.id));
      const interrupted = await intents.create(alice, upload, "request-4");
      const staged = await intents.signUpload(alice, interrupted.id);
      await fetch(staged.url, { method: staged.method, headers: staged.headers, body: provider.body });
      const changing = createStorageIntents({
        ...options,
        storage: {
          ...provider.storage,
          async sealUpload(...args) {
            const result = await provider.storage.sealUpload(...args);
            active = false;
            return result;
          },
        },
      });
      await assert.rejects(changing.finalize(alice, interrupted.id));
      active = true;
      assert.equal((await intents.status(alice, interrupted.id)).state, "pending");
      assert.equal((await intents.finalize(alice, interrupted.id)).state, "ready");
    } finally {
      await pool?.end();
      await provider.cleanup();
      await admin.query(`DROP SCHEMA IF EXISTS "${metadataNamespace}" CASCADE`);
      await admin.query(`DROP ROLE IF EXISTS "${runtimeRole}"`);
      await admin.end();
    }
  },
);
