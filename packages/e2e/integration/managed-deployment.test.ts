import assert from "node:assert/strict";
import { test, expect } from "bun:test";
import pg from "pg";
import { bootstrapDatabase, defineConfig } from "kello/tooling";
import type { DeploymentDatabaseProvider } from "kello/tooling";
import { resolveManagedDeploymentCredentials } from "../../../apps/kello/src/tooling/deploy/neon/managed-credentials";

const connectionString = process.env.LOOM_TEST_DATABASE_URL;
test.skipIf(!connectionString)(
  "managed deployment credentials survive retries and remain inaccessible to runtime roles",
  async () => {
    assert(connectionString);
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const metadataNamespace = `loom_managed_${suffix}`;
    const runtimeRole = `loom_runtime_${suffix}`;
    const runtimePassword = crypto.randomUUID().replaceAll("-", "").repeat(2);
    const address = new URL(connectionString);
    const admin = new pg.Client({ connectionString });
    await admin.connect();
    const api: DeploymentDatabaseProvider = {
      getProject: async () => ({ id: "project", name: "test", regionId: "aws-us-east-2", pgVersion: 18 }),
      listBranches: async () => [{ id: "br-preview", name: "preview", protected: false, isDefault: false }],
      listEndpoints: async () => [
        {
          id: address.hostname.split(".")[0] ?? "",
          branchId: "br-preview",
          type: "read_write",
          autoscalingLimitMinCu: 0.25,
          autoscalingLimitMaxCu: 1,
          suspendTimeout: 300,
        },
      ],
      getConnectionUri: async (_project, input) => {
        if (input.roleName !== runtimeRole) return { uri: connectionString };
        await admin.query(`ALTER ROLE "${runtimeRole}" PASSWORD '${runtimePassword}'`);
        const runtime = new URL(connectionString);
        runtime.username = runtimeRole;
        runtime.password = runtimePassword;
        return { uri: runtime.href };
      },
    };
    const config = defineConfig({
      project: "test",
      database: { metadataNamespace },
      provider: { projectId: "project", targets: { preview: { branchId: "br-preview" } } },
    });
    const options = {
      environment: "preview" as const,
      databaseName: decodeURIComponent(address.pathname.slice(1)),
      migrationRole: decodeURIComponent(address.username),
      runtimeRole,
      deployment: "test",
      version: "a".repeat(64),
    };
    try {
      await bootstrapDatabase({ connectionString, metadataNamespace, runtimeRole });
      await admin.query(
        `DROP TABLE "${metadataNamespace}".rate_limit_buckets, "${metadataNamespace}".rate_limit_policies`,
      );
      await admin.query(`DROP TABLE "${metadataNamespace}".search_cursor_keys`);
      await admin.query(`DROP TABLE "${metadataNamespace}".deployment_secrets`);
      await admin.query(`ALTER TABLE "${metadataNamespace}".storage_intents DROP COLUMN owner_scope`);
      await admin.query(
        `DROP TABLE "${metadataNamespace}".component_namespaces, "${metadataNamespace}".runtime_scopes`,
      );
      await admin.query(`DELETE FROM "${metadataNamespace}".framework_migrations WHERE version>=24`);
      const before = (
        await admin.query(`SELECT version,hash FROM "${metadataNamespace}".framework_migrations ORDER BY version`)
      ).rows;
      const first = await resolveManagedDeploymentCredentials(config, options, api);
      expect(
        (
          await admin.query(
            `SELECT version,hash FROM "${metadataNamespace}".framework_migrations WHERE version<24 ORDER BY version`,
          )
        ).rows,
      ).toEqual(before);
      const resumed = await resolveManagedDeploymentCredentials(config, options, api);
      assert(
        resumed.runtimeUrl === first.runtimeUrl && resumed.activationToken === first.activationToken,
        "Managed credentials changed during retry",
      );
      assert(/^[a-f0-9]{64}$/.test(first.activationToken), "Invalid managed activation secret");
      const next = await resolveManagedDeploymentCredentials(config, { ...options, version: "b".repeat(64) }, api);
      assert(next.activationToken !== first.activationToken, "Distinct releases reused an activation secret");
      expect(
        (await admin.query("SELECT rolcanlogin FROM pg_roles WHERE rolname=$1", [runtimeRole])).rows[0]?.rolcanlogin,
      ).toBe(true);
      const runtime = new pg.Client({ connectionString: first.runtimeUrl });
      try {
        await runtime.connect();
        await assert.rejects(
          runtime.query(`SELECT * FROM "${metadataNamespace}".deployment_secrets`),
          /permission denied/,
        );
      } finally {
        await runtime.end();
      }
      await admin.query(`COMMENT ON ROLE "${runtimeRole}" IS NULL`);
      await admin.query(`REVOKE USAGE ON SCHEMA "${metadataNamespace}" FROM "${runtimeRole}"`);
      await assert.rejects(resolveManagedDeploymentCredentials(config, options, api), /managed runtime role/);
      expect(
        (await admin.query("SELECT has_schema_privilege($1,$2,'USAGE') AS allowed", [runtimeRole, metadataNamespace]))
          .rows[0]?.allowed,
      ).toBe(false);
    } finally {
      await admin.query("RESET ROLE");
      await admin.query(`DROP SCHEMA IF EXISTS "${metadataNamespace}" CASCADE`);
      await admin.query(`DROP ROLE IF EXISTS "${runtimeRole}"`);
      await admin.end();
    }
  },
  120000,
);
