import assert from "node:assert/strict";
import { test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { defineSchema, defineTable } from "kello/server";
import {
  applyMigrations,
  emptySnapshot,
  planMigration,
  planCustomMigration,
  writeMigration,
  migrationStatus,
} from "kello/tooling";

const connectionString = process.env.LOOM_TEST_DATABASE_URL;
test("concurrent recovery refuses SQL outside its declared index expansion", async () => {
  const { concurrentIndexOperations } = await import("../../../apps/kello/src/tooling/migrations/nontransactional");
  const namespace = "recovery_validation";
  const baseline = (
    await planMigration(
      await emptySnapshot(namespace),
      defineSchema((s) => ({ tasks: { title: s.text() } }), { namespace }),
    )
  ).snapshot;
  const indexed = defineSchema(
    (s) => ({ tasks: defineTable({ title: s.text() }, { indexes: [{ fields: ["title"] }] }) }),
    { namespace },
  );
  for (const sql of [
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS tasks_0_idx ON ${namespace}.tasks (title)`,
    `CREATE INDEX CONCURRENTLY tasks_0_idx ON ${namespace}.tasks (lower(title))`,
    `CREATE INDEX CONCURRENTLY tasks_0_idx ON ${namespace}.tasks (title) WHERE title IS NOT NULL`,
    `CREATE INDEX CONCURRENTLY tasks_0_idx ON ${namespace}.tasks (title DESC)`,
    `CREATE INDEX CONCURRENTLY tasks_0_idx ON ${namespace}.tasks ("_id")`,
    `CREATE INDEX CONCURRENTLY tasks_0_idx ON another_namespace.tasks (title)`,
    `UPDATE ${namespace}.tasks SET title='changed'`,
  ]) {
    const plan = await planCustomMigration(baseline, indexed, sql, "nontransactional", "a".repeat(64));
    await assert.rejects(
      concurrentIndexOperations({ name: "index", directory: "unused", plan }, namespace),
      /Recovery supports|differs|application namespace/,
    );
  }
});
test.skipIf(!connectionString)(
  "concurrent index recovery inspects partial catalog state and commits both migration histories once",
  async () => {
    if (!connectionString) throw new Error("Missing test database");
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const namespace = `app_${suffix}`;
    const metadataNamespace = `loom_${suffix}`;
    const runtimeRole = `runtime_${suffix}`;
    const root = await mkdtemp(join(tmpdir(), "loom-index-recovery-"));
    const admin = new pg.Client({ connectionString });
    await admin.connect();
    const options = { connectionString, root, namespace, metadataNamespace, runtimeRole, migrations: "migrations" };
    const statusOptions = { connectionString, root, namespace, metadataNamespace, migrations: "migrations" };
    try {
      const schema = defineSchema((s) => ({ tasks: { title: s.text() } }), { namespace });
      const initial = await planMigration(await emptySnapshot(namespace), schema);
      await writeMigration(root, "migrations", "initial", initial);
      await applyMigrations(options);
      await admin.query(`INSERT INTO "${namespace}".tasks(title) VALUES ('duplicate'), ('duplicate')`);
      const indexed = defineSchema(
        (s) => ({
          tasks: defineTable(
            { title: s.text() },
            { indexes: [{ fields: ["title"] }, { fields: ["title"], unique: true }] },
          ),
        }),
        { namespace },
      );
      const statements = [
        `CREATE INDEX CONCURRENTLY tasks_0_idx ON "${namespace}".tasks (title)`,
        `CREATE UNIQUE INDEX CONCURRENTLY tasks_1_idx ON "${namespace}".tasks (title)`,
      ];
      const artifact = await planCustomMigration(
        initial.snapshot,
        indexed,
        statements.join(";\n"),
        "nontransactional",
        initial.hash,
      );
      await writeMigration(root, "migrations", "index_titles", artifact);
      await assert.rejects(applyMigrations({ ...options, reviewedHashes: [artifact.hash] }), /recovery/i);
      const recovery = { ...options, recoverNontransactional: true, reviewedHashes: [artifact.hash] };
      await assert.rejects(applyMigrations({ ...recovery, reviewedHashes: [] }), /review/i);
      await assert.rejects(applyMigrations(recovery), /unique|duplicate/i);
      const indexes = await admin.query<{ name: string; valid: boolean; oid: number }>(
        `SELECT c.relname AS name, i.indisvalid AS valid, c.oid FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname IN ('tasks_0_idx', 'tasks_1_idx') ORDER BY c.relname`,
        [namespace],
      );
      assert.deepEqual(
        indexes.rows.map(({ name, valid }) => ({ name, valid })),
        [
          { name: "tasks_0_idx", valid: true },
          { name: "tasks_1_idx", valid: false },
        ],
      );
      assert.equal((await migrationStatus(statusOptions)).consistent, false);
      assert.equal(
        (await admin.query(`SELECT hash FROM "${metadataNamespace}".nontransactional_migrations`)).rows[0].hash,
        artifact.hash,
      );
      await admin.query(`CREATE POLICY stray ON "${namespace}".tasks USING (true)`);
      await assert.rejects(applyMigrations(recovery), /drift/i);
      await admin.query(`DROP POLICY stray ON "${namespace}".tasks`);
      await admin.query(`DROP INDEX "${namespace}".tasks_1_idx`);
      await admin.query(`CREATE INDEX tasks_1_idx ON "${namespace}".tasks ("_id")`);
      await assert.rejects(applyMigrations(recovery), /differs from the reviewed/i);
      await admin.query(`DROP INDEX "${namespace}".tasks_1_idx`);
      await assert.rejects(applyMigrations(recovery), /unique|duplicate/i);
      await admin.query(
        `DELETE FROM "${namespace}".tasks WHERE "_id" IN (SELECT "_id" FROM "${namespace}".tasks ORDER BY "_id" LIMIT 1)`,
      );
      await admin.query(
        `ALTER TABLE "${metadataNamespace}".migration_history ADD CONSTRAINT fail_checkpoint CHECK (ordinal <> 2)`,
      );
      await assert.rejects(applyMigrations(recovery), /fail_checkpoint/);
      assert.ok((await migrationStatus(statusOptions)).issues.includes("NONTRANSACTIONAL_IN_PROGRESS"));
      const completedIndex = (
        await admin.query(`SELECT oid FROM pg_class WHERE relnamespace=$1::regnamespace AND relname='tasks_1_idx'`, [
          namespace,
        ])
      ).rows[0].oid;
      await admin.query(`ALTER TABLE "${metadataNamespace}".migration_history DROP CONSTRAINT fail_checkpoint`);
      const results = await Promise.allSettled([applyMigrations(recovery), applyMigrations(recovery)]);
      for (const result of results) if (result.status === "rejected") throw result.reason;
      assert.deepEqual(
        results.flatMap((result) => (result.status === "fulfilled" ? result.value.applied : [])),
        [artifact.hash],
      );
      const status = await migrationStatus(statusOptions);
      assert.equal(status.consistent, true);
      assert.deepEqual(status.applied, [initial.hash, artifact.hash]);
      assert.equal(
        (await admin.query(`SELECT count(*) FROM "${metadataNamespace}".nontransactional_migrations`)).rows[0].count,
        "0",
      );
      assert.equal(
        (
          await admin.query(`SELECT oid FROM pg_class WHERE relnamespace=$1::regnamespace AND relname='tasks_0_idx'`, [
            namespace,
          ])
        ).rows[0].oid,
        indexes.rows[0]?.oid,
      );
      assert.deepEqual((await applyMigrations(options)).applied, []);
      assert.equal(
        (
          await admin.query(`SELECT oid FROM pg_class WHERE relnamespace=$1::regnamespace AND relname='tasks_1_idx'`, [
            namespace,
          ])
        ).rows[0].oid,
        completedIndex,
      );
      await assert.rejects(
        admin.query(`INSERT INTO "${namespace}".tasks(title) VALUES ('duplicate')`),
        /unique|duplicate/i,
      );
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
      await admin.query(`DROP SCHEMA IF EXISTS "${metadataNamespace}" CASCADE`);
      await admin.query(`DROP ROLE IF EXISTS "${runtimeRole}"`);
      await admin.end();
      await rm(root, { recursive: true, force: true });
    }
  },
);
