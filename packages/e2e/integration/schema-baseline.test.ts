import { test, expect } from "bun:test";
import assert from "node:assert/strict";
import { withMigrationConnection } from "../../../apps/kello-cli/src/tooling/migrations/connection";
import {
  captureSchemaBaseline,
  establishSchemaBaseline,
} from "../../../apps/kello-cli/src/tooling/migrations/branch-baseline";
import { applyMigrations, migrationStatus, readMigrations } from "kello-cli";
import { ormHistoryTable } from "../../../apps/kello-cli/src/tooling/migrations/state";

const source = process.env.LOOM_BASELINE_SOURCE_URL;
const target = process.env.LOOM_BASELINE_TARGET_URL;
const root = process.env.LOOM_BASELINE_ROOT;

test.skipIf(!source || !target || !root)(
  "schema-only baseline adopts verified DDL without replay and preserves quarantine",
  async () => {
    assert(source && target && root);
    const scope = { namespace: "u5_app", metadataNamespace: "loom_u5_meta" };
    const artifacts = await readMigrations(root, "kello/_generated/migrations");
    await withMigrationConnection(source, async (sourceClient) => {
      const baseline = await captureSchemaBaseline(sourceClient, scope, artifacts);
      await withMigrationConnection(target, async (targetClient) => {
        expect((await targetClient.query("SELECT count(*)::int AS count FROM u5_app.tasks")).rows[0]?.count).toBe(0);
        await establishSchemaBaseline(sourceClient, targetClient, baseline, artifacts);
        await establishSchemaBaseline(sourceClient, targetClient, baseline, artifacts);
        const orm = `loom_u5_meta."${ormHistoryTable(scope.namespace)}"`;
        const ledger = await targetClient.query<{ hash: string; created_at: string }>(
          `SELECT hash, created_at FROM ${orm}`,
        );
        try {
          await targetClient.query(`UPDATE ${orm} SET hash=$1`, ["0".repeat(64)]);
          await assert.rejects(
            establishSchemaBaseline(sourceClient, targetClient, baseline, artifacts),
            /partial or differs/,
          );
        } finally {
          for (const row of ledger.rows)
            await targetClient.query(`UPDATE ${orm} SET hash=$1 WHERE created_at=$2`, [row.hash, row.created_at]);
        }
        try {
          await targetClient.query("ALTER TABLE u5_app.tasks ADD COLUMN baseline_drift text");
          await assert.rejects(
            establishSchemaBaseline(sourceClient, targetClient, baseline, artifacts),
            /catalog differs/,
          );
        } finally {
          await targetClient.query("ALTER TABLE u5_app.tasks DROP COLUMN IF EXISTS baseline_drift");
        }
        const marker = "a".repeat(64);
        try {
          await targetClient.query(
            "INSERT INTO loom_u5_meta.mutation_results(scope_hash,key_hash,fingerprint,result,expires_at) VALUES($1,$1,$1,'{}',now()+interval '1 minute')",
            [marker],
          );
          await assert.rejects(
            establishSchemaBaseline(sourceClient, targetClient, baseline, artifacts),
            /inherited runtime records/,
          );
        } finally {
          await targetClient.query("DELETE FROM loom_u5_meta.mutation_results WHERE scope_hash=$1 AND key_hash=$1", [
            marker,
          ]);
        }
        try {
          await sourceClient.query("ALTER TABLE u5_app.tasks ADD COLUMN baseline_race text");
          await assert.rejects(establishSchemaBaseline(sourceClient, targetClient, baseline, artifacts));
        } finally {
          await sourceClient.query("ALTER TABLE u5_app.tasks DROP COLUMN IF EXISTS baseline_race");
        }
        await establishSchemaBaseline(sourceClient, targetClient, baseline, artifacts);
        expect(
          (await targetClient.query("SELECT count(*)::int AS count FROM loom_u5_meta.deployment_activations")).rows[0]
            ?.count,
        ).toBe(0);
        expect(
          (
            await targetClient.query(
              "SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls FROM pg_roles WHERE rolname='loom_u5_runtime'",
            )
          ).rows,
        ).toEqual([
          { rolcanlogin: false, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false },
        ]);
        expect(
          (
            await targetClient.query(
              "SELECT has_table_privilege('loom_u5_runtime','u5_app.tasks','INSERT') AS writable, has_schema_privilege('loom_u5_runtime','u5_app','CREATE') AS ddl",
            )
          ).rows,
        ).toEqual([{ writable: true, ddl: false }]);
        await targetClient.query("INSERT INTO u5_app.tasks(title) VALUES ('target-only')");
        await targetClient.query("DELETE FROM u5_app.tasks WHERE title='target-only'");
      });
    });
    const options = { root, connectionString: target, migrations: "kello/_generated/migrations", ...scope };
    expect((await migrationStatus(options)).consistent).toBe(true);
    expect((await applyMigrations({ ...options, runtimeRole: "loom_u5_runtime" })).applied).toEqual([]);
  },
  60_000,
);
