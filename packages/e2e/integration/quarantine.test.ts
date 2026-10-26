import assert from "node:assert/strict";
import { expect, test } from "bun:test";
import pg from "pg";
import {
  prepareDeploymentActivation,
  activateDeploymentDatabase,
  bootstrapDatabase,
  defineConfig,
  quarantinePreviewDatabase,
  withDeploymentConnection,
  withDeploymentActivationSession,
} from "kello-cli";
import type { DeploymentDatabaseProvider } from "kello-cli";

const connectionString = process.env.LOOM_TEST_DATABASE_URL;
test.skipIf(!connectionString)(
  "preview quarantine revokes grants and fences copied jobs atomically on a verified target",
  async () => {
    if (!connectionString) throw new Error("Missing test database");
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const metadataNamespace = `loom_${suffix}`;
    const runtimeRole = `runtime_${suffix}`;
    const admin = new pg.Client({ connectionString });
    await admin.connect();
    try {
      await bootstrapDatabase({ connectionString, metadataNamespace, runtimeRole });
      const address = new URL(connectionString);
      const endpointId = address.hostname.split(".")[0] ?? "";
      const branch = { id: "br-preview", name: "preview", protected: false, isDefault: false };
      const endpoint = {
        id: endpointId,
        branchId: branch.id,
        type: "read_write" as const,
        autoscalingLimitMinCu: 0.25,
        autoscalingLimitMaxCu: 1,
        suspendTimeout: 300,
      } satisfies Awaited<ReturnType<DeploymentDatabaseProvider["listEndpoints"]>>[number];
      const api: DeploymentDatabaseProvider = {
        getProject: async () => ({ id: "project", name: "tasks", regionId: "aws-us-east-2", pgVersion: 18 }),
        listBranches: async () => [branch],
        listEndpoints: async () => [endpoint],
        getConnectionUri: async () => ({ uri: connectionString }),
      };
      const config = defineConfig({
        project: "tasks",
        database: { metadataNamespace },
        provider: { projectId: "project", targets: { preview: { branchId: branch.id } } },
      });
      const options = {
        config,
        environment: "preview" as const,
        databaseName: decodeURIComponent(address.pathname.slice(1)),
        migrationRole: decodeURIComponent(address.username),
      };
      const version = "b".repeat(64);
      await admin.query(
        `INSERT INTO "${metadataNamespace}".deployment_activations
      (deployment, version, project_id, branch_id, endpoint_host, database_name, token_hash, state)
      VALUES ('original', $1, 'project', 'br-original', 'ep-original.example', 'neondb', $1, 'active')`,
        [version],
      );
      await admin.query(`INSERT INTO "${metadataNamespace}".jobs
      (id, deployment, deduplication_key, fingerprint, call, identity, due_at, max_attempts, retry_delay_seconds, state, attempts, lease_owner, lease_expires_at, fencing_token)
      SELECT uuidv7(), 'original', state, repeat('a', 64), '{}'::jsonb, 'null'::jsonb, clock_timestamp(), 2, 1, state,
        CASE WHEN state = 'running' THEN 1 ELSE 0 END,
        CASE WHEN state = 'running' THEN 'old-worker' END,
        CASE WHEN state = 'running' THEN clock_timestamp() + interval '30 seconds' END, 1
      FROM unnest(ARRAY['pending', 'running', 'succeeded']) AS state`);
      const grantOptions = { ...options, deployment: "preview", version, activationToken: "c".repeat(64) };
      await assert.rejects(prepareDeploymentActivation(grantOptions, api), /preparation failed/i);
      await admin.query(`UPDATE "${metadataNamespace}".deployment_activations SET state = 'quarantined'`);
      await assert.rejects(prepareDeploymentActivation(grantOptions, api), /preparation failed/i);
      const productionConfig = defineConfig({
        ...config,
        provider: { projectId: "project", targets: { production: { branchId: branch.id } } },
      });
      await assert.rejects(
        prepareDeploymentActivation({ ...grantOptions, config: productionConfig, environment: "production" }, api),
        /preparation failed/i,
      );
      await admin.query(`UPDATE "${metadataNamespace}".deployment_activations SET state = 'active'`);
      await admin.query(
        `ALTER TABLE "${metadataNamespace}".jobs ADD CONSTRAINT refuse_cancel CHECK (state <> 'cancelled')`,
      );
      await assert.rejects(quarantinePreviewDatabase(options, api), /quarantine transaction failed/);
      expect((await admin.query(`SELECT state FROM "${metadataNamespace}".deployment_activations`)).rows).toEqual([
        { state: "active" },
      ]);
      await admin.query(`ALTER TABLE "${metadataNamespace}".jobs DROP CONSTRAINT refuse_cancel`);
      await admin.query(`ALTER ROLE "${runtimeRole}" LOGIN PASSWORD 'loom-test-only'`);
      const runtimeAddress = new URL(connectionString);
      runtimeAddress.username = runtimeRole;
      runtimeAddress.password = "loom-test-only";
      api.getConnectionUri = async () => ({ uri: runtimeAddress.href });
      await assert.rejects(
        quarantinePreviewDatabase({ ...options, migrationRole: runtimeRole }, api),
        /metadata owner/,
      );
      api.getConnectionUri = async () => ({ uri: connectionString });
      await withDeploymentActivationSession(
        { ...grantOptions, config: productionConfig, environment: "production" },
        async (session) => {
          await assert.rejects(session.quarantinePreview(), /explicit preview/i);
        },
        api,
      );
      const first = await withDeploymentActivationSession(
        grantOptions,
        async (session) => {
          const result = await session.quarantinePreview();
          expect((await session.prepare()).state).toBe("quarantined");
          return result;
        },
        api,
      );
      expect(first).toMatchObject({ branchId: "br-preview", revokedGrants: 1, cancelledJobs: 2 });
      expect((await admin.query(`SELECT state FROM "${metadataNamespace}".deployment_activations`)).rows).toEqual([
        { state: "quarantined" },
        { state: "quarantined" },
      ]);
      expect(
        (
          await admin.query(
            `SELECT state, fencing_token::integer AS token, lease_owner, cancel_requested FROM "${metadataNamespace}".jobs ORDER BY deduplication_key`,
          )
        ).rows,
      ).toEqual([
        { state: "cancelled", token: 2, lease_owner: null, cancel_requested: true },
        { state: "cancelled", token: 2, lease_owner: null, cancel_requested: true },
        { state: "succeeded", token: 1, lease_owner: null, cancel_requested: false },
      ]);
      expect(await quarantinePreviewDatabase(options, api)).toMatchObject({ revokedGrants: 0, cancelledJobs: 0 });

      const prepared = await prepareDeploymentActivation(grantOptions, api);
      expect(prepared.state).toBe("quarantined");
      expect(prepared.binding).toMatchObject({
        branchId: "br-preview",
        branchName: "preview",
        deployment: "preview",
        version,
      });
      expect(JSON.stringify(prepared)).not.toContain(grantOptions.activationToken);
      expect(await prepareDeploymentActivation(grantOptions, api)).toEqual(prepared);
      await assert.rejects(
        prepareDeploymentActivation({ ...grantOptions, activationToken: "d".repeat(64) }, api),
        /preparation failed/i,
      );
      await assert.rejects(
        activateDeploymentDatabase(
          { ...grantOptions, binding: prepared.binding, activationToken: "d".repeat(64) },
          api,
        ),
        /activation failed/i,
      );
      await admin.query(
        `UPDATE "${metadataNamespace}".jobs SET state = 'pending', cancel_requested = FALSE WHERE deduplication_key = 'pending'`,
      );
      await assert.rejects(
        activateDeploymentDatabase({ ...grantOptions, binding: prepared.binding }, api),
        /activation failed/i,
      );
      await admin.query(
        `UPDATE "${metadataNamespace}".jobs SET state = 'cancelled', cancel_requested = TRUE WHERE deduplication_key = 'pending'`,
      );
      branch.name = "renamed";
      await assert.rejects(activateDeploymentDatabase({ ...grantOptions, binding: prepared.binding }, api), /binding/i);
      branch.name = "preview";
      const activated = await activateDeploymentDatabase({ ...grantOptions, binding: prepared.binding }, api);
      expect(activated).toEqual({ ...prepared, state: "active" });
      expect(await activateDeploymentDatabase({ ...grantOptions, binding: prepared.binding }, api)).toEqual(activated);
      expect(
        (
          await admin.query(
            `SELECT state FROM "${metadataNamespace}".deployment_activations WHERE deployment = 'preview'`,
          )
        ).rows,
      ).toEqual([{ state: "active" }]);
      await admin.query(
        `UPDATE "${metadataNamespace}".jobs SET state = 'pending', cancel_requested = FALSE WHERE deduplication_key = 'pending'`,
      );
      const nextOptions = { ...grantOptions, version: "e".repeat(64), activationToken: "f".repeat(64) };
      const nextGrant = await prepareDeploymentActivation(nextOptions, api);
      expect(nextGrant.state).toBe("quarantined");
      expect((await activateDeploymentDatabase({ ...nextOptions, binding: nextGrant.binding }, api)).state).toBe(
        "active",
      );
      const sessionOptions = { ...grantOptions, version: "1".repeat(64), activationToken: "2".repeat(64) };
      const expiredSession = await withDeploymentActivationSession(
        sessionOptions,
        async (session, client) => {
          expect((await client.query("SELECT current_database() AS name")).rows[0].name).toBe(options.databaseName);
          const lock = await admin.query<{ acquired: boolean }>(
            "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired",
            [`loom:deployment:${metadataNamespace}`],
          );
          expect(lock.rows[0]?.acquired).toBe(false);
          await assert.rejects(session.assertActive(), /not active/i);
          expect((await session.prepare()).state).toBe("quarantined");
          await assert.rejects(session.assertActive(), /not active/i);
          expect((await session.activate()).state).toBe("active");
          await session.assertActive();
          const checking = session.assertActive();
          await assert.rejects(session.prepare(), /sequentially/i);
          await checking;
          await assert.rejects(session.assertActive(AbortSignal.abort()), /aborted/i);
          await admin.query(
            `UPDATE "${metadataNamespace}".deployment_activations SET branch_id = 'br-other' WHERE version = $1`,
            [sessionOptions.version],
          );
          await assert.rejects(session.assertActive(), /not active/i);
          await admin.query(
            `UPDATE "${metadataNamespace}".deployment_activations SET branch_id = 'br-preview' WHERE version = $1`,
            [sessionOptions.version],
          );
          await admin.query(
            `UPDATE "${metadataNamespace}".deployment_activations SET state = 'quarantined' WHERE version = $1`,
            [sessionOptions.version],
          );
          await assert.rejects(session.assertActive(), /not active/i);
          expect((await session.activate()).state).toBe("active");
          await admin.query(
            `UPDATE "${metadataNamespace}".deployment_activations SET token_hash = $1 WHERE version = $2`,
            ["3".repeat(64), sessionOptions.version],
          );
          await assert.rejects(session.assertActive(), /not active/i);
          await assert.rejects(session.activate(), /activation failed/i);
          return session;
        },
        api,
      );
      await assert.rejects(expiredSession.quarantinePreview(), /closed/i);
      await assert.rejects(expiredSession.prepare(), /closed/i);
      await assert.rejects(expiredSession.activate(), /closed/i);
      await assert.rejects(expiredSession.assertActive(), /closed/i);
      await assert.rejects(
        withDeploymentActivationSession(
          sessionOptions,
          async (session) => {
            await session.prepare();
          },
          api,
        ),
        /preparation failed/i,
      );
      const released = await admin.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired",
        [`loom:deployment:${metadataNamespace}`],
      );
      expect(released.rows[0]?.acquired).toBe(true);
      await admin.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [`loom:deployment:${metadataNamespace}`]);
      await admin.query(
        `UPDATE "${metadataNamespace}".deployment_activations SET state = 'retired' WHERE version = $1 AND deployment = 'preview'`,
        [grantOptions.version],
      );
      await withDeploymentActivationSession(
        grantOptions,
        async (session) => {
          await assert.rejects(session.inspect(), /retired/i);
          await assert.rejects(session.prepare(), /preparation failed/i);
          await assert.rejects(session.activate(), /activation failed/i);
          await assert.rejects(session.assertActive(), /not active/i);
        },
        api,
      );
      await assert.rejects(prepareDeploymentActivation(grantOptions, api), /preparation failed/i);
      await assert.rejects(
        activateDeploymentDatabase({ ...grantOptions, binding: prepared.binding }, api),
        /activation failed/i,
      );
      expect(
        (
          await admin.query(
            `SELECT state FROM "${metadataNamespace}".deployment_activations WHERE version = $1 AND deployment = 'preview'`,
            [grantOptions.version],
          )
        ).rows,
      ).toEqual([{ state: "retired" }]);
      let reads = 0;
      let ran = false;
      api.listBranches = async () => [{ ...branch, name: ++reads > 1 ? "renamed" : branch.name }];
      await assert.rejects(
        withDeploymentConnection(
          options,
          async () => {
            ran = true;
          },
          api,
        ),
        /target changed/i,
      );
      expect(ran).toBe(false);
      api.listBranches = async () => [branch];
      api.getConnectionUri = async () => ({ uri: connectionString.replace(address.hostname, "wrong.example.test") });
      await assert.rejects(quarantinePreviewDatabase(options, api), /connection/i);
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS "${metadataNamespace}" CASCADE`);
      await admin.query(`DROP ROLE IF EXISTS "${runtimeRole}"`);
      await admin.end();
    }
  },
);
