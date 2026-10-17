import assert from "node:assert/strict";
import { expect, test } from "bun:test";
import { bootstrapDatabase, frameworkMigrations } from "../../../apps/kello/src/tooling/migrations/bootstrap";
import pg from "pg";

const connectionString = process.env.LOOM_TEST_DATABASE_URL;
test.skipIf(!connectionString)(
  "bootstrap is versioned, concurrent-safe and isolates the runtime role from metadata and DDL",
  async () => {
    if (!connectionString) throw new Error("Missing test database");
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const metadataNamespace = `loom_meta_${suffix}`;
    const runtimeRole = `loom_runtime_${suffix}`;
    const admin = new pg.Client({ connectionString });
    await admin.connect();
    try {
      await Promise.all([
        bootstrapDatabase({ connectionString, metadataNamespace, runtimeRole }),
        bootstrapDatabase({ connectionString, metadataNamespace, runtimeRole }),
      ]);
      const migrations = frameworkMigrations(metadataNamespace);
      expect(
        (await admin.query(`SELECT version,hash FROM "${metadataNamespace}".framework_migrations ORDER BY version`))
          .rows,
      ).toEqual(migrations.map(({ version, hash }) => ({ version, hash })));

      // Seed the immutable historical DDL directly. Upgrading a current database and
      // then pretending to downgrade it cannot recreate objects retired by version 29.
      for (let prefix = 1; prefix <= 28; prefix++) {
        await admin.query(`DROP SCHEMA "${metadataNamespace}" CASCADE`);
        await admin.query(`CREATE SCHEMA "${metadataNamespace}"`);
        await admin.query(`CREATE TABLE "${metadataNamespace}".framework_migrations (
          version integer PRIMARY KEY, hash text NOT NULL,
          applied_at timestamptz NOT NULL DEFAULT clock_timestamp())`);
        const historical = migrations.slice(0, prefix);
        // Send each prefix as one batch; hundreds of serial cloud round trips
        // otherwise consume the test budget before the upgrade assertions run.
        await admin.query(
          historical
            .flatMap((migration) => [
              ...migration.statements,
              `INSERT INTO "${metadataNamespace}".framework_migrations(version,hash) VALUES(${migration.version},${pg.escapeLiteral(migration.hash)})`,
            ])
            .join(";\n"),
        );
        const before = (
          await admin.query(
            `SELECT version,hash,applied_at FROM "${metadataNamespace}".framework_migrations ORDER BY version`,
          )
        ).rows;
        await bootstrapDatabase({ connectionString, metadataNamespace, runtimeRole });
        expect(
          (
            await admin.query(
              `SELECT version,hash,applied_at FROM "${metadataNamespace}".framework_migrations WHERE version <= $1 ORDER BY version`,
              [prefix],
            )
          ).rows,
        ).toEqual(before);
        expect(
          (await admin.query(`SELECT version,hash FROM "${metadataNamespace}".framework_migrations ORDER BY version`))
            .rows,
        ).toEqual(migrations.map(({ version, hash }) => ({ version, hash })));
        for (const table of ["connection_tickets", "table_revisions"]) {
          expect(
            (await admin.query("SELECT to_regclass($1) AS object", [`${metadataNamespace}.${table}`])).rows,
          ).toEqual([{ object: null }]);
        }
      }
      expect((await admin.query(`SELECT * FROM "${metadataNamespace}".development_history`)).rows).toEqual([]);
      // Neon does not automatically grant the creator SET ROLE on a new role.
      await admin.query(`GRANT "${runtimeRole}" TO CURRENT_USER`);
      await admin.query(`SET ROLE "${runtimeRole}"`);
      expect((await admin.query(`SELECT * FROM "${metadataNamespace}".mutation_results`)).rows).toEqual([]);
      await assert.rejects(admin.query(`DELETE FROM "${metadataNamespace}".mutation_results`), /permission denied/);
      await assert.rejects(admin.query(`SELECT * FROM "${metadataNamespace}".migration_history`), /permission denied/);
      await assert.rejects(
        admin.query(`SELECT * FROM "${metadataNamespace}".development_history`),
        /permission denied/,
      );
      await assert.rejects(
        admin.query(`CREATE TABLE "${metadataNamespace}".unauthorized (id integer)`),
        /permission denied/,
      );
      await assert.rejects(
        admin.query(`DELETE FROM "${metadataNamespace}".nontransactional_migrations`),
        /permission denied/,
      );
      await admin.query("RESET ROLE");
      await admin.query(`GRANT pg_read_all_data TO "${runtimeRole}"`);
      await assert.rejects(bootstrapDatabase({ connectionString, metadataNamespace, runtimeRole }), /Runtime role/);
      await admin.query(`REVOKE pg_read_all_data FROM "${runtimeRole}"`);
      await admin.query(`UPDATE "${metadataNamespace}".framework_migrations SET hash = repeat('0', 64)`);
      await assert.rejects(
        bootstrapDatabase({ connectionString, metadataNamespace, runtimeRole }),
        /Framework migration hash/,
      );
    } finally {
      await admin.query("RESET ROLE");
      await admin.query(`DROP SCHEMA IF EXISTS "${metadataNamespace}" CASCADE`);
      await admin.query(`DROP ROLE IF EXISTS "${runtimeRole}"`);
      await admin.end();
    }
  },
  180000,
);

