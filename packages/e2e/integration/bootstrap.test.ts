import assert from "node:assert/strict";
import { expect, test } from "bun:test";
import { bootstrapDatabase } from "../../../apps/kello/src/tooling/migrations/bootstrap";
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
    async function removeComponentMetadata() {
      await admin.query(
        `DROP TABLE IF EXISTS "${metadataNamespace}".rate_limit_buckets, "${metadataNamespace}".rate_limit_policies`,
      );
      await admin.query(`DROP TABLE IF EXISTS "${metadataNamespace}".search_cursor_keys`);
      await admin.query(
        `ALTER TABLE IF EXISTS "${metadataNamespace}".storage_intents DROP COLUMN IF EXISTS owner_scope`,
      );
      await admin.query(
        `DROP TABLE IF EXISTS "${metadataNamespace}".component_namespaces, "${metadataNamespace}".runtime_scopes`,
      );
    }
    try {
      await Promise.all([
        bootstrapDatabase({ connectionString, metadataNamespace, runtimeRole }),
        bootstrapDatabase({ connectionString, metadataNamespace, runtimeRole }),
      ]);
      expect(
        (await admin.query(`SELECT version FROM "${metadataNamespace}".framework_migrations ORDER BY version`)).rows,
      ).toEqual([
        { version: 1 },
        { version: 2 },
        { version: 3 },
        { version: 4 },
        { version: 5 },
        { version: 6 },
        { version: 7 },
        { version: 8 },
        { version: 9 },
        { version: 10 },
        { version: 11 },
        { version: 12 },
        { version: 13 },
        { version: 14 },
        { version: 15 },
        { version: 16 },
        { version: 17 },
        { version: 18 },
        { version: 19 },
        { version: 20 },
        { version: 21 },
        { version: 22 },
        { version: 23 },
        { version: 24 },
        { version: 25 },
        { version: 26 },
        { version: 27 },
        { version: 28 },
      ]);
      const twentiethVersion = (
        await admin.query(
          `SELECT version,hash FROM "${metadataNamespace}".framework_migrations WHERE version<21 ORDER BY version`,
        )
      ).rows;
      await admin.query(`DROP TABLE "${metadataNamespace}".deployment_secrets`);
      await admin.query(`DROP TABLE "${metadataNamespace}".procedure_releases`);
      await admin.query(`DROP FUNCTION "${metadataNamespace}".fence_migrated_job_claim() CASCADE`);
      await admin.query(
        `ALTER TABLE IF EXISTS "${metadataNamespace}".jobs DROP COLUMN IF EXISTS claim_version, DROP COLUMN IF EXISTS lease_version`,
      );
      await admin.query(`DROP TABLE "${metadataNamespace}".deployment_trigger_bindings`);
      await removeComponentMetadata();
      await admin.query(`DELETE FROM "${metadataNamespace}".framework_migrations WHERE version>=21`);
      await bootstrapDatabase({ connectionString, metadataNamespace, runtimeRole });
      expect(
        (
          await admin.query(
            `SELECT version,hash FROM "${metadataNamespace}".framework_migrations WHERE version<21 ORDER BY version`,
          )
        ).rows,
      ).toEqual(twentiethVersion);
      const nineteenthVersion = (
        await admin.query(
          `SELECT version,hash FROM "${metadataNamespace}".framework_migrations WHERE version<20 ORDER BY version`,
        )
      ).rows;
      await admin.query(`ALTER TABLE "${metadataNamespace}".deployment_activations
        DROP CONSTRAINT deployment_activations_state_check,
        ADD CONSTRAINT deployment_activations_state_check CHECK (state IN ('quarantined','active'))`);
      await admin.query(`DROP TABLE "${metadataNamespace}".deployment_secrets`);
      await admin.query(`DROP TABLE "${metadataNamespace}".procedure_releases`);
      await admin.query(`DROP FUNCTION "${metadataNamespace}".fence_migrated_job_claim() CASCADE`);
      await admin.query(
        `ALTER TABLE IF EXISTS "${metadataNamespace}".jobs DROP COLUMN IF EXISTS claim_version, DROP COLUMN IF EXISTS lease_version`,
      );
      await admin.query(`DROP TABLE "${metadataNamespace}".deployment_trigger_bindings`);
      await removeComponentMetadata();
      await admin.query(`DELETE FROM "${metadataNamespace}".framework_migrations WHERE version>=20`);
      await bootstrapDatabase({ connectionString, metadataNamespace, runtimeRole });
      expect(
        (
          await admin.query(
            `SELECT version,hash FROM "${metadataNamespace}".framework_migrations WHERE version<20 ORDER BY version`,
          )
        ).rows,
      ).toEqual(nineteenthVersion);
      const eighteenthVersion = (
        await admin.query(
          `SELECT version,hash FROM "${metadataNamespace}".framework_migrations WHERE version<19 ORDER BY version`,
        )
      ).rows;
      await admin.query(`DROP TABLE "${metadataNamespace}".client_sessions`);
      await admin.query(
        `ALTER TABLE "${metadataNamespace}".connection_tickets DROP COLUMN namespace, DROP COLUMN version`,
      );
      await admin.query(`DROP TABLE "${metadataNamespace}".deployment_secrets`);
      await admin.query(`DROP TABLE "${metadataNamespace}".procedure_releases`);
      await admin.query(`DROP FUNCTION "${metadataNamespace}".fence_migrated_job_claim() CASCADE`);
      await admin.query(
        `ALTER TABLE IF EXISTS "${metadataNamespace}".jobs DROP COLUMN IF EXISTS claim_version, DROP COLUMN IF EXISTS lease_version`,
      );
      await admin.query(`DROP TABLE "${metadataNamespace}".deployment_trigger_bindings`);
      await removeComponentMetadata();
      await admin.query(`DELETE FROM "${metadataNamespace}".framework_migrations WHERE version>=19`);
      await bootstrapDatabase({ connectionString, metadataNamespace, runtimeRole });
      expect(
        (
          await admin.query(
            `SELECT version,hash FROM "${metadataNamespace}".framework_migrations WHERE version<19 ORDER BY version`,
          )
        ).rows,
      ).toEqual(eighteenthVersion);
      const seventeenthVersion = (
        await admin.query(
          `SELECT version,hash FROM "${metadataNamespace}".framework_migrations WHERE version<18 ORDER BY version`,
        )
      ).rows;
      await admin.query(`DROP TABLE "${metadataNamespace}".client_sessions`);
      await admin.query(
        `ALTER TABLE "${metadataNamespace}".connection_tickets DROP COLUMN namespace, DROP COLUMN version`,
      );
      await admin.query(`ALTER TABLE "${metadataNamespace}".storage_receipts DROP COLUMN reconcile_after`);
      await admin.query(`DROP TABLE "${metadataNamespace}".deployment_secrets`);
      await admin.query(`DROP TABLE "${metadataNamespace}".procedure_releases`);
      await admin.query(`DROP FUNCTION "${metadataNamespace}".fence_migrated_job_claim() CASCADE`);
      await admin.query(
        `ALTER TABLE IF EXISTS "${metadataNamespace}".jobs DROP COLUMN IF EXISTS claim_version, DROP COLUMN IF EXISTS lease_version`,
      );
      await admin.query(`DROP TABLE "${metadataNamespace}".deployment_trigger_bindings`);
      await removeComponentMetadata();
      await admin.query(`DELETE FROM "${metadataNamespace}".framework_migrations WHERE version>=18`);
      await bootstrapDatabase({ connectionString, metadataNamespace, runtimeRole });
      expect(
        (
          await admin.query(
            `SELECT version,hash FROM "${metadataNamespace}".framework_migrations WHERE version<18 ORDER BY version`,
          )
        ).rows,
      ).toEqual(seventeenthVersion);
      const sixteenthVersion = (
        await admin.query(
          `SELECT version,hash FROM "${metadataNamespace}".framework_migrations WHERE version<17 ORDER BY version`,
        )
      ).rows;
      await admin.query(`DROP TABLE "${metadataNamespace}".client_sessions`);
      await admin.query(
        `ALTER TABLE "${metadataNamespace}".connection_tickets DROP COLUMN namespace, DROP COLUMN version`,
      );
      await admin.query(`ALTER TABLE "${metadataNamespace}".storage_receipts DROP COLUMN reconcile_after`);
      await admin.query(`DROP TABLE "${metadataNamespace}".release_ingress`);
      await admin.query(`DROP TABLE "${metadataNamespace}".deployment_secrets`);
      await admin.query(`DROP TABLE "${metadataNamespace}".procedure_releases`);
      await admin.query(`DROP FUNCTION "${metadataNamespace}".fence_migrated_job_claim() CASCADE`);
      await admin.query(
        `ALTER TABLE IF EXISTS "${metadataNamespace}".jobs DROP COLUMN IF EXISTS claim_version, DROP COLUMN IF EXISTS lease_version`,
      );
      await admin.query(`DROP TABLE "${metadataNamespace}".deployment_trigger_bindings`);
      await removeComponentMetadata();
      await admin.query(`DELETE FROM "${metadataNamespace}".framework_migrations WHERE version>=17`);
      await bootstrapDatabase({ connectionString, metadataNamespace, runtimeRole });
      expect(
        (
          await admin.query(
            `SELECT version,hash FROM "${metadataNamespace}".framework_migrations WHERE version<17 ORDER BY version`,
          )
        ).rows,
      ).toEqual(sixteenthVersion);
      const fifteenthVersion = (
        await admin.query(
          `SELECT version, hash FROM "${metadataNamespace}".framework_migrations WHERE version < 16 ORDER BY version`,
        )
      ).rows;
      await admin.query(`DROP TABLE "${metadataNamespace}".client_sessions`);
      await admin.query(
        `ALTER TABLE "${metadataNamespace}".connection_tickets DROP COLUMN namespace, DROP COLUMN version`,
      );
      await admin.query(`ALTER TABLE "${metadataNamespace}".storage_receipts DROP COLUMN reconcile_after`);
      await admin.query(`DROP TABLE "${metadataNamespace}".release_ingress`);
      await admin.query(`DROP TABLE "${metadataNamespace}".function_ownership`);
      await admin.query(`DROP TABLE "${metadataNamespace}".deployment_secrets`);
      await admin.query(`DROP TABLE "${metadataNamespace}".procedure_releases`);
      await admin.query(`DROP FUNCTION "${metadataNamespace}".fence_migrated_job_claim() CASCADE`);
      await admin.query(
        `ALTER TABLE IF EXISTS "${metadataNamespace}".jobs DROP COLUMN IF EXISTS claim_version, DROP COLUMN IF EXISTS lease_version`,
      );
      await admin.query(`DROP TABLE "${metadataNamespace}".deployment_trigger_bindings`);
      await removeComponentMetadata();
      await admin.query(`DELETE FROM "${metadataNamespace}".framework_migrations WHERE version >= 16`);
      await bootstrapDatabase({ connectionString, metadataNamespace, runtimeRole });
      expect(
        (
          await admin.query(
            `SELECT version, hash FROM "${metadataNamespace}".framework_migrations WHERE version < 16 ORDER BY version`,
          )
        ).rows,
      ).toEqual(fifteenthVersion);
      const fourteenthVersion = (
        await admin.query(
          `SELECT version, hash FROM "${metadataNamespace}".framework_migrations WHERE version < 15 ORDER BY version`,
        )
      ).rows;
      await admin.query(`DROP TABLE "${metadataNamespace}".client_sessions`);
      await admin.query(
        `ALTER TABLE "${metadataNamespace}".connection_tickets DROP COLUMN namespace, DROP COLUMN version`,
      );
      await admin.query(`ALTER TABLE "${metadataNamespace}".storage_receipts DROP COLUMN reconcile_after`);
      await admin.query(`DROP TABLE "${metadataNamespace}".release_ingress`);
      await admin.query(`DROP TABLE "${metadataNamespace}".function_ownership`);
      await admin.query(`DROP TABLE "${metadataNamespace}".runtime_compatibility`);
      await admin.query(`DROP TABLE "${metadataNamespace}".deployment_secrets`);
      await admin.query(`DROP TABLE "${metadataNamespace}".procedure_releases`);
      await admin.query(`DROP FUNCTION "${metadataNamespace}".fence_migrated_job_claim() CASCADE`);
      await admin.query(
        `ALTER TABLE IF EXISTS "${metadataNamespace}".jobs DROP COLUMN IF EXISTS claim_version, DROP COLUMN IF EXISTS lease_version`,
      );
      await admin.query(`DROP TABLE "${metadataNamespace}".deployment_trigger_bindings`);
      await removeComponentMetadata();
      await admin.query(`DELETE FROM "${metadataNamespace}".framework_migrations WHERE version >= 15`);
      await bootstrapDatabase({ connectionString, metadataNamespace, runtimeRole });
      expect(
        (
          await admin.query(
            `SELECT version, hash FROM "${metadataNamespace}".framework_migrations WHERE version < 15 ORDER BY version`,
          )
        ).rows,
      ).toEqual(fourteenthVersion);
      const thirteenthVersion = (
        await admin.query(
          `SELECT version, hash FROM "${metadataNamespace}".framework_migrations WHERE version < 14 ORDER BY version`,
        )
      ).rows;
      await admin.query(`DROP TABLE "${metadataNamespace}".client_sessions`);
      await admin.query(
        `ALTER TABLE "${metadataNamespace}".connection_tickets DROP COLUMN namespace, DROP COLUMN version`,
      );
      await admin.query(`ALTER TABLE "${metadataNamespace}".storage_receipts DROP COLUMN reconcile_after`);
      await admin.query(`DROP TABLE "${metadataNamespace}".release_ingress`);
      await admin.query(`DROP TABLE "${metadataNamespace}".function_ownership`);
      await admin.query(`DROP TABLE "${metadataNamespace}".runtime_compatibility`);
      await admin.query(`DROP TABLE "${metadataNamespace}".backfill_rows`);
      await admin.query(`DROP TABLE "${metadataNamespace}".backfills`);
      await admin.query(`DROP TABLE "${metadataNamespace}".deployment_secrets`);
      await admin.query(`DROP TABLE "${metadataNamespace}".procedure_releases`);
      await admin.query(`DROP FUNCTION "${metadataNamespace}".fence_migrated_job_claim() CASCADE`);
      await admin.query(
        `ALTER TABLE IF EXISTS "${metadataNamespace}".jobs DROP COLUMN IF EXISTS claim_version, DROP COLUMN IF EXISTS lease_version`,
      );
      await admin.query(`DROP TABLE "${metadataNamespace}".deployment_trigger_bindings`);
      await removeComponentMetadata();
      await admin.query(`DELETE FROM "${metadataNamespace}".framework_migrations WHERE version >= 14`);
      await bootstrapDatabase({ connectionString, metadataNamespace, runtimeRole });
      expect(
        (
          await admin.query(
            `SELECT version, hash FROM "${metadataNamespace}".framework_migrations WHERE version < 14 ORDER BY version`,
          )
        ).rows,
      ).toEqual(thirteenthVersion);
      const twelfthVersion = (
        await admin.query(
          `SELECT version, hash FROM "${metadataNamespace}".framework_migrations WHERE version < 13 ORDER BY version`,
        )
      ).rows;
      await admin.query(`DROP TABLE "${metadataNamespace}".client_sessions`);
      await admin.query(
        `ALTER TABLE "${metadataNamespace}".connection_tickets DROP COLUMN namespace, DROP COLUMN version`,
      );
      await admin.query(`ALTER TABLE "${metadataNamespace}".storage_receipts DROP COLUMN reconcile_after`);
      await admin.query(`DROP TABLE "${metadataNamespace}".release_ingress`);
      await admin.query(`DROP TABLE "${metadataNamespace}".function_ownership`);
      await admin.query(`DROP TABLE "${metadataNamespace}".runtime_compatibility`);
      await admin.query(`DROP TABLE "${metadataNamespace}".backfill_rows`);
      await admin.query(`DROP TABLE "${metadataNamespace}".backfills`);
      await admin.query(`DROP TABLE "${metadataNamespace}".nontransactional_migrations`);
      await admin.query(`DROP TABLE "${metadataNamespace}".deployment_secrets`);
      await admin.query(`DROP TABLE "${metadataNamespace}".procedure_releases`);
      await admin.query(`DROP FUNCTION "${metadataNamespace}".fence_migrated_job_claim() CASCADE`);
      await admin.query(
        `ALTER TABLE IF EXISTS "${metadataNamespace}".jobs DROP COLUMN IF EXISTS claim_version, DROP COLUMN IF EXISTS lease_version`,
      );
      await admin.query(`DROP TABLE "${metadataNamespace}".deployment_trigger_bindings`);
      await removeComponentMetadata();
      await admin.query(`DELETE FROM "${metadataNamespace}".framework_migrations WHERE version >= 13`);
      await bootstrapDatabase({ connectionString, metadataNamespace, runtimeRole });
      expect(
        (
          await admin.query(
            `SELECT version, hash FROM "${metadataNamespace}".framework_migrations WHERE version < 13 ORDER BY version`,
          )
        ).rows,
      ).toEqual(twelfthVersion);
      const eleventhVersion = (
        await admin.query(
          `SELECT version, hash FROM "${metadataNamespace}".framework_migrations WHERE version < 12 ORDER BY version`,
        )
      ).rows;
      await admin.query(`DROP TABLE "${metadataNamespace}".client_sessions`);
      await admin.query(
        `ALTER TABLE "${metadataNamespace}".connection_tickets DROP COLUMN namespace, DROP COLUMN version`,
      );
      await admin.query(`ALTER TABLE "${metadataNamespace}".storage_intents DROP COLUMN cleanup_after`);
      await admin.query(`ALTER TABLE "${metadataNamespace}".storage_receipts DROP COLUMN reconcile_after`);
      await admin.query(`DROP TABLE "${metadataNamespace}".release_ingress`);
      await admin.query(`DROP TABLE "${metadataNamespace}".function_ownership`);
      await admin.query(`DROP TABLE "${metadataNamespace}".runtime_compatibility`);
      await admin.query(`DROP TABLE "${metadataNamespace}".backfill_rows`);
      await admin.query(`DROP TABLE "${metadataNamespace}".backfills`);
      await admin.query(`DROP TABLE "${metadataNamespace}".nontransactional_migrations`);
      await admin.query(`DROP TABLE "${metadataNamespace}".deployment_secrets`);
      await admin.query(`DROP TABLE "${metadataNamespace}".procedure_releases`);
      await admin.query(`DROP FUNCTION "${metadataNamespace}".fence_migrated_job_claim() CASCADE`);
      await admin.query(
        `ALTER TABLE IF EXISTS "${metadataNamespace}".jobs DROP COLUMN IF EXISTS claim_version, DROP COLUMN IF EXISTS lease_version`,
      );
      await admin.query(`DROP TABLE "${metadataNamespace}".deployment_trigger_bindings`);
      await removeComponentMetadata();
      await admin.query(`DELETE FROM "${metadataNamespace}".framework_migrations WHERE version >= 12`);
      await bootstrapDatabase({ connectionString, metadataNamespace, runtimeRole });
      expect(
        (
          await admin.query(
            `SELECT version, hash FROM "${metadataNamespace}".framework_migrations WHERE version < 12 ORDER BY version`,
          )
        ).rows,
      ).toEqual(eleventhVersion);
      const tenthVersion = (
        await admin.query(
          `SELECT version, hash FROM "${metadataNamespace}".framework_migrations WHERE version < 11 ORDER BY version`,
        )
      ).rows;
      await admin.query(`DROP TABLE "${metadataNamespace}".client_sessions`);
      await admin.query(
        `ALTER TABLE "${metadataNamespace}".connection_tickets DROP COLUMN namespace, DROP COLUMN version`,
      );
      await admin.query(`DROP TABLE "${metadataNamespace}".storage_receipts`);
      await admin.query(`ALTER TABLE "${metadataNamespace}".storage_intents DROP COLUMN event_job_id`);
      await admin.query(`ALTER TABLE "${metadataNamespace}".storage_intents DROP COLUMN cleanup_after`);
      await admin.query(`DROP TABLE "${metadataNamespace}".release_ingress`);
      await admin.query(`DROP TABLE "${metadataNamespace}".function_ownership`);
      await admin.query(`DROP TABLE "${metadataNamespace}".runtime_compatibility`);
      await admin.query(`DROP TABLE "${metadataNamespace}".backfill_rows`);
      await admin.query(`DROP TABLE "${metadataNamespace}".backfills`);
      await admin.query(`DROP TABLE "${metadataNamespace}".nontransactional_migrations`);
      await admin.query(`DROP TABLE "${metadataNamespace}".deployment_secrets`);
      await admin.query(`DROP TABLE "${metadataNamespace}".procedure_releases`);
      await admin.query(`DROP FUNCTION "${metadataNamespace}".fence_migrated_job_claim() CASCADE`);
      await admin.query(
        `ALTER TABLE IF EXISTS "${metadataNamespace}".jobs DROP COLUMN IF EXISTS claim_version, DROP COLUMN IF EXISTS lease_version`,
      );
      await admin.query(`DROP TABLE "${metadataNamespace}".deployment_trigger_bindings`);
      await removeComponentMetadata();
      await admin.query(`DELETE FROM "${metadataNamespace}".framework_migrations WHERE version >= 11`);
      await bootstrapDatabase({ connectionString, metadataNamespace, runtimeRole });
      expect(
        (
          await admin.query(
            `SELECT version, hash FROM "${metadataNamespace}".framework_migrations WHERE version < 11 ORDER BY version`,
          )
        ).rows,
      ).toEqual(tenthVersion);
      const ninthVersion = (
        await admin.query(
          `SELECT version, hash FROM "${metadataNamespace}".framework_migrations WHERE version < 10 ORDER BY version`,
        )
      ).rows;
      await admin.query(`DROP TABLE "${metadataNamespace}".client_sessions`);
      await admin.query(
        `ALTER TABLE "${metadataNamespace}".connection_tickets DROP COLUMN namespace, DROP COLUMN version`,
      );
      await admin.query(`DROP TABLE "${metadataNamespace}".storage_receipts`);
      await admin.query(`DROP TABLE "${metadataNamespace}".storage_intents`);
      await admin.query(`DROP TABLE "${metadataNamespace}".release_ingress`);
      await admin.query(`DROP TABLE "${metadataNamespace}".function_ownership`);
      await admin.query(`DROP TABLE "${metadataNamespace}".runtime_compatibility`);
      await admin.query(`DROP TABLE "${metadataNamespace}".backfill_rows`);
      await admin.query(`DROP TABLE "${metadataNamespace}".backfills`);
      await admin.query(`DROP TABLE "${metadataNamespace}".nontransactional_migrations`);
      await admin.query(`DROP TABLE "${metadataNamespace}".deployment_secrets`);
      await admin.query(`DROP TABLE "${metadataNamespace}".procedure_releases`);
      await admin.query(`DROP FUNCTION "${metadataNamespace}".fence_migrated_job_claim() CASCADE`);
      await admin.query(
        `ALTER TABLE IF EXISTS "${metadataNamespace}".jobs DROP COLUMN IF EXISTS claim_version, DROP COLUMN IF EXISTS lease_version`,
      );
      await admin.query(`DROP TABLE "${metadataNamespace}".deployment_trigger_bindings`);
      await removeComponentMetadata();
      await admin.query(`DELETE FROM "${metadataNamespace}".framework_migrations WHERE version >= 10`);
      await bootstrapDatabase({ connectionString, metadataNamespace, runtimeRole });
      expect(
        (
          await admin.query(
            `SELECT version, hash FROM "${metadataNamespace}".framework_migrations WHERE version < 10 ORDER BY version`,
          )
        ).rows,
      ).toEqual(ninthVersion);
      const eighthVersion = (
        await admin.query(
          `SELECT version, hash FROM "${metadataNamespace}".framework_migrations WHERE version < 9 ORDER BY version`,
        )
      ).rows;
      await admin.query(`DROP TABLE "${metadataNamespace}".client_sessions`);
      await admin.query(
        `ALTER TABLE "${metadataNamespace}".connection_tickets DROP COLUMN namespace, DROP COLUMN version`,
      );
      await admin.query(`DROP TABLE "${metadataNamespace}".storage_receipts`);
      await admin.query(`DROP TABLE "${metadataNamespace}".storage_intents`);
      await admin.query(`DROP TABLE "${metadataNamespace}".deployment_secrets`);
      await admin.query(`DROP TABLE "${metadataNamespace}".procedure_releases`);
      await admin.query(`DROP FUNCTION "${metadataNamespace}".fence_migrated_job_claim() CASCADE`);
      await admin.query(
        `ALTER TABLE IF EXISTS "${metadataNamespace}".jobs DROP COLUMN IF EXISTS claim_version, DROP COLUMN IF EXISTS lease_version`,
      );
      await admin.query(`DROP TABLE "${metadataNamespace}".deployment_trigger_bindings`);
      await admin.query(`DROP TABLE "${metadataNamespace}".deployment_activations`);
      await admin.query(`DROP TABLE "${metadataNamespace}".release_ingress`);
      await admin.query(`DROP TABLE "${metadataNamespace}".function_ownership`);
      await admin.query(`DROP TABLE "${metadataNamespace}".runtime_compatibility`);
      await admin.query(`DROP TABLE "${metadataNamespace}".backfill_rows`);
      await admin.query(`DROP TABLE "${metadataNamespace}".backfills`);
      await admin.query(`DROP TABLE "${metadataNamespace}".nontransactional_migrations`);
      await removeComponentMetadata();
      await admin.query(`DELETE FROM "${metadataNamespace}".framework_migrations WHERE version >= 9`);
      await bootstrapDatabase({ connectionString, metadataNamespace, runtimeRole });
      expect(
        (
          await admin.query(
            `SELECT version, hash FROM "${metadataNamespace}".framework_migrations WHERE version < 9 ORDER BY version`,
          )
        ).rows,
      ).toEqual(eighthVersion);
      const seventhVersion = (
        await admin.query(
          `SELECT version, hash FROM "${metadataNamespace}".framework_migrations WHERE version < 8 ORDER BY version`,
        )
      ).rows;
      await admin.query(`DROP TABLE "${metadataNamespace}".client_sessions`);
      await admin.query(
        `ALTER TABLE "${metadataNamespace}".connection_tickets DROP COLUMN namespace, DROP COLUMN version`,
      );
      await admin.query(`DROP TABLE "${metadataNamespace}".storage_receipts`);
      await admin.query(`DROP TABLE "${metadataNamespace}".storage_intents`);
      await admin.query(`DROP TABLE "${metadataNamespace}".trigger_receipts`);
      await admin.query(`DROP TABLE "${metadataNamespace}".deployment_secrets`);
      await admin.query(`DROP TABLE "${metadataNamespace}".procedure_releases`);
      await admin.query(`DROP FUNCTION "${metadataNamespace}".fence_migrated_job_claim() CASCADE`);
      await admin.query(
        `ALTER TABLE IF EXISTS "${metadataNamespace}".jobs DROP COLUMN IF EXISTS claim_version, DROP COLUMN IF EXISTS lease_version`,
      );
      await admin.query(`DROP TABLE "${metadataNamespace}".deployment_trigger_bindings`);
      await admin.query(`DROP TABLE "${metadataNamespace}".deployment_activations`);
      await admin.query(`DROP TABLE "${metadataNamespace}".release_ingress`);
      await admin.query(`DROP TABLE "${metadataNamespace}".function_ownership`);
      await admin.query(`DROP TABLE "${metadataNamespace}".runtime_compatibility`);
      await admin.query(`DROP TABLE "${metadataNamespace}".backfill_rows`);
      await admin.query(`DROP TABLE "${metadataNamespace}".backfills`);
      await admin.query(`DROP TABLE "${metadataNamespace}".nontransactional_migrations`);
      await removeComponentMetadata();
      await admin.query(`DELETE FROM "${metadataNamespace}".framework_migrations WHERE version >= 8`);
      await bootstrapDatabase({ connectionString, metadataNamespace, runtimeRole });
      expect(
        (
          await admin.query(
            `SELECT version, hash FROM "${metadataNamespace}".framework_migrations WHERE version < 8 ORDER BY version`,
          )
        ).rows,
      ).toEqual(seventhVersion);
      const sixthVersion = (
        await admin.query(
          `SELECT version, hash FROM "${metadataNamespace}".framework_migrations WHERE version < 7 ORDER BY version`,
        )
      ).rows;
      await admin.query(`DROP TABLE "${metadataNamespace}".client_sessions`);
      await admin.query(
        `ALTER TABLE "${metadataNamespace}".connection_tickets DROP COLUMN namespace, DROP COLUMN version`,
      );
      await admin.query(`DROP TABLE "${metadataNamespace}".storage_receipts`);
      await admin.query(`DROP TABLE "${metadataNamespace}".storage_intents`);
      await admin.query(`DROP TABLE "${metadataNamespace}".trigger_receipts`);
      await admin.query(`DROP TABLE "${metadataNamespace}".job_replays`);
      await admin.query(`DROP TABLE "${metadataNamespace}".deployment_secrets`);
      await admin.query(`DROP TABLE "${metadataNamespace}".procedure_releases`);
      await admin.query(`DROP FUNCTION "${metadataNamespace}".fence_migrated_job_claim() CASCADE`);
      await admin.query(
        `ALTER TABLE IF EXISTS "${metadataNamespace}".jobs DROP COLUMN IF EXISTS claim_version, DROP COLUMN IF EXISTS lease_version`,
      );
      await admin.query(`DROP TABLE "${metadataNamespace}".deployment_trigger_bindings`);
      await admin.query(`DROP TABLE "${metadataNamespace}".deployment_activations`);
      await admin.query(`DROP TABLE "${metadataNamespace}".release_ingress`);
      await admin.query(`DROP TABLE "${metadataNamespace}".function_ownership`);
      await admin.query(`DROP TABLE "${metadataNamespace}".runtime_compatibility`);
      await admin.query(`DROP TABLE "${metadataNamespace}".backfill_rows`);
      await admin.query(`DROP TABLE "${metadataNamespace}".backfills`);
      await admin.query(`DROP TABLE "${metadataNamespace}".nontransactional_migrations`);
      await removeComponentMetadata();
      await admin.query(`DELETE FROM "${metadataNamespace}".framework_migrations WHERE version >= 7`);
      await bootstrapDatabase({ connectionString, metadataNamespace, runtimeRole });
      expect(
        (
          await admin.query(
            `SELECT version, hash FROM "${metadataNamespace}".framework_migrations WHERE version < 7 ORDER BY version`,
          )
        ).rows,
      ).toEqual(sixthVersion);
      const fifthVersion = (
        await admin.query(
          `SELECT version, hash FROM "${metadataNamespace}".framework_migrations WHERE version < 6 ORDER BY version`,
        )
      ).rows;
      await admin.query(`DROP TABLE "${metadataNamespace}".client_sessions`);
      await admin.query(
        `ALTER TABLE "${metadataNamespace}".connection_tickets DROP COLUMN namespace, DROP COLUMN version`,
      );
      await admin.query(`DROP TABLE "${metadataNamespace}".storage_receipts`);
      await admin.query(`DROP TABLE "${metadataNamespace}".storage_intents`);
      await admin.query(`DROP TABLE "${metadataNamespace}".job_replays`);
      await admin.query(`DROP TABLE "${metadataNamespace}".trigger_receipts`);
      await admin.query(`DROP TABLE "${metadataNamespace}".jobs`);
      await admin.query(`DROP TABLE "${metadataNamespace}".deployment_secrets`);
      await admin.query(`DROP TABLE "${metadataNamespace}".procedure_releases`);
      await admin.query(`DROP FUNCTION "${metadataNamespace}".fence_migrated_job_claim() CASCADE`);
      await admin.query(
        `ALTER TABLE IF EXISTS "${metadataNamespace}".jobs DROP COLUMN IF EXISTS claim_version, DROP COLUMN IF EXISTS lease_version`,
      );
      await admin.query(`DROP TABLE "${metadataNamespace}".deployment_trigger_bindings`);
      await admin.query(`DROP TABLE "${metadataNamespace}".deployment_activations`);
      await admin.query(`DROP TABLE "${metadataNamespace}".release_ingress`);
      await admin.query(`DROP TABLE "${metadataNamespace}".function_ownership`);
      await admin.query(`DROP TABLE "${metadataNamespace}".runtime_compatibility`);
      await admin.query(`DROP TABLE "${metadataNamespace}".backfill_rows`);
      await admin.query(`DROP TABLE "${metadataNamespace}".backfills`);
      await admin.query(`DROP TABLE "${metadataNamespace}".nontransactional_migrations`);
      await removeComponentMetadata();
      await admin.query(`DELETE FROM "${metadataNamespace}".framework_migrations WHERE version >= 6`);
      await bootstrapDatabase({ connectionString, metadataNamespace, runtimeRole });
      expect(
        (
          await admin.query(
            `SELECT version, hash FROM "${metadataNamespace}".framework_migrations WHERE version < 6 ORDER BY version`,
          )
        ).rows,
      ).toEqual(fifthVersion);
      const fourthVersion = (
        await admin.query(
          `SELECT version, hash FROM "${metadataNamespace}".framework_migrations WHERE version < 5 ORDER BY version`,
        )
      ).rows;
      await admin.query(`DROP TABLE "${metadataNamespace}".client_sessions`);
      await admin.query(
        `ALTER TABLE "${metadataNamespace}".connection_tickets DROP COLUMN namespace, DROP COLUMN version`,
      );
      await admin.query(`DROP TABLE "${metadataNamespace}".storage_receipts`);
      await admin.query(`DROP TABLE "${metadataNamespace}".storage_intents`);
      await admin.query(`DROP TABLE "${metadataNamespace}".job_replays`);
      await admin.query(`DROP TABLE "${metadataNamespace}".trigger_receipts`);
      await admin.query(`DROP TABLE "${metadataNamespace}".jobs`);
      await admin.query(`DROP FUNCTION "${metadataNamespace}".advance_table_revision()`);
      await admin.query(`DROP TABLE "${metadataNamespace}".table_revisions`);
      await admin.query(`DROP TABLE "${metadataNamespace}".deployment_secrets`);
      await admin.query(`DROP TABLE "${metadataNamespace}".procedure_releases`);
      await admin.query(`DROP FUNCTION "${metadataNamespace}".fence_migrated_job_claim() CASCADE`);
      await admin.query(
        `ALTER TABLE IF EXISTS "${metadataNamespace}".jobs DROP COLUMN IF EXISTS claim_version, DROP COLUMN IF EXISTS lease_version`,
      );
      await admin.query(`DROP TABLE "${metadataNamespace}".deployment_trigger_bindings`);
      await admin.query(`DROP TABLE "${metadataNamespace}".deployment_activations`);
      await admin.query(`DROP TABLE "${metadataNamespace}".release_ingress`);
      await admin.query(`DROP TABLE "${metadataNamespace}".function_ownership`);
      await admin.query(`DROP TABLE "${metadataNamespace}".runtime_compatibility`);
      await admin.query(`DROP TABLE "${metadataNamespace}".backfill_rows`);
      await admin.query(`DROP TABLE "${metadataNamespace}".backfills`);
      await admin.query(`DROP TABLE "${metadataNamespace}".nontransactional_migrations`);
      await removeComponentMetadata();
      await admin.query(`DELETE FROM "${metadataNamespace}".framework_migrations WHERE version >= 5`);
      await bootstrapDatabase({ connectionString, metadataNamespace, runtimeRole });
      expect(
        (
          await admin.query(
            `SELECT version, hash FROM "${metadataNamespace}".framework_migrations WHERE version < 5 ORDER BY version`,
          )
        ).rows,
      ).toEqual(fourthVersion);
      const thirdVersion = (
        await admin.query(
          `SELECT version, hash FROM "${metadataNamespace}".framework_migrations WHERE version < 4 ORDER BY version`,
        )
      ).rows;
      await admin.query(`DROP TABLE "${metadataNamespace}".client_sessions`);
      await admin.query(
        `ALTER TABLE "${metadataNamespace}".connection_tickets DROP COLUMN namespace, DROP COLUMN version`,
      );
      await admin.query(`DROP TABLE "${metadataNamespace}".storage_receipts`);
      await admin.query(`DROP TABLE "${metadataNamespace}".storage_intents`);
      await admin.query(`DROP TABLE "${metadataNamespace}".connection_tickets`);
      await admin.query(`DROP TABLE "${metadataNamespace}".job_replays`);
      await admin.query(`DROP TABLE "${metadataNamespace}".trigger_receipts`);
      await admin.query(`DROP TABLE "${metadataNamespace}".jobs`);
      await admin.query(`DROP FUNCTION "${metadataNamespace}".advance_table_revision()`);
      await admin.query(`DROP TABLE "${metadataNamespace}".table_revisions`);
      await admin.query(`DROP TABLE "${metadataNamespace}".deployment_secrets`);
      await admin.query(`DROP TABLE "${metadataNamespace}".procedure_releases`);
      await admin.query(`DROP FUNCTION "${metadataNamespace}".fence_migrated_job_claim() CASCADE`);
      await admin.query(
        `ALTER TABLE IF EXISTS "${metadataNamespace}".jobs DROP COLUMN IF EXISTS claim_version, DROP COLUMN IF EXISTS lease_version`,
      );
      await admin.query(`DROP TABLE "${metadataNamespace}".deployment_trigger_bindings`);
      await admin.query(`DROP TABLE "${metadataNamespace}".deployment_activations`);
      await admin.query(`DROP TABLE "${metadataNamespace}".release_ingress`);
      await admin.query(`DROP TABLE "${metadataNamespace}".function_ownership`);
      await admin.query(`DROP TABLE "${metadataNamespace}".runtime_compatibility`);
      await admin.query(`DROP TABLE "${metadataNamespace}".backfill_rows`);
      await admin.query(`DROP TABLE "${metadataNamespace}".backfills`);
      await admin.query(`DROP TABLE "${metadataNamespace}".nontransactional_migrations`);
      await removeComponentMetadata();
      await admin.query(`DELETE FROM "${metadataNamespace}".framework_migrations WHERE version >= 4`);
      await bootstrapDatabase({ connectionString, metadataNamespace, runtimeRole });
      expect(
        (
          await admin.query(
            `SELECT version, hash FROM "${metadataNamespace}".framework_migrations WHERE version < 4 ORDER BY version`,
          )
        ).rows,
      ).toEqual(thirdVersion);
      const previousVersions = (
        await admin.query(
          `SELECT version, hash FROM "${metadataNamespace}".framework_migrations WHERE version < 3 ORDER BY version`,
        )
      ).rows;
      await admin.query(`DROP TABLE "${metadataNamespace}".client_sessions`);
      await admin.query(
        `ALTER TABLE "${metadataNamespace}".connection_tickets DROP COLUMN namespace, DROP COLUMN version`,
      );
      await admin.query(`DROP TABLE "${metadataNamespace}".storage_receipts`);
      await admin.query(`DROP TABLE "${metadataNamespace}".storage_intents`);
      await admin.query(`DROP TABLE "${metadataNamespace}".mutation_results`);
      await admin.query(`DROP TABLE "${metadataNamespace}".connection_tickets`);
      await admin.query(`DROP TABLE "${metadataNamespace}".job_replays`);
      await admin.query(`DROP TABLE "${metadataNamespace}".trigger_receipts`);
      await admin.query(`DROP TABLE "${metadataNamespace}".jobs`);
      await admin.query(`DROP FUNCTION "${metadataNamespace}".advance_table_revision()`);
      await admin.query(`DROP TABLE "${metadataNamespace}".table_revisions`);
      await admin.query(`DROP TABLE "${metadataNamespace}".deployment_secrets`);
      await admin.query(`DROP TABLE "${metadataNamespace}".procedure_releases`);
      await admin.query(`DROP FUNCTION "${metadataNamespace}".fence_migrated_job_claim() CASCADE`);
      await admin.query(
        `ALTER TABLE IF EXISTS "${metadataNamespace}".jobs DROP COLUMN IF EXISTS claim_version, DROP COLUMN IF EXISTS lease_version`,
      );
      await admin.query(`DROP TABLE "${metadataNamespace}".deployment_trigger_bindings`);
      await admin.query(`DROP TABLE "${metadataNamespace}".deployment_activations`);
      await admin.query(`DROP TABLE "${metadataNamespace}".release_ingress`);
      await admin.query(`DROP TABLE "${metadataNamespace}".function_ownership`);
      await admin.query(`DROP TABLE "${metadataNamespace}".runtime_compatibility`);
      await admin.query(`DROP TABLE "${metadataNamespace}".backfill_rows`);
      await admin.query(`DROP TABLE "${metadataNamespace}".backfills`);
      await admin.query(`DROP TABLE "${metadataNamespace}".nontransactional_migrations`);
      await removeComponentMetadata();
      await admin.query(`DELETE FROM "${metadataNamespace}".framework_migrations WHERE version >= 3`);
      await bootstrapDatabase({ connectionString, metadataNamespace, runtimeRole });
      expect(
        (
          await admin.query(
            `SELECT version, hash FROM "${metadataNamespace}".framework_migrations WHERE version < 3 ORDER BY version`,
          )
        ).rows,
      ).toEqual(previousVersions);
      const original = (
        await admin.query(`SELECT hash FROM "${metadataNamespace}".framework_migrations WHERE version = 1`)
      ).rows;
      await admin.query(`DROP TABLE "${metadataNamespace}".client_sessions`);
      await admin.query(
        `ALTER TABLE "${metadataNamespace}".connection_tickets DROP COLUMN namespace, DROP COLUMN version`,
      );
      await admin.query(`DROP TABLE "${metadataNamespace}".storage_receipts`);
      await admin.query(`DROP TABLE "${metadataNamespace}".storage_intents`);
      await admin.query(`DROP TABLE "${metadataNamespace}".development_history`);
      await admin.query(`DROP TABLE "${metadataNamespace}".mutation_results`);
      await admin.query(`DROP TABLE "${metadataNamespace}".connection_tickets`);
      await admin.query(`DROP TABLE "${metadataNamespace}".job_replays`);
      await admin.query(`DROP TABLE "${metadataNamespace}".trigger_receipts`);
      await admin.query(`DROP TABLE "${metadataNamespace}".jobs`);
      await admin.query(`DROP FUNCTION "${metadataNamespace}".advance_table_revision()`);
      await admin.query(`DROP TABLE "${metadataNamespace}".table_revisions`);
      await admin.query(`DROP TABLE "${metadataNamespace}".deployment_secrets`);
      await admin.query(`DROP TABLE "${metadataNamespace}".procedure_releases`);
      await admin.query(`DROP FUNCTION "${metadataNamespace}".fence_migrated_job_claim() CASCADE`);
      await admin.query(
        `ALTER TABLE IF EXISTS "${metadataNamespace}".jobs DROP COLUMN IF EXISTS claim_version, DROP COLUMN IF EXISTS lease_version`,
      );
      await admin.query(`DROP TABLE "${metadataNamespace}".deployment_trigger_bindings`);
      await admin.query(`DROP TABLE "${metadataNamespace}".deployment_activations`);
      await admin.query(`DROP TABLE "${metadataNamespace}".release_ingress`);
      await admin.query(`DROP TABLE "${metadataNamespace}".function_ownership`);
      await admin.query(`DROP TABLE "${metadataNamespace}".runtime_compatibility`);
      await admin.query(`DROP TABLE "${metadataNamespace}".backfill_rows`);
      await admin.query(`DROP TABLE "${metadataNamespace}".backfills`);
      await admin.query(`DROP TABLE "${metadataNamespace}".nontransactional_migrations`);
      await removeComponentMetadata();
      await admin.query(`DELETE FROM "${metadataNamespace}".framework_migrations WHERE version >= 2`);
      await bootstrapDatabase({ connectionString, metadataNamespace, runtimeRole });
      expect(
        (await admin.query(`SELECT hash FROM "${metadataNamespace}".framework_migrations WHERE version = 1`)).rows,
      ).toEqual(original);
      expect((await admin.query(`SELECT * FROM "${metadataNamespace}".development_history`)).rows).toEqual([]);
      // Neon does not automatically grant the creator SET ROLE on a new role.
      await admin.query(`GRANT "${runtimeRole}" TO CURRENT_USER`);
      await admin.query(`SET ROLE "${runtimeRole}"`);
      expect((await admin.query(`SELECT * FROM "${metadataNamespace}".connection_tickets`)).rows).toEqual([]);
      await assert.rejects(
        admin.query(`UPDATE "${metadataNamespace}".connection_tickets SET identity = '{}'::jsonb`),
        /permission denied/,
      );
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
