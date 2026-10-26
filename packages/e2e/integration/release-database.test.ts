import { initializeProject } from "kello-cli";
import assert from "node:assert/strict";
import { expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, symlink, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  bootstrapDatabase,
  defineConfig,
  generateRelease,
  generateCustomRelease,
  applyMigrations,
  loadProject,
  withNeonReleaseDatabase,
  declareProjectCompatibility,
} from "kello-cli";
import type { DeploymentDatabaseProvider } from "kello-cli";

const connectionString = process.env.LOOM_TEST_DATABASE_URL;
test.skipIf(!connectionString)(
  "database release resumes verified stages and preserves active branch work",
  async () => {
    if (!connectionString) throw new Error("Missing test database");
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const namespace = `app_${suffix}`;
    const metadataNamespace = `loom_meta_${suffix}`;
    const runtimeRole = `loom_runtime_${suffix}`;
    const root = await mkdtemp(join(tmpdir(), "loom-release-db-"));
    const admin = new pg.Client({ connectionString });
    await admin.connect();
    const address = new URL(connectionString);
    const api: DeploymentDatabaseProvider = {
      getProject: async () => ({ id: "project", name: "tasks", regionId: "aws-us-east-2", pgVersion: 18 }),
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
      getConnectionUri: async () => ({ uri: connectionString }),
    };
    try {
      await initializeProject(root, "release-fixture");
      await mkdir(join(root, "node_modules/@kello"), { recursive: true });
      for (const name of ["kello", "valibot", "drizzle-orm"])
        await symlink(
          await realpath(fileURLToPath(new URL(`../../tests/node_modules/${name}`, import.meta.url))),
          join(root, "node_modules", name),
        );
      const config = defineConfig({
        project: "release-fixture",
        database: { namespace, metadataNamespace },
        provider: { projectId: "project", targets: { preview: { branchId: "br-preview" } } },
      });
      await writeFile(
        join(root, "kello.config.ts"),
        `import { defineConfig } from "kello-cli"; export default defineConfig(${JSON.stringify(config)});`,
      );
      const schemaFile = join(root, "kello/schema.ts");
      await writeFile(
        schemaFile,
        (await readFile(schemaFile, "utf8")).replace('namespace: "app"', `namespace: "${namespace}"`),
      );
      const artifact = await generateRelease(root, "initial");
      const project = await loadProject(root);
      const options = {
        releaseKey: "a".repeat(64),
        inputHash: "b".repeat(64),
        deployment: "preview",
        version: project.version,
        activationToken: "c".repeat(64),
        environment: "preview" as const,
        databaseName: decodeURIComponent(address.pathname.slice(1)),
        migrationRole: decodeURIComponent(address.username),
        runtimeRole,
        quarantine: "clone" as const,
        reviewedHashes: [],
        migrationHashes: [artifact.plan.hash],
        schema: { minimum: artifact.plan.after, maximum: artifact.plan.after, target: artifact.plan.after },
      };
      await assert.rejects(
        withNeonReleaseDatabase(root, { ...options, version: "d".repeat(64) }, async () => {}, api),
        /source version/i,
      );
      expect((await admin.query("SELECT 1 FROM pg_namespace WHERE nspname = $1", [metadataNamespace])).rowCount).toBe(
        0,
      );
      await assert.rejects(
        withNeonReleaseDatabase(root, { ...options, environment: "production" }, async () => {}, api),
        /cannot quarantine/i,
      );
      const abort = new AbortController();
      abort.abort(new Error("release cancelled"));
      await assert.rejects(
        withNeonReleaseDatabase(root, { ...options, signal: abort.signal }, async () => {}, api),
        /release cancelled/,
      );
      await bootstrapDatabase({ connectionString, metadataNamespace, runtimeRole });
      await admin.query(`INSERT INTO "${metadataNamespace}".deployment_activations
        (deployment, version, project_id, branch_id, endpoint_host, database_name, token_hash, state)
        VALUES ('copied', repeat('d', 64), 'project', 'br-parent', 'parent.example', 'postgres', repeat('e', 64), 'active')`);
      await admin.query(`INSERT INTO "${metadataNamespace}".jobs (id, deployment, deduplication_key, fingerprint, call, identity, due_at, max_attempts, retry_delay_seconds)
        VALUES (gen_random_uuid(), 'copied', 'copied', repeat('a', 64), '{}', '{}', now(), 1, 0)`);
      await assert.rejects(
        withNeonReleaseDatabase(
          root,
          options,
          async ({ journal, activation, database }) => {
            expect(journal.read().completed.map((stage) => stage.stage)).toEqual([
              "metadata",
              "quarantine",
              "migrations",
              "prepared",
            ]);
            expect(database.head).toBe(artifact.plan.after);
            expect(journal.read().completed.find((entry) => entry.stage === "quarantine")).toEqual({
              stage: "quarantine",
              revokedGrants: 1,
              cancelledJobs: 1,
            });
            expect(
              (await admin.query(`SELECT state FROM "${metadataNamespace}".jobs WHERE deployment = 'copied'`)).rows,
            ).toEqual([{ state: "cancelled" }]);
            expect((await activation.inspect()).state).toBe("quarantined");
            await activation.activate();
            throw new Error("provider interrupted after database preparation");
          },
          api,
        ),
        /provider interrupted/,
      );
      await admin.query(
        `INSERT INTO "${metadataNamespace}".jobs (id, deployment, deduplication_key, fingerprint, call, identity, due_at, max_attempts, retry_delay_seconds) VALUES (gen_random_uuid(), 'preview', 'keep', repeat('a', 64), '{}', '{}', now(), 1, 0)`,
      );
      const saved = await withNeonReleaseDatabase(
        root,
        options,
        async ({ activation, client, journal }) => {
          expect((await activation.inspect()).state).toBe("active");
          await activation.assertActive();
          expect(
            (await client.query(`SELECT state FROM "${metadataNamespace}".jobs WHERE deployment = 'preview'`)).rows,
          ).toEqual([{ state: "pending" }]);
          expect(
            (
              await admin.query("SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired", [
                `loom:deployment:${metadataNamespace}`,
              ])
            ).rows,
          ).toEqual([{ acquired: false }]);
          return journal.read();
        },
        api,
      );
      // Simulate a process losing its migration acknowledgement after the database committed.
      saved.completed = saved.completed.slice(0, 2);
      await writeFile(join(root, ".kello/releases", options.releaseKey, "release.json"), JSON.stringify(saved));
      await withNeonReleaseDatabase(
        root,
        options,
        async ({ activation, client }) => {
          expect((await activation.inspect()).state).toBe("active");
          expect((await client.query(`SELECT ordinal FROM "${metadataNamespace}".migration_history`)).rows).toEqual([
            { ordinal: 1 },
          ]);
          expect(
            (await client.query(`SELECT state FROM "${metadataNamespace}".jobs WHERE deployment = 'preview'`)).rows,
          ).toEqual([{ state: "pending" }]);
        },
        api,
      );
      await withNeonReleaseDatabase(
        root,
        { ...options, releaseKey: "1".repeat(64), deployment: "next", quarantine: "preserve" },
        async ({ activation, client }) => {
          expect((await activation.inspect()).state).toBe("quarantined");
          expect(
            (await client.query(`SELECT state FROM "${metadataNamespace}".jobs WHERE deployment = 'preview'`)).rows,
          ).toEqual([{ state: "pending" }]);
        },
        api,
      );
      await assert.rejects(
        withNeonReleaseDatabase(root, { ...options, activationToken: "e".repeat(64) }, async () => {}, api),
        /identity changed/,
      );
      await assert.rejects(
        withNeonReleaseDatabase(root, { ...options, runtimeRole: "different_role" }, async () => {}, api),
        /identity changed/,
      );
      await assert.rejects(
        withNeonReleaseDatabase(root, { ...options, releaseKey: "f".repeat(64) }, async () => {}, api),
        /active branch/i,
      );
      expect(
        (await admin.query(`SELECT state FROM "${metadataNamespace}".jobs WHERE deployment = 'preview'`)).rows,
      ).toEqual([{ state: "pending" }]);
      await admin.query(`ALTER TABLE "${namespace}".tasks ADD COLUMN external_change text`);
      await assert.rejects(
        withNeonReleaseDatabase(root, options, async () => {}, api),
        /inconsistent/i,
      );
      await admin.query(`ALTER TABLE "${namespace}".tasks DROP COLUMN external_change`);
      await admin.query(`DELETE FROM "${metadataNamespace}".deployment_activations`);
      await assert.rejects(
        withNeonReleaseDatabase(root, options, async () => {}, api),
        /grant.*missing/i,
      );
      expect(
        (await admin.query(`SELECT count(*)::integer AS count FROM "${metadataNamespace}".deployment_activations`))
          .rows,
      ).toEqual([{ count: 0 }]);
      const receipt = await readFile(join(root, ".kello/releases", options.releaseKey, "release.json"), "utf8");
      expect(receipt).not.toContain(options.activationToken);
      expect(receipt).not.toContain("loom-local-only");
      await writeFile(
        schemaFile,
        (await readFile(schemaFile, "utf8")).replace(
          "publicFields:",
          'indexes: [{ fields: ["title"] }], publicFields:',
        ),
      );
      await writeFile(join(root, "index.sql"), `CREATE INDEX CONCURRENTLY tasks_0_idx ON "${namespace}".tasks (title)`);
      const concurrent = await generateCustomRelease(root, "index_title", "index.sql", "nontransactional");
      const indexedProject = await loadProject(root);
      const indexedRelease = {
        ...options,
        releaseKey: "2".repeat(64),
        deployment: "indexed",
        quarantine: "clone" as const,
        version: indexedProject.version,
        migrationHashes: [artifact.plan.hash, concurrent.plan.hash],
        reviewedHashes: [concurrent.plan.hash],
        schema: { minimum: concurrent.plan.after, maximum: concurrent.plan.after, target: concurrent.plan.after },
      };
      await assert.rejects(
        withNeonReleaseDatabase(root, indexedRelease, async () => {}, api),
        /explicit recovery runner/,
      );
      const recoveryOptions = {
        connectionString,
        root,
        namespace,
        metadataNamespace,
        runtimeRole,
        migrations: "kello/_generated/migrations",
        reviewedHashes: [concurrent.plan.hash],
        recoverNontransactional: true,
      };
      await assert.rejects(applyMigrations(recoveryOptions), /lacks compatibility/);
      await admin.query(`UPDATE "${metadataNamespace}".jobs SET state='cancelled' WHERE state='pending'`);
      await applyMigrations(recoveryOptions);
      await withNeonReleaseDatabase(
        root,
        indexedRelease,
        async ({ activation }) => {
          expect((await activation.inspect()).state).toBe("quarantined");
          await activation.activate();
        },
        api,
      );
      const oldSource = await readFile(schemaFile, "utf8");
      await writeFile(
        schemaFile,
        oldSource.replace("title: s.text().notNull()", "title: s.text().notNull(), note: s.text()"),
      );
      const expansion = await generateRelease(root, "expand_for_compatible_code");
      await writeFile(schemaFile, oldSource);
      const compatibleProject = await loadProject(root);
      const compatibleRelease = {
        ...indexedRelease,
        releaseKey: "3".repeat(64),
        deployment: "compatible",
        quarantine: "preserve" as const,
        version: compatibleProject.version,
        migrationHashes: [...indexedRelease.migrationHashes, expansion.plan.hash],
        schema: { minimum: concurrent.plan.after, maximum: expansion.plan.after, target: expansion.plan.after },
      };
      const { inputHash: _inputHash, activationToken: _activationToken, ...compatibility } = compatibleRelease;
      const declaration = {
        ...compatibility,
        format: 1,
        deployment: indexedRelease.deployment,
        slugs: { service: "service", worker: "worker" },
        activationTokenEnv: "UNSET_COMPATIBILITY_TOKEN",
        variables: { LOOM_DATABASE_URL: "UNSET_COMPATIBILITY_RUNTIME" },
      };
      const declarationFile = "compatibility.json";
      type CompatibilityDeclaration = Omit<typeof declaration, "quarantine"> & { quarantine: "clone" | "preserve" };
      const writeDeclaration = (value: CompatibilityDeclaration) =>
        writeFile(join(root, declarationFile), JSON.stringify(value));
      await writeDeclaration({ ...declaration, deployment: "absent" });
      await assert.rejects(declareProjectCompatibility(root, declarationFile, api), /exact active runtime target/);
      await writeDeclaration({ ...declaration, version: "e".repeat(64) });
      await assert.rejects(declareProjectCompatibility(root, declarationFile, api), /source version changed/);
      await writeDeclaration({
        ...declaration,
        schema: { minimum: expansion.plan.after, maximum: expansion.plan.after, target: expansion.plan.after },
      });
      await assert.rejects(declareProjectCompatibility(root, declarationFile, api), /range excludes its source/);
      await writeDeclaration({ ...declaration, migrationHashes: [] });
      await assert.rejects(declareProjectCompatibility(root, declarationFile, api), /migration history changed/);
      await writeDeclaration({ ...declaration, quarantine: "clone" });
      await assert.rejects(declareProjectCompatibility(root, declarationFile, api), /preserve mode/);
      await writeDeclaration(declaration);
      const cancelled = new AbortController();
      cancelled.abort(new Error("compatibility cancelled"));
      await assert.rejects(
        declareProjectCompatibility(root, declarationFile, api, cancelled.signal),
        /compatibility cancelled/,
      );
      const beforeDeclaration = (
        await admin.query(`SELECT state,version FROM "${metadataNamespace}".deployment_activations ORDER BY deployment`)
      ).rows;
      const declared = await declareProjectCompatibility(root, declarationFile, api);
      expect(declared.version).toBe(indexedRelease.version);
      expect(await declareProjectCompatibility(root, declarationFile, api)).toEqual(declared);
      expect(
        (
          await admin.query(
            `SELECT state,version FROM "${metadataNamespace}".deployment_activations ORDER BY deployment`,
          )
        ).rows,
      ).toEqual(beforeDeclaration);
      expect(
        (await admin.query(`SELECT max(ordinal)::integer AS ordinal FROM "${metadataNamespace}".migration_history`))
          .rows,
      ).toEqual([{ ordinal: 2 }]);
      expect(
        (
          await admin.query(
            "SELECT count(*)::integer AS count FROM information_schema.columns WHERE table_schema=$1 AND table_name='tasks' AND column_name='note'",
            [namespace],
          )
        ).rows,
      ).toEqual([{ count: 0 }]);
      await admin.query(`ALTER ROLE "${runtimeRole}" LOGIN PASSWORD 'loom-test-only'`);
      const restrictedAddress = new URL(connectionString);
      restrictedAddress.username = runtimeRole;
      restrictedAddress.password = "loom-test-only";
      await writeDeclaration({ ...declaration, migrationRole: runtimeRole });
      await assert.rejects(
        declareProjectCompatibility(root, declarationFile, {
          ...api,
          getConnectionUri: async () => ({ uri: restrictedAddress.href }),
        }),
        /own the metadata namespace/,
      );
      await writeDeclaration(declaration);
      await assert.rejects(
        withNeonReleaseDatabase(
          root,
          {
            ...compatibleRelease,
            schema: { minimum: expansion.plan.after, maximum: expansion.plan.after, target: expansion.plan.after },
          },
          async () => {},
          api,
        ),
        /range excludes project source/,
      );
      await withNeonReleaseDatabase(
        root,
        compatibleRelease,
        async ({ database }) => {
          expect(database.head).toBe(expansion.plan.after);
        },
        api,
      );
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
      await admin.query(`DROP SCHEMA IF EXISTS "${metadataNamespace}" CASCADE`);
      await admin.query(`DROP ROLE IF EXISTS "${runtimeRole}"`);
      await admin.end();
      await rm(root, { recursive: true, force: true });
    }
  },
  // Full migration/recovery cycles need an explicit budget on shared CI runners.
  60_000,
);
