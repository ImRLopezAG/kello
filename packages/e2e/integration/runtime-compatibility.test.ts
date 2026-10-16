import assert from "node:assert/strict";
import { test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { defineSchema } from "kello/server";
import { applyMigrations, emptySnapshot, planMigration, writeMigration, inspectReleaseSchema } from "kello/tooling";
import { withMigrationConnection } from "../../../apps/kello/src/tooling/migrations/connection";
import {
  recordRuntimeCompatibility,
  assertRuntimeCompatibility,
} from "../../../apps/kello/src/tooling/migrations/runtime-compatibility";

const connectionString = process.env.LOOM_TEST_DATABASE_URL;
test.skipIf(!connectionString)(
  "migration compatibility covers active code and queued jobs across structural epochs",
  async () => {
    if (!connectionString) throw new Error("Missing test database");
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const namespace = `app_${suffix}`;
    const metadataNamespace = `loom_${suffix}`;
    const runtimeRole = `runtime_${suffix}`;
    const root = await mkdtemp(join(tmpdir(), "loom-runtime-compatibility-"));
    const admin = new pg.Client({ connectionString });
    await admin.connect();
    const options = { connectionString, root, namespace, metadataNamespace, runtimeRole, migrations: "migrations" };
    const identity = { namespace, metadataNamespace, deployment: "preview", version: "a".repeat(64) };
    try {
      const original = defineSchema((s) => ({ tasks: { title: s.text() } }), { namespace });
      const initial = await planMigration(await emptySnapshot(namespace), original);
      await writeMigration(root, "migrations", "initial", initial);
      await applyMigrations(options);
      await admin.query(`INSERT INTO "${namespace}".tasks(title) VALUES ('preserved')`);
      await admin.query(
        `INSERT INTO "${metadataNamespace}".deployment_activations(deployment,version,project_id,branch_id,endpoint_host,database_name,token_hash,state) VALUES('preview',$1,'project','branch','localhost','postgres',repeat('b',64),'active')`,
        [identity.version],
      );
      const initialInspection = await inspectReleaseSchema(root, {
        namespace,
        migrations: "migrations",
        migrationHashes: [initial.hash],
        schema: { minimum: initial.after, maximum: initial.after, target: initial.after },
      });
      await withMigrationConnection(connectionString, (client) =>
        recordRuntimeCompatibility(client, { ...identity, sourceSchema: initial.after, inspection: initialInspection }),
      );
      const expansion = await planMigration(
        initial.snapshot,
        defineSchema((s) => ({ tasks: { title: s.text(), note: s.text() } }), { namespace }),
        [],
        initial.hash,
      );
      await writeMigration(root, "migrations", "expand", expansion);
      await assert.rejects(applyMigrations(options), /lacks compatibility/);
      assert.equal(
        (
          await admin.query(
            `SELECT count(*)::integer AS count FROM information_schema.columns WHERE table_schema=$1 AND table_name='tasks' AND column_name='note'`,
            [namespace],
          )
        ).rows[0].count,
        0,
      );
      const compatible = await inspectReleaseSchema(root, {
        namespace,
        migrations: "migrations",
        migrationHashes: [initial.hash, expansion.hash],
        schema: { minimum: initial.after, maximum: expansion.after, target: expansion.after },
      });
      await withMigrationConnection(connectionString, (client) =>
        recordRuntimeCompatibility(client, { ...identity, sourceSchema: initial.after, inspection: compatible }),
      );
      await applyMigrations(options);
      const rows = await drizzle({ client: admin }).select().from(original.tables.tasks);
      assert.equal(rows[0]?.title, "preserved");
      assert.equal(Object.hasOwn(rows[0] ?? {}, "note"), false);
      await assert.rejects(
        withMigrationConnection(connectionString, (client) =>
          recordRuntimeCompatibility(client, { ...identity, sourceSchema: expansion.after, inspection: compatible }),
        ),
        /history changed/,
      );
      const contraction = await planMigration(expansion.snapshot, original, [], expansion.hash);
      assert.equal(contraction.after, initial.after);
      await writeMigration(root, "migrations", "contract", contraction);
      const futureOnly = await inspectReleaseSchema(root, {
        namespace,
        migrations: "migrations",
        migrationHashes: [initial.hash, expansion.hash, contraction.hash],
        schema: {
          minimum: contraction.after,
          maximum: contraction.after,
          target: contraction.after,
          minimumMigration: contraction.hash,
          maximumMigration: contraction.hash,
        },
      });
      await assert.rejects(
        withMigrationConnection(connectionString, (client) =>
          assertRuntimeCompatibility(client, identity, futureOnly.migrationHashes, 2, {
            ...identity,
            inspection: futureOnly,
          }),
        ),
        /lacks compatibility/,
      );
      const apply = { ...options, reviewedHashes: [contraction.hash] };
      await assert.rejects(applyMigrations(apply), /lacks compatibility/);
      await admin.query(`UPDATE "${metadataNamespace}".deployment_activations SET state='quarantined'`);
      await admin.query(
        `INSERT INTO "${metadataNamespace}".jobs(id,deployment,deduplication_key,fingerprint,call,identity,due_at,max_attempts,retry_delay_seconds) VALUES(uuidv7(),'preview','old-work',repeat('c',64),$1::jsonb,'{}',now(),1,0)`,
        [JSON.stringify({ version: identity.version })],
      );
      await assert.rejects(applyMigrations(apply), /lacks compatibility/);
      await admin.query(`UPDATE "${metadataNamespace}".jobs SET state='succeeded'`);
      await admin.query(
        `INSERT INTO "${metadataNamespace}".client_sessions(namespace,deployment,version,ticket_hash,expires_at) VALUES($1,'preview',$2,repeat('d',64),clock_timestamp()+interval '1 hour')`,
        [namespace, identity.version],
      );
      await assert.rejects(applyMigrations(apply), /lacks compatibility/);
      await admin.query(
        `UPDATE "${metadataNamespace}".client_sessions SET expires_at=clock_timestamp()-interval '1 second'`,
      );
      await applyMigrations(apply);
      assert.equal((await admin.query(`SELECT title FROM "${namespace}".tasks`)).rows[0].title, "preserved");
      await admin.query(`SET ROLE "${runtimeRole}"`);
      await assert.rejects(
        admin.query(`UPDATE "${metadataNamespace}".runtime_compatibility SET maximum_ordinal=100`),
        /permission denied/,
      );
      await admin.query("RESET ROLE");
    } finally {
      await admin.query("RESET ROLE");
      await admin.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
      await admin.query(`DROP SCHEMA IF EXISTS "${metadataNamespace}" CASCADE`);
      await admin.query(`DROP ROLE IF EXISTS "${runtimeRole}"`);
      await admin.end();
      await rm(root, { recursive: true, force: true });
    }
  },
);
