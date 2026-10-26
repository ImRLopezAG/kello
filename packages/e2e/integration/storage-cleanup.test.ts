import assert from "node:assert/strict";
import { test } from "bun:test";
import pg from "pg";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { bootstrapDatabase } from "kello-cli";
import { createStorageIntents, createStorageCleanup } from "kello/server";
import { storageProviderFixture } from "../fixtures/storage-provider";

const connectionString = process.env.LOOM_TEST_DATABASE_URL;
test.skipIf(!connectionString)(
  "storage cleanup expires abandoned intents, preserves ready objects and retries failures",
  async () => {
    if (!connectionString) throw new Error("Missing test database");
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const metadataNamespace = `loom_${suffix}`;
    const runtimeRole = `runtime_${suffix}`;
    const admin = new pg.Client({ connectionString });
    const provider = storageProviderFixture();
    await admin.connect();
    let pool: pg.Pool | undefined;
    const sealStarted = Promise.withResolvers<void>();
    const sealRelease = Promise.withResolvers<void>();
    const removeStarted = Promise.withResolvers<void>();
    const removeRelease = Promise.withResolvers<void>();
    try {
      await bootstrapDatabase({ connectionString, metadataNamespace, runtimeRole });
      await admin.query(`ALTER ROLE "${runtimeRole}" LOGIN PASSWORD 'loom-test-only'`);
      const address = new URL(connectionString);
      address.username = runtimeRole;
      address.password = "loom-test-only";
      pool = new pg.Pool({ connectionString: address.href });
      let active = true;
      let failDelete = false;
      let blockSeal = false;
      let blockRemove = false;
      const storage = {
        ...provider.storage,
        async sealUpload(...args: Parameters<typeof provider.storage.sealUpload>) {
          if (blockSeal) {
            sealStarted.resolve();
            await sealRelease.promise;
          }
          return provider.storage.sealUpload(...args);
        },
        async remove(...args: Parameters<typeof provider.storage.remove>) {
          if (blockRemove) {
            removeStarted.resolve();
            await removeRelease.promise;
          }
          if (failDelete) throw new Error("provider secret");
          await provider.storage.remove(...args);
        },
      };
      const options = {
        db: drizzle({ client: pool }),
        metadataNamespace,
        deployment: "app",
        projectId: "project",
        branchId: "br-preview",
        buckets: ["uploads"],
        storage,
        assertActive: async () => {
          if (!active) throw new Error("Quarantined");
        },
        authorize: () => {},
      };
      async function requireRetirementBlocked() {
        await admin.query("BEGIN");
        try {
          await assert.rejects(
            admin.query(`LOCK TABLE "${metadataNamespace}".deployment_activations IN ACCESS EXCLUSIVE MODE NOWAIT`),
            /could not obtain lock/,
          );
        } finally {
          await admin.query("ROLLBACK");
        }
      }
      const intents = createStorageIntents(options);
      const cleanup = createStorageCleanup(options);
      const owner = { issuer: "issuer", subject: "alice" };
      const { id: _id, ...upload } = provider.intent;
      async function staged(key: string) {
        const intent = await intents.create(owner, upload, key);
        const signed = await intents.signUpload(owner, intent.id);
        await fetch(signed.url, { method: signed.method, headers: signed.headers, body: provider.body });
        return { ...intent, path: new URL(signed.url).pathname };
      }
      async function due(id: string) {
        await admin.query(
          `UPDATE "${metadataNamespace}".storage_intents SET upload_expires_at = now() - interval '2 days', cleanup_after = now() - interval '1 day' WHERE id = $1`,
          [id],
        );
      }
      const ready = await staged("ready");
      await intents.finalize(owner, ready.id);
      const abandoned = await staged("abandoned");
      // An object write without its SQL commit must also be reclaimed after the recovery window.
      await storage.sealUpload({ id: abandoned.id, ...upload });
      const recent = await staged("recent");
      const foreign = await staged("foreign");
      await due(ready.id);
      await due(abandoned.id);
      await due(foreign.id);
      await admin.query(`UPDATE "${metadataNamespace}".storage_intents SET branch_id = 'br-other' WHERE id = $1`, [
        foreign.id,
      ]);
      assert.deepEqual(await cleanup.run(1), { processed: 1, failed: 0 });
      assert.deepEqual(await cleanup.run(10), { processed: 1, failed: 0 });
      assert.ok(!provider.objects.has(ready.path));
      assert.ok(!provider.objects.has(abandoned.path));
      assert.ok(provider.objects.has(recent.path));
      assert.ok(provider.objects.has(foreign.path));
      assert.equal((await intents.status(owner, abandoned.id)).errorCode, "EXPIRED");
      await assert.rejects(intents.finalize(owner, abandoned.id));
      const download = await intents.signDownload(owner, ready.id);
      assert.equal(await (await fetch(download.url)).text(), provider.body.toString());
      assert.ok(![...provider.objects.keys()].some((key) => key.includes(abandoned.id)));
      assert.deepEqual(await cleanup.run(10), { processed: 0, failed: 0 });
      await due(recent.id);
      failDelete = true;
      assert.deepEqual(await cleanup.run(10), { processed: 1, failed: 1 });
      assert.ok(provider.objects.has(recent.path));
      assert.equal((await intents.status(owner, recent.id)).errorCode, "EXPIRED");
      assert.deepEqual(await cleanup.run(10), { processed: 0, failed: 0 });
      failDelete = false;
      await due(recent.id);
      await cleanup.run(10);
      assert.ok(!provider.objects.has(recent.path));
      active = false;
      await assert.rejects(cleanup.run(10), /Quarantined/);
      await assert.rejects(cleanup.run(101));
      // Re-sweeping terminal intents removes late staging writes without deleting ready objects.
      provider.objects.set(ready.path, { body: provider.body, headers: {} });
      active = true;
      await due(ready.id);
      await cleanup.run(10);
      assert.ok(!provider.objects.has(ready.path));
      await intents.signDownload(owner, ready.id);
      const rolledBack = await staged("rollback");
      await due(rolledBack.id);
      await admin.query(
        `CREATE FUNCTION "${metadataNamespace}".fail_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture cleanup failure'; END $$`,
      );
      await admin.query(
        `CREATE TRIGGER fail_cleanup BEFORE UPDATE ON "${metadataNamespace}".storage_intents FOR EACH ROW WHEN (NEW.cleanup_after IS DISTINCT FROM OLD.cleanup_after) EXECUTE FUNCTION "${metadataNamespace}".fail_cleanup()`,
      );
      await assert.rejects(cleanup.run(10));
      assert.equal((await intents.status(owner, rolledBack.id)).state, "pending");
      assert.ok(!provider.objects.has(rolledBack.path));
      await admin.query(`DROP TRIGGER fail_cleanup ON "${metadataNamespace}".storage_intents`);
      assert.deepEqual(await cleanup.run(10), { processed: 1, failed: 0 });
      assert.equal((await intents.status(owner, rolledBack.id)).errorCode, "EXPIRED");
      const abort = new AbortController();
      abort.abort();
      await assert.rejects(cleanup.run(10, abort.signal));
      const finishing = await staged("finishing");
      await due(finishing.id);
      blockSeal = true;
      const finalizing = intents.finalize(owner, finishing.id);
      await sealStarted.promise;
      await requireRetirementBlocked();
      assert.deepEqual(await cleanup.run(10), { processed: 0, failed: 0 });
      sealRelease.resolve();
      await finalizing;
      blockSeal = false;
      await cleanup.run(10);
      assert.ok(!provider.objects.has(finishing.path));
      await intents.signDownload(owner, finishing.id);
      const expiring = await staged("expiring");
      await due(expiring.id);
      blockRemove = true;
      const cleaning = cleanup.run(10);
      await removeStarted.promise;
      await requireRetirementBlocked();
      const contenderName = `cleanup-race-${suffix}`;
      const contender = new pg.Pool({ connectionString: address.href, application_name: contenderName, max: 1 });
      try {
        const contenderIntents = createStorageIntents({ ...options, db: drizzle({ client: contender }) });
        const rejected = assert.rejects(contenderIntents.finalize(owner, expiring.id));
        let waiting = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          const locks = await admin.query(
            `SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock'`,
            [contenderName],
          );
          if (locks.rows.length) {
            waiting = true;
            break;
          }
          await Bun.sleep(10);
        }
        assert.ok(waiting, "finalizer must wait for cleanup's row lock");
        removeRelease.resolve();
        await cleaning;
        await rejected;
      } finally {
        removeRelease.resolve();
        await contender.end();
      }
      blockRemove = false;
      assert.equal((await intents.status(owner, expiring.id)).errorCode, "EXPIRED");
      assert.ok(![...provider.objects.keys()].some((key) => key.includes(expiring.id)));
      const single = new pg.Pool({ connectionString: address.href, max: 1, connectionTimeoutMillis: 250 });
      try {
        const db = drizzle({ client: single });
        const serialOptions = {
          ...options,
          db,
          assertActive: async (_signal: AbortSignal, current: NodePgDatabase = db) => {
            await current.execute(sql`SELECT 1`);
          },
        };
        const serialIntents = createStorageIntents(serialOptions);
        const serialCleanup = createStorageCleanup(serialOptions);
        const serialUpload = await staged("single-connection");
        await serialIntents.finalize(owner, serialUpload.id);
        await due(serialUpload.id);
        assert.deepEqual(await serialCleanup.run(1), { processed: 1, failed: 0 });
        await serialIntents.signDownload(owner, serialUpload.id);
      } finally {
        await single.end();
      }
    } finally {
      sealRelease.resolve();
      removeRelease.resolve();
      await pool?.end();
      await provider.cleanup();
      await admin.query(`DROP SCHEMA IF EXISTS "${metadataNamespace}" CASCADE`);
      await admin.query(`DROP ROLE IF EXISTS "${runtimeRole}"`);
      await admin.end();
    }
  },
);