test.skipIf(!connectionString)(
  "bootstrap refuses privileged runtime roles and rolls back its metadata creation",
  async () => {
    if (!connectionString) throw new Error("Missing test database");
    const metadataNamespace = `loom_meta_${crypto.randomUUID().replaceAll("-", "")}`;
    const admin = new pg.Client({ connectionString });
    await admin.connect();
    try {
      await assert.rejects(
        bootstrapDatabase({
          connectionString,
          metadataNamespace,
          runtimeRole: decodeURIComponent(new URL(connectionString).username),
        }),
        /Runtime role/,
      );
      expect(
        (await admin.query("SELECT nspname FROM pg_namespace WHERE nspname = $1", [metadataNamespace])).rows,
      ).toEqual([]);
    } finally {
      await admin.end();
    }
  },
);

test.skipIf(!connectionString)(
  "catalog drift evidence ignores data changes and detects DDL, policies and grants",
  async () => {
    const { catalogFingerprint } = await import("../../../apps/kello/src/tooling/migrations/drift");
    const namespace = `loom_drift_${crypto.randomUUID().replaceAll("-", "")}`;
    const admin = new pg.Client({ connectionString });
    await admin.connect();
    try {
      await admin.query("SET search_path = pg_catalog");
      await admin.query(`CREATE SCHEMA "${namespace}"`);
      await admin.query(`CREATE TABLE "${namespace}".tasks (id integer PRIMARY KEY, title text)`);
      const original = await catalogFingerprint(admin, namespace);
      await admin.query(`INSERT INTO "${namespace}".tasks VALUES (1, 'initial')`);
      await admin.query(`UPDATE "${namespace}".tasks SET title = 'changed'`);
      expect(await catalogFingerprint(admin, namespace)).toBe(original);
      await admin.query(`ALTER TABLE "${namespace}".tasks ADD COLUMN extra text`);
      expect(await catalogFingerprint(admin, namespace)).not.toBe(original);
      await admin.query(`ALTER TABLE "${namespace}".tasks DROP COLUMN extra`);
      expect(await catalogFingerprint(admin, namespace)).toBe(original);
      await admin.query(`CREATE POLICY example ON "${namespace}".tasks USING (id > 0)`);
      expect(await catalogFingerprint(admin, namespace)).not.toBe(original);
      await admin.query(`DROP POLICY example ON "${namespace}".tasks`);
      await admin.query(`GRANT SELECT ON "${namespace}".tasks TO PUBLIC`);
      expect(await catalogFingerprint(admin, namespace)).not.toBe(original);
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
      await admin.end();
    }
  },
);
