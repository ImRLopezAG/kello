import { initializeProject } from "kello-cli";
import assert from "node:assert/strict";
import { test, expect } from "bun:test";
import { mkdtemp, mkdir, realpath, symlink, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createRealNeonApi } from "@neon/config-runtime/v1";
import type { NeonApi } from "@neon/config-runtime/v1";
import {
  generateRelease,
  generateProject,
  loadProject,
  withNeonReleaseDatabase,
  withNeonReleasePreparation,
} from "kello-cli";

import { withDeploymentConnection } from "../../../apps/kello-cli/src/tooling/deploy/neon/connection";
import { handoffNeonIngress, assertReleaseIngress } from "../../../apps/kello-cli/src/tooling/deploy/neon/ingress";

const connectionString = process.env.LOOM_TEST_DATABASE_URL;
test.skipIf(!connectionString)(
  "release preparation resumes final functions without replaying bootstrap or triggers",
  async () => {
    if (!connectionString) throw new Error("Missing database");
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const namespace = `app_${suffix}`;
    const metadataNamespace = `loom_${suffix}`;
    const runtimeRole = `runtime_${suffix}`;
    const root = await mkdtemp(join(tmpdir(), "loom-release-prepare-"));
    const admin = new pg.Client({ connectionString });
    await admin.connect();
    const runtime = new URL(connectionString);
    const migrationRole = decodeURIComponent(runtime.username);
    runtime.username = runtimeRole;
    runtime.password = "loom-test-only";
    const functions: Awaited<ReturnType<NeonApi["listBranchFunctions"]>> = [];
    const triggers: Awaited<ReturnType<NeonApi["listBranchTriggers"]>> = [];
    const buckets: Awaited<ReturnType<NeonApi["listBranchBuckets"]>> = [];
    const calls: string[] = [];
    let deploymentId = 0;
    let initialVersion = "";
    let nextVersion = "";
    let failFinalWorker = true;
    let failHandoff = true;
    const provider: NeonApi = {
      ...createRealNeonApi({ apiKey: "fixture", baseUrl: "http://127.0.0.1:1" }),
      getProject: async () => ({ id: "project", name: "test", regionId: "aws-us-east-2", pgVersion: 18 }),
      listBranches: async () => [{ id: "preview", name: "preview", protected: false, isDefault: false }],
      listEndpoints: async () => [
        {
          id: runtime.hostname.split(".")[0] ?? "",
          branchId: "preview",
          type: "read_write",
          autoscalingLimitMinCu: 0.25,
          autoscalingLimitMaxCu: 1,
          suspendTimeout: 300,
        },
      ],
      getConnectionUri: async () => ({ uri: connectionString }),
      listBranchFunctions: async () => structuredClone(functions),
      listBranchBuckets: async () => structuredClone(buckets),
      createBranchBucket: async (_project, _branch, input) => {
        calls.push("bucket");
        const bucket = { name: input.name, accessLevel: input.accessLevel ?? "private" };
        buckets.push(bucket);
        return bucket;
      },
      listBranchTriggers: async () => structuredClone(triggers),
      createBranchTrigger: async (_project, _branch, input) => {
        if (input.type !== "schedule" && input.type !== "storage_object_created")
          throw new Error("Unexpected fixture trigger");
        calls.push("trigger");
        const trigger = {
          ...input,
          functionPath: input.functionPath ?? "/",
          enabled: input.enabled ?? true,
          triggerId: crypto.randomUUID(),
          inherited: false,
          nextRunAt: null,
        };
        triggers.push(trigger);
        return trigger;
      },
      updateBranchTrigger: async (_project, _branch, id, input) => {
        const trigger = triggers.find((entry) => entry.triggerId === id);
        assert.ok(trigger);
        if (failHandoff) throw new Error("Interrupted ingress handoff");
        trigger.enabled = input.enabled ?? trigger.enabled;
        return trigger;
      },
      deployBranchFunction: async (_project, _branch, slug, input) => {
        calls.push(slug);
        expect(input.bundle.byteLength).toBeGreaterThan(0);
        const currentVersion = slug.endsWith("next") ? nextVersion : initialVersion;
        expect(
          (
            await admin.query(`SELECT state FROM "${metadataNamespace}".deployment_activations WHERE version=$1`, [
              currentVersion,
            ])
          ).rows,
        ).toEqual([{ state: "quarantined" }]);
        if (slug === "worker" && deploymentId === 3 && failFinalWorker) throw new Error("interrupted final worker");
        const deployment = { id: ++deploymentId, status: "completed" as const };
        const fn = {
          id: `fn-${slug}`,
          name: slug,
          slug,
          invocationUrl: `https://example.test/${slug}`,
          activeDeploymentId: deployment.id,
          currentDeployment: deployment,
        };
        const index = functions.findIndex((entry) => entry.slug === slug);
        if (index === -1) functions.push(fn);
        else functions[index] = fn;
        return deployment;
      },
    };
    try {
      await admin.query(`CREATE ROLE "${runtimeRole}" LOGIN PASSWORD 'loom-test-only' NOINHERIT`);
      await initializeProject(root, "release");
      await writeFile(
        join(root, "kello/storage.ts"),
        'import { defineProcedureStorage } from "kello/server"; export default defineProcedureStorage({ buckets: { uploads: {} } });',
      );
      await mkdir(join(root, "node_modules/@kello"), { recursive: true });
      for (const name of ["kello", "valibot", "drizzle-orm"])
        await symlink(
          await realpath(fileURLToPath(new URL(`../../tests/node_modules/${name}`, import.meta.url))),
          join(root, "node_modules", name),
        );
      await writeFile(
        join(root, "kello.config.ts"),
        `import { defineConfig } from "kello-cli"; export default defineConfig(${JSON.stringify({ project: "release", database: { namespace, metadataNamespace }, provider: { projectId: "project", targets: { preview: { branchId: "preview" } } } })});`,
      );
      const schemaFile = join(root, "kello/schema.ts");
      await writeFile(
        schemaFile,
        (await readFile(schemaFile, "utf8")).replace('namespace: "app"', `namespace: "${namespace}"`),
      );
      const migration = await generateRelease(root, "initial");
      const project = await loadProject(root);
      initialVersion = project.version;
      const options = {
        releaseKey: "a".repeat(64),
        deployment: "preview",
        version: project.version,
        activationToken: "c".repeat(64),
        environment: "preview" as const,
        databaseName: decodeURIComponent(runtime.pathname.slice(1)),
        migrationRole,
        runtimeRole,
        quarantine: "clone" as const,
        reviewedHashes: [],
        migrationHashes: [migration.plan.hash],
        schema: { minimum: migration.plan.after, maximum: migration.plan.after, target: migration.plan.after },
        slugs: { service: "service", worker: "worker" },
        variables: { LOOM_DATABASE_URL: runtime.href, APPLICATION_SECRET: "private-value" },
      };
      await assert.rejects(
        withNeonReleasePreparation(
          root,
          options,
          async () => {
            throw new Error("Reached callback too soon");
          },
          provider,
        ),
        /Function deployment incomplete/,
      );
      expect(calls).toEqual(["service", "worker", "bucket", "trigger", "trigger", "service", "worker"]);
      failFinalWorker = false;
      const prepared = await withNeonReleasePreparation(
        root,
        options,
        async (session) => {
          expect(session.journal.read().completed.map((stage) => stage.stage)).toEqual([
            "metadata",
            "quarantine",
            "migrations",
            "prepared",
            "bootstrap",
            "triggers",
            "functions",
          ]);
          expect((await session.activation.inspect()).state).toBe("quarantined");
          expect(triggers.every((trigger) => !trigger.enabled)).toBe(true);
          return session.journal.read();
        },
        provider,
      );
      expect(calls).toEqual(["service", "worker", "bucket", "trigger", "trigger", "service", "worker", "worker"]);
      await withNeonReleasePreparation(root, options, async () => {}, provider);
      expect(calls).toHaveLength(8);
      await assert.rejects(
        withNeonReleasePreparation(
          root,
          { ...options, variables: { ...options.variables, APPLICATION_SECRET: "changed" } },
          async () => {},
          provider,
        ),
        /identity changed/,
      );
      expect(calls).toHaveLength(8);
      const manifestFile = join(root, "package.json");
      const originalSource = await readFile(manifestFile, "utf8");
      await writeFile(manifestFile, originalSource + "\n");
      const nextProject = await loadProject(root);
      nextVersion = nextProject.version;
      assert.notEqual(nextProject.version, project.version);
      const retainedFunctions = structuredClone(functions);
      await assert.rejects(
        withNeonReleasePreparation(
          root,
          { ...options, releaseKey: "b".repeat(64), version: nextProject.version, quarantine: "preserve" },
          async () => {},
          provider,
        ),
        /Function names belong to another runtime/,
      );
      expect(functions).toEqual(retainedFunctions);
      expect(
        (await admin.query(`SELECT slug,version FROM "${metadataNamespace}".function_ownership ORDER BY slug`)).rows,
      ).toEqual([
        { slug: "service", version: project.version },
        { slug: "worker", version: project.version },
      ]);
      expect(calls).toHaveLength(8);
      await writeFile(manifestFile, originalSource);
      await assert.rejects(
        withNeonReleasePreparation(
          root,
          {
            ...options,
            releaseKey: "d".repeat(64),
            quarantine: "preserve",
            slugs: { service: "worker", worker: "service" },
          },
          async () => {},
          provider,
        ),
        /Function names belong to another runtime/,
      );
      expect(functions).toEqual(retainedFunctions);
      expect(calls).toHaveLength(8);
      const bucket = buckets[0];
      assert.ok(bucket);
      bucket.accessLevel = "public_read";
      await assert.rejects(
        withNeonReleasePreparation(root, options, async () => {}, provider),
        /private bucket changed/i,
      );
      expect(calls).toHaveLength(8);
      bucket.accessLevel = "private";
      const trigger = triggers[0];
      assert.ok(trigger?.type === "schedule");
      trigger.cron = "0 * * * *";
      await assert.rejects(
        withNeonReleasePreparation(root, options, async () => {}, provider),
        /trigger.*changed/i,
      );
      expect(calls).toHaveLength(8);
      trigger.cron = "* * * * *";
      const worker = functions.find((entry) => entry.slug === "worker");
      assert.ok(worker);
      worker.id = "replacement-worker";
      await assert.rejects(
        withNeonReleasePreparation(root, options, async () => {}, provider),
        /function identity changed/i,
      );
      worker.id = "fn-worker";
      await withNeonReleasePreparation(
        root,
        options,
        async ({ activation }) => {
          await activation.activate();
        },
        provider,
      );
      for (const entry of triggers) entry.enabled = true;
      await withNeonReleasePreparation(
        root,
        options,
        async ({ activation }) => {
          await activation.assertActive();
        },
        provider,
      );
      expect(triggers.every((entry) => entry.enabled)).toBe(true);
      expect(calls).toHaveLength(8);
      const final = prepared.completed.find((entry) => entry.stage === "functions");
      assert.ok(final);
      await withNeonReleasePreparation(
        root,
        options,
        async ({ journal }) => {
          await journal.complete({ stage: "health" });
          await journal.complete({ stage: "activated" });
          await journal.complete({ stage: "complete", enabledTriggerIds: triggers.map((entry) => entry.triggerId) });
        },
        provider,
      );
      const retainedReceiptPath = join(root, ".kello/deploy", final.artifactHash, "functions.json");
      const retainedReceipt = await readFile(retainedReceiptPath, "utf8");
      await rm(retainedReceiptPath);
      await assert.rejects(
        withNeonReleasePreparation(root, options, async () => {}, provider),
        /Could not read Neon function receipt/,
      );
      expect(calls).toHaveLength(8);
      await writeFile(retainedReceiptPath, retainedReceipt);
      await writeFile(manifestFile, originalSource + "\n");
      const beforeNext = structuredClone(functions);
      const previousTriggers = structuredClone(triggers);
      await withNeonReleasePreparation(
        root,
        {
          ...options,
          releaseKey: "e".repeat(64),
          version: nextProject.version,
          quarantine: "preserve",
          slugs: { service: "servicenext", worker: "workernext" },
        },
        async ({ activation }) => {
          expect((await activation.inspect()).state).toBe("quarantined");
        },
        provider,
      );
      expect(functions.filter((entry) => entry.slug === "service" || entry.slug === "worker")).toEqual(beforeNext);
      expect(triggers.filter((entry) => entry.functionSlug === "worker")).toEqual(previousTriggers);
      expect(
        triggers
          .filter((entry) => entry.functionSlug === "workernext")
          .map((entry) => ({ name: entry.name, enabled: entry.enabled })),
      ).toEqual([
        { name: "loom:workernext:jobs", enabled: false },
        { name: "loom:workernext:storage:uploads", enabled: false },
      ]);
      const ingressOptions = {
        deployment: "preview",
        version: nextProject.version,
        releaseKey: "e".repeat(64),
        workerSlug: "workernext",
        config: project.config,
        environment: "preview" as const,
      };
      await withDeploymentConnection(
        { config: project.config, environment: "preview", databaseName: options.databaseName, migrationRole },
        async (client) => {
          await assert.rejects(handoffNeonIngress(client, ingressOptions, provider), /Could not disable/);
          const superseded = { deployment: "preview", releaseKey: "a".repeat(64), version: project.version };
          await assert.rejects(assertReleaseIngress(client, superseded), /superseded/);
          failHandoff = false;
          await handoffNeonIngress(client, ingressOptions, provider);
          await handoffNeonIngress(client, ingressOptions, provider);
          expect(triggers.find((entry) => entry.name === "loom:worker:jobs")?.enabled).toBe(true);
          expect(triggers.find((entry) => entry.name === "loom:worker:storage:uploads")?.enabled).toBe(false);
          expect(triggers.filter((entry) => entry.functionSlug === "workernext").every((entry) => !entry.enabled)).toBe(
            true,
          );
          expect(
            (
              await admin.query(`SELECT state FROM "${metadataNamespace}".deployment_activations WHERE version=$1`, [
                project.version,
              ])
            ).rows,
          ).toEqual([{ state: "active" }]);
        },
        provider,
      );
      await writeFile(manifestFile, originalSource);
      for (const [index, invalid] of [
        { retainedReleaseKey: "9".repeat(64) },
        { retainedReleaseKey: "e".repeat(64) },
        { slugs: { service: "newservice", worker: "newworker" } },
      ].entries()) {
        await assert.rejects(
          withNeonReleasePreparation(
            root,
            {
              ...options,
              quarantine: "preserve",
              releaseKey: String(index + 5).repeat(64),
              retainedReleaseKey: options.releaseKey,
              ...invalid,
            },
            async () => {},
            provider,
          ),
          /Retained release|identity changed/,
        );
      }
      const beforeRollback = structuredClone(functions);
      const rollbackCalls = calls.length;
      await withNeonReleasePreparation(
        root,
        {
          ...options,
          quarantine: "preserve",
          releaseKey: "f".repeat(64),
          retainedReleaseKey: options.releaseKey,
        },
        async ({ journal, activation }) => {
          await activation.assertActive();
          expect(journal.read().completed.find((entry) => entry.stage === "functions")).toEqual(final);
        },
        provider,
      );
      expect(functions).toEqual(beforeRollback);
      expect(calls).toHaveLength(rollbackCalls);
      const originalSchema = await readFile(schemaFile, "utf8");
      await admin.query(`INSERT INTO "${namespace}".tasks(title) VALUES ('preserved')`);
      await writeFile(
        schemaFile,
        originalSchema.replace("title: s.text().notNull()", "title: s.text().notNull(), description: s.text()"),
      );
      const expansion = await generateRelease(root, "description");
      await writeFile(schemaFile, originalSchema);
      await generateProject(root);
      assert.equal((await loadProject(root)).version, project.version);
      const expandedOptions = {
        ...options,
        quarantine: "preserve" as const,
        migrationHashes: [migration.plan.hash, expansion.plan.hash],
        schema: { minimum: migration.plan.after, maximum: expansion.plan.after, target: expansion.plan.after },
      };
      await assert.rejects(
        withNeonReleasePreparation(
          root,
          {
            ...expandedOptions,
            releaseKey: "4".repeat(64),
            retainedReleaseKey: options.releaseKey,
          },
          async () => {},
          provider,
        ),
        /migrations already applied/,
      );
      const { slugs: _slugs, variables: _variables, ...databaseOptions } = expandedOptions;
      await withNeonReleaseDatabase(
        root,
        {
          ...databaseOptions,
          releaseKey: "3".repeat(64),
          inputHash: "2".repeat(64),
        },
        async () => {},
        provider,
      );
      await admin.query(`UPDATE "${namespace}".tasks SET description='expanded data'`);
      await withNeonReleasePreparation(
        root,
        {
          ...expandedOptions,
          releaseKey: "4".repeat(64),
          retainedReleaseKey: options.releaseKey,
        },
        async ({ journal }) => {
          expect(journal.read().completed.find((entry) => entry.stage === "functions")).toEqual(final);
        },
        provider,
      );
      expect((await admin.query(`SELECT title,description FROM "${namespace}".tasks`)).rows).toEqual([
        { title: "preserved", description: "expanded data" },
      ]);
      expect(functions).toEqual(beforeRollback);
      expect(calls).toHaveLength(rollbackCalls);
      expect(JSON.stringify(prepared)).not.toContain("private-value");
      expect(JSON.stringify(prepared)).not.toContain(runtime.href);
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
      await admin.query(`DROP SCHEMA IF EXISTS "${metadataNamespace}" CASCADE`);
      await admin.query(`DROP ROLE IF EXISTS "${runtimeRole}"`);
      await admin.end();
      await rm(root, { recursive: true, force: true });
    }
  },
  20000,
);
