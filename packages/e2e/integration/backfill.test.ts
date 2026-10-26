import assert from "node:assert/strict";
import { test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { defineSchema } from "kello/server";
import {
  applyMigrations,
  emptySnapshot,
  planMigration,
  writeMigration,
  createBackfillPlan,
  runBackfill,
  backfillStatus,
} from "kello-cli";

const connectionString = process.env.LOOM_TEST_DATABASE_URL;
test.skipIf(!connectionString)(
  "backfills resume atomic batches over a durable work list without repeating writes",
  async () => {
    if (!connectionString) throw new Error("Missing test database");
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const namespace = `app_${suffix}`;
    const metadataNamespace = `loom_${suffix}`;
    const runtimeRole = `runtime_${suffix}`;
    const root = await mkdtemp(join(tmpdir(), "loom-backfill-"));
    const admin = new pg.Client({ connectionString });
    await admin.connect();
    const options = { connectionString, root, namespace, metadataNamespace, runtimeRole, migrations: "migrations" };
    try {
      const schema = defineSchema((s) => ({ tasks: { title: s.text(), passes: s.integer().notNull().default(0) } }), {
        namespace,
      });
      const initial = await planMigration(await emptySnapshot(namespace), schema);
      await writeMigration(root, "migrations", "initial", initial);
      await applyMigrations(options);
      for (let i = 1; i <= 5; i++)
        await admin.query(`INSERT INTO "${namespace}".tasks("_id", title) VALUES ($1, $2)`, [
          `00000000-0000-7000-8000-00000000000${i}`,
          i === 3 ? "fail" : "ready",
        ]);
      const plan = await createBackfillPlan({
        name: "count_rows",
        namespace,
        table: "tasks",
        migrationHash: initial.hash,
        batchSize: 2,
        sql: `UPDATE "${namespace}".tasks SET passes=passes+1/(CASE WHEN title='fail' THEN 0 ELSE 1 END) WHERE "_id"=ANY($1::uuid[]) RETURNING "_id"`,
      });
      await assert.rejects(runBackfill({ ...options, plan, reviewedHash: "0".repeat(64) }), /review/i);
      const first = await runBackfill({ ...options, plan, reviewedHash: plan.hash, maxBatches: 1 });
      assert.equal(first.state, "running");
      assert.equal(first.processed, 2);
      assert.equal(first.total, 5);
      await admin.query(`INSERT INTO "${namespace}".tasks(title) VALUES ('late')`);
      await assert.rejects(runBackfill({ ...options, plan, reviewedHash: plan.hash }), /division by zero/i);
      assert.equal(
        (await admin.query(`SELECT processed FROM "${metadataNamespace}".backfills`)).rows[0].processed,
        "2",
      );
      assert.equal(
        (await admin.query(`SELECT sum(passes)::integer AS passes FROM "${namespace}".tasks`)).rows[0].passes,
        2,
      );
      await admin.query(`UPDATE "${namespace}".tasks SET title='ready' WHERE title='fail'`);
      await admin.query(
        `ALTER TABLE "${metadataNamespace}".backfills ADD CONSTRAINT fail_checkpoint CHECK (processed <= 2)`,
      );
      await assert.rejects(runBackfill({ ...options, plan, reviewedHash: plan.hash }), /fail_checkpoint/);
      assert.equal(
        (await admin.query(`SELECT sum(passes)::integer AS passes FROM "${namespace}".tasks`)).rows[0].passes,
        2,
      );
      await admin.query(`ALTER TABLE "${metadataNamespace}".backfills DROP CONSTRAINT fail_checkpoint`);
      const abort = new AbortController();
      abort.abort();
      await assert.rejects(runBackfill({ ...options, plan, reviewedHash: plan.hash, signal: abort.signal }), /abort/i);
      const results = await Promise.all([
        runBackfill({ ...options, plan, reviewedHash: plan.hash }),
        runBackfill({ ...options, plan, reviewedHash: plan.hash }),
      ]);
      for (const result of results) {
        assert.equal(result.state, "complete");
        assert.equal(result.processed, 5);
      }
      assert.deepEqual(
        (
          await admin.query(
            `SELECT passes, count(*)::integer AS count FROM "${namespace}".tasks GROUP BY passes ORDER BY passes`,
          )
        ).rows,
        [
          { passes: 0, count: 1 },
          { passes: 1, count: 5 },
        ],
      );
      assert.equal(
        (await admin.query(`SELECT count(*)::integer AS count FROM "${metadataNamespace}".backfill_rows`)).rows[0]
          .count,
        0,
      );
      await assert.rejects(
        runBackfill({ ...options, plan: { ...plan, batchSize: 3 }, reviewedHash: plan.hash }),
        /hash/i,
      );
      const changed = await createBackfillPlan({
        name: plan.name,
        namespace,
        table: "tasks",
        migrationHash: initial.hash,
        batchSize: 3,
        sql: plan.sql,
      });
      await assert.rejects(
        runBackfill({ ...options, plan: changed, reviewedHash: changed.hash }),
        /checkpoint identity/,
      );
      await admin.query(`CREATE POLICY stray ON "${namespace}".tasks USING (true)`);
      await assert.rejects(runBackfill({ ...options, plan, reviewedHash: plan.hash }), /drift/);
      await admin.query(`DROP POLICY stray ON "${namespace}".tasks`);
      const broad = await createBackfillPlan({
        name: "too_broad",
        namespace,
        table: "tasks",
        migrationHash: initial.hash,
        batchSize: 2,
        sql: `UPDATE "${namespace}".tasks SET passes=passes+1 WHERE $1::uuid[] IS NOT NULL RETURNING "_id"`,
      });
      await assert.rejects(runBackfill({ ...options, plan: broad, reviewedHash: broad.hash }), /exactly the selected/);
      assert.equal(
        (await admin.query(`SELECT sum(passes)::integer AS passes FROM "${namespace}".tasks`)).rows[0].passes,
        5,
      );
      const deleted = await createBackfillPlan({
        name: "deleted_row",
        namespace,
        table: "tasks",
        migrationHash: initial.hash,
        batchSize: 2,
        sql: `UPDATE "${namespace}".tasks SET passes=passes+1 WHERE "_id"=ANY($1::uuid[]) RETURNING "_id"`,
      });
      await runBackfill({ ...options, plan: deleted, reviewedHash: deleted.hash, maxBatches: 1 });
      await admin.query(`DELETE FROM "${namespace}".tasks WHERE "_id"='00000000-0000-7000-8000-000000000005'`);
      const finished = await runBackfill({ ...options, plan: deleted, reviewedHash: deleted.hash });
      assert.equal(finished.total, 6);
      assert.equal(finished.processed, 5);
      assert.equal(finished.deleted, 1);
      const slow = await createBackfillPlan({
        name: "cancel_batch",
        namespace,
        table: "tasks",
        migrationHash: initial.hash,
        batchSize: 2,
        sql: `UPDATE "${namespace}".tasks SET passes=passes+1+(SELECT 0 FROM pg_sleep(0.3)) WHERE "_id"=ANY($1::uuid[]) RETURNING "_id"`,
      });
      const cancellation = new AbortController();
      const pending = assert.rejects(
        runBackfill({ ...options, plan: slow, reviewedHash: slow.hash, signal: cancellation.signal }),
        /abort/i,
      );
      let observed = false;
      try {
        for (let attempt = 0; attempt < 100; attempt++) {
          const active = await admin.query(
            `SELECT 1 FROM pg_stat_activity WHERE application_name='loom-migrations' AND state='active' AND query=$1`,
            [slow.sql],
          );
          if (active.rowCount) {
            observed = true;
            break;
          }
          await Bun.sleep(10);
        }
      } finally {
        cancellation.abort();
        await pending;
      }
      assert.equal(observed, true);
      const checkpoint = await backfillStatus({ connectionString, namespace, metadataNamespace, plan: slow });
      assert.equal(checkpoint?.processed, 0);
      assert.equal(
        (await admin.query(`SELECT sum(passes)::integer AS passes FROM "${namespace}".tasks`)).rows[0].passes,
        9,
      );
      const expanded = defineSchema(
        (s) => ({ tasks: { title: s.text(), passes: s.integer().notNull().default(0), extra: s.text() } }),
        { namespace },
      );
      await writeMigration(
        root,
        "migrations",
        "later_expansion",
        await planMigration(initial.snapshot, expanded, [], initial.hash),
      );
      await assert.rejects(applyMigrations(options), /Complete running backfills/);
      const resumed = await runBackfill({ ...options, plan: slow, reviewedHash: slow.hash });
      assert.equal(resumed.state, "complete");
      assert.equal(resumed.processed, 5);
      await admin.query(`SET ROLE "${runtimeRole}"`);
      await assert.rejects(admin.query(`DELETE FROM "${metadataNamespace}".backfills`), /permission denied/);
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
