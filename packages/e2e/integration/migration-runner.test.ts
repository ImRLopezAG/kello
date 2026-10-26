import assert from "node:assert/strict";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineSchema } from "kello/server";
import {
  applyMigrationsOnConnection,
  inspectReleaseDatabase,
  withDeploymentActivationSessionOnConnection,
  withDeploymentConnection,
  defineConfig,
  applyMigrations,
  emptySnapshot,
  planMigration,
  writeMigration,
  migrationStatus,
} from "kello-cli";
import pg from "pg";
import type { DeploymentDatabaseProvider } from "kello-cli";
import { catalogFingerprint } from "../../../apps/kello-cli/src/tooling/migrations/drift";

const connectionString = process.env.LOOM_TEST_DATABASE_URL;
test.skipIf(!connectionString)(
  "locked ORM migrations apply once, roll back failed upgrades, preserve runtime boundaries and reject drift",
  async () => {
    if (!connectionString) throw new Error("Missing test database");
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const namespace = `app_${suffix}`;
    const metadataNamespace = `loom_meta_${suffix}`;
    const runtimeRole = `loom_runtime_${suffix}`;
    const root = await mkdtemp(join(tmpdir(), "loom-runner-"));
    const admin = new pg.Client({ connectionString });
    await admin.connect();
    await admin.query("SET search_path = pg_catalog");
    const options = { connectionString, root, migrations: "migrations", namespace, metadataNamespace, runtimeRole };
    try {
      const schema = defineSchema((f) => ({ tasks: { title: f.text() } }), { namespace });
      const initial = await planMigration(await emptySnapshot(namespace), schema);
      await writeMigration(root, "migrations", "initial", initial);
      const statusOptions = { connectionString, root, migrations: "migrations", namespace, metadataNamespace };
      const untouched = await migrationStatus(statusOptions);
      expect(untouched.initialized).toBe(false);
      expect(untouched.pending.map((artifact) => artifact.hash)).toEqual([initial.hash]);
      expect((await admin.query("SELECT 1 FROM pg_namespace WHERE nspname = $1", [metadataNamespace])).rows).toEqual(
        [],
      );
      await assert.rejects(applyMigrations({ ...options, expectedHashes: [] }), /Release migration history changed/);
      expect((await migrationStatus(statusOptions)).initialized).toBe(false);
      const receipts = await Promise.all([
        applyMigrations({ ...options, expectedHashes: [initial.hash] }),
        applyMigrations(options),
      ]);
      expect(receipts.flatMap((receipt) => receipt.applied)).toEqual([initial.hash]);
      expect((await migrationStatus(statusOptions)).applied).toEqual([initial.hash]);
      expect((await admin.query(`SELECT ordinal FROM "${metadataNamespace}".migration_history`)).rows).toEqual([
        { ordinal: 1 },
      ]);
      await admin.query(`SET ROLE "${runtimeRole}"`);
      await admin.query(`INSERT INTO "${namespace}".tasks (title) VALUES (NULL)`);
      expect((await admin.query(`SELECT title FROM "${namespace}".tasks`)).rows).toEqual([{ title: null }]);
      expect(
        (await admin.query("SELECT to_regclass($1) AS revisions", [`${metadataNamespace}.table_revisions`])).rows,
      ).toEqual([{ revisions: null }]);
      await assert.rejects(admin.query(`ALTER TABLE "${namespace}".tasks ADD COLUMN forbidden text`), /owner/);
      await assert.rejects(admin.query(`UPDATE "${namespace}".tasks SET "_createdAt" = 0`), /immutable/);
      await admin.query("RESET ROLE");
      const required = await planMigration(
        initial.snapshot,
        defineSchema((f) => ({ tasks: { title: f.text().notNull() } }), { namespace }),
        [],
        initial.hash,
      );
      await writeMigration(root, "migrations", "require_title", required);
      await assert.rejects(applyMigrations(options), /requires review/);
      const reviewed = { ...options, reviewedHashes: [required.hash] };
      await assert.rejects(applyMigrations(reviewed));
      expect((await admin.query(`SELECT ordinal FROM "${metadataNamespace}".migration_history`)).rows).toEqual([
        { ordinal: 1 },
      ]);
      expect(
        (
          await admin.query<{ is_nullable: string }>(
            "SELECT is_nullable FROM information_schema.columns WHERE table_schema=$1 AND table_name='tasks' AND column_name='title'",
            [namespace],
          )
        ).rows[0]?.is_nullable,
      ).toBe("YES");
      const address = new URL(connectionString);
      const endpointId = address.hostname.split(".")[0] ?? "";
      const api: DeploymentDatabaseProvider = {
        getProject: async () => ({ id: "project", name: "tasks", regionId: "aws-us-east-2", pgVersion: 18 }),
        listBranches: async () => [{ id: "br-preview", name: "preview", protected: false, isDefault: false }],
        listEndpoints: async () => [
          {
            id: endpointId,
            branchId: "br-preview",
            type: "read_write",
            autoscalingLimitMinCu: 0.25,
            autoscalingLimitMaxCu: 1,
            suspendTimeout: 300,
          },
        ],
        getConnectionUri: async () => ({ uri: connectionString }),
      };
      const sessionOptions = {
        root,
        migrations: "migrations",
        namespace,
        metadataNamespace,
        runtimeRole,
        reviewedHashes: [required.hash],
      };
      await assert.rejects(applyMigrationsOnConnection(admin, sessionOptions), /owned migration connection/i);
      const deploymentOptions = {
        config: defineConfig({
          project: "tasks",
          database: { namespace, metadataNamespace },
          provider: { projectId: "project", targets: { preview: { branchId: "br-preview" } } },
        }),
        environment: "preview" as const,
        databaseName: decodeURIComponent(address.pathname.slice(1)),
        migrationRole: decodeURIComponent(address.username),
      };
      const releaseSchema = {
        migrations: "migrations",
        namespace,
        migrationHashes: [initial.hash, required.hash],
        schema: { minimum: initial.after, maximum: required.after, target: required.after },
      };
      const closedClient = await withDeploymentConnection(
        deploymentOptions,
        async (client) => {
          await assert.rejects(inspectReleaseDatabase(admin, root, releaseSchema), /owned deployment connection/i);
          await assert.rejects(inspectReleaseDatabase(client, root, releaseSchema), /not at the release schema/i);
          await assert.rejects(
            applyMigrationsOnConnection(client, { ...sessionOptions, reviewedHashes: [] }),
            /requires review/,
          );
          await assert.rejects(applyMigrationsOnConnection(client, sessionOptions));
          expect((await client.query(`SELECT ordinal FROM "${metadataNamespace}".migration_history`)).rows).toEqual([
            { ordinal: 1 },
          ]);
          await admin.query(`UPDATE "${namespace}".tasks SET title = 'backfilled'`);
          expect((await applyMigrationsOnConnection(client, sessionOptions)).applied).toEqual([required.hash]);
          expect((await applyMigrationsOnConnection(client, sessionOptions)).applied).toEqual([]);
          const live = await inspectReleaseDatabase(client, root, releaseSchema);
          expect(live.head).toBe(required.after);
          expect(live.target.branchId).toBe("br-preview");
          expect(live.metadataNamespace).toBe(metadataNamespace);
          expect(live.catalogHash).toBe(await catalogFingerprint(admin, namespace));
          await assert.rejects(
            inspectReleaseDatabase(client, root, { ...releaseSchema, namespace: "other" }),
            /namespace/i,
          );
          await admin.query(`ALTER TABLE "${namespace}".tasks ADD COLUMN outside_release text`);
          await assert.rejects(inspectReleaseDatabase(client, root, releaseSchema), /inconsistent/i);
          await admin.query(`ALTER TABLE "${namespace}".tasks DROP COLUMN outside_release`);
          expect((await inspectReleaseDatabase(client, root, releaseSchema)).head).toBe(required.after);
          for (const lock of [`loom:deployment:${metadataNamespace}`, `loom:migrations:${namespace}`]) {
            expect(
              (
                await admin.query<{ acquired: boolean }>(
                  "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired",
                  [lock],
                )
              ).rows[0]?.acquired,
            ).toBe(false);
          }
          return client;
        },
        api,
      );
      await assert.rejects(applyMigrationsOnConnection(closedClient, sessionOptions), /owned migration connection/i);
      await assert.rejects(inspectReleaseDatabase(closedClient, root, releaseSchema), /owned deployment connection/i);
      expect((await applyMigrations(reviewed)).applied).toEqual([]);
      const upgraded = await catalogFingerprint(admin, namespace);
      await admin.query(`DROP SCHEMA "${namespace}" CASCADE`);
      await admin.query(`DROP SCHEMA "${metadataNamespace}" CASCADE`);
      const activationOptions = { deployment: "preview", version: "a".repeat(64), activationToken: "b".repeat(64) };
      await assert.rejects(
        withDeploymentActivationSessionOnConnection(admin, activationOptions, async () => {}),
        /owned deployment connection/i,
      );
      await assert.rejects(
        withDeploymentActivationSessionOnConnection(closedClient, activationOptions, async () => {}),
        /owned deployment connection/i,
      );
      const releaseAbort = new AbortController();
      const grant = await withDeploymentConnection(
        { ...deploymentOptions, signal: releaseAbort.signal },
        async (client) => {
          await assert.rejects(
            withDeploymentActivationSessionOnConnection(client, activationOptions, async () => {}),
            /metadata owner/i,
          );
          expect((await applyMigrationsOnConnection(client, sessionOptions)).applied).toEqual([
            initial.hash,
            required.hash,
          ]);
          await assert.rejects(
            withDeploymentActivationSessionOnConnection(
              client,
              { ...activationOptions, signal: AbortSignal.abort() },
              async () => {
                assert.fail("aborted callback ran");
              },
            ),
            /aborted/i,
          );
          return withDeploymentActivationSessionOnConnection(client, activationOptions, async (session, sameClient) => {
            expect(sameClient).toBe(client);
            expect(session.binding.metadataNamespace).toBe(metadataNamespace);
            expect(session.binding.branchId).toBe("br-preview");
            expect((await session.prepare()).state).toBe("quarantined");
            await assert.rejects(session.assertActive(), /not active/i);
            await session.activate();
            await session.assertActive();
            releaseAbort.abort();
            await assert.rejects(session.assertActive(), /aborted/i);
            await assert.rejects(inspectReleaseDatabase(client, root, releaseSchema), /aborted/i);
            return session;
          });
        },
        api,
      );
      await assert.rejects(grant.assertActive(), /closed/i);
      expect(await catalogFingerprint(admin, namespace)).toBe(upgraded);
      await admin.query(`ALTER TABLE "${namespace}".tasks ADD COLUMN unmanaged text`);
      await assert.rejects(applyMigrations(reviewed), /drift/);
      expect((await migrationStatus(statusOptions)).issues).toContain("LIVE_DRIFT");
      await admin.query(`UPDATE "${metadataNamespace}".framework_migrations SET hash = repeat('0', 64)`);
      expect((await migrationStatus(statusOptions)).issues).toContain("FRAMEWORK_HISTORY_DIVERGED");
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
