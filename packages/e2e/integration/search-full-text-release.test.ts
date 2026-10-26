import assert from "node:assert/strict";
import { test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { fullTextLocalTarget } from "./full-text-local-target";
import {
  applyMigrations,
  assessMigration,
  generateRelease,
  initializeProject,
  loadProject,
  planProjectRelease,
  planRelease,
  validateMigration,
  withNeonReleaseDatabase,
} from "kello-cli";
import type { DeploymentDatabaseProvider, MigrationArtifact, NeonReleaseDatabaseOptions } from "kello-cli";

// All Kello calls use the public package. The provider fixture only resolves a local target.
const databaseUrl = fullTextLocalTarget(process.env.LOOM_TEST_DATABASE_URL);

async function withFixture(run: (fixture: Awaited<ReturnType<typeof prepareFixture>>) => Promise<void>) {
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const namespace = `fts_release_${suffix}`;
  const metadataNamespace = `loom_release_${suffix}`;
  const runtimeRole = `fts_release_role_${suffix}`;
  const root = await mkdtemp(join(tmpdir(), "kello-006-release-"));
  const admin = new pg.Client({ connectionString: databaseUrl });
  let targetVerified = false;
  try {
    await admin.connect();
    const version = Number((await admin.query("SHOW server_version_num")).rows[0]?.server_version_num);
    assert(version >= 180000 && version < 190000, "Native release proof requires PostgreSQL 18");
    const database = (await admin.query("SELECT current_database() AS database")).rows[0].database;
    assert.equal(database, "kello_test");
    targetVerified = true;
    console.log("U2_RELEASE_TARGET", JSON.stringify({ version, database, namespace }));
    await run(await prepareFixture(root, admin, namespace, metadataNamespace, runtimeRole));
  } finally {
    try {
      if (targetVerified) {
        await admin.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
        await admin.query(`DROP SCHEMA IF EXISTS "${metadataNamespace}" CASCADE`);
        await admin.query(`DROP ROLE IF EXISTS "${runtimeRole}"`);
        assert.deepEqual(
          (
            await admin.query("SELECT nspname FROM pg_namespace WHERE nspname=ANY($1::text[])", [
              [namespace, metadataNamespace],
            ])
          ).rows,
          [],
        );
        assert.deepEqual((await admin.query("SELECT rolname FROM pg_roles WHERE rolname=$1", [runtimeRole])).rows, []);
      }
    } finally {
      await admin.end();
      await rm(root, { recursive: true, force: true });
    }
  }
}

async function prepareFixture(
  root: string,
  admin: pg.Client,
  namespace: string,
  metadataNamespace: string,
  runtimeRole: string,
) {
  await initializeProject(root, "full-text-release");
  await mkdir(join(root, "node_modules"), { recursive: true });
  for (const name of ["kello", "valibot", "drizzle-orm"])
    await symlink(
      await realpath(fileURLToPath(new URL(`../../tests/node_modules/${name}`, import.meta.url))),
      join(root, "node_modules", name),
    );
  await writeFile(
    join(root, "kello.config.ts"),
    `import {defineConfig} from "kello-cli";
export default defineConfig(${JSON.stringify({
      project: "full-text-release",
      database: { namespace, metadataNamespace },
      provider: { projectId: "project", targets: { preview: { branchId: "br-preview" } } },
    })});`,
  );
  const schemaFile = join(root, "kello/schema.ts");
  async function schema(fullText: boolean) {
    await writeFile(
      schemaFile,
      `import {defineSchema,defineTable} from "kello/server";
export default defineSchema(s=>({tasks:defineTable({title:s.text(),body:s.text()}, {
  publicFields:["_id","title"], ${fullText ? 'fullText:{content:{config:"pg_catalog.simple",fields:[{field:"title",weight:"A"},{field:"body",weight:"D"}],version:"1"}}' : ""}
})}), {namespace:${JSON.stringify(namespace)}});`,
    );
  }
  const address = new URL(databaseUrl);
  const provider: DeploymentDatabaseProvider = {
    getProject: async () => ({ id: "project", name: "full-text-release", regionId: "test", pgVersion: 18 }),
    listBranches: async () => [{ id: "br-preview", name: "preview", protected: false, isDefault: false }],
    listEndpoints: async () => [
      {
        id: address.hostname.split(".")[0]!,
        branchId: "br-preview",
        type: "read_write",
        autoscalingLimitMinCu: 0.25,
        autoscalingLimitMaxCu: 1,
        suspendTimeout: 300,
      },
    ],
    getConnectionUri: async () => ({ uri: databaseUrl }),
  };
  let mutations = 0;
  async function unexpectedMutation(): Promise<never> {
    mutations++;
    throw new Error("Release database proof must not mutate hosted provider resources");
  }
  // Matches the existing prefix-readiness typed NeonApi pattern; no widened provider or casts.
  const planner: NonNullable<Parameters<typeof planProjectRelease>[2]> = {
    ...provider,
    listProjects: unexpectedMutation,
    createProject: unexpectedMutation,
    updateProject: unexpectedMutation,
    createBranch: unexpectedMutation,
    updateBranch: unexpectedMutation,
    updateEndpoint: unexpectedMutation,
    listBranchRoles: unexpectedMutation,
    listBranchDatabases: unexpectedMutation,
    getNeonAuth: unexpectedMutation,
    enableNeonAuth: unexpectedMutation,
    getNeonDataApi: unexpectedMutation,
    enableProjectBranchDataApi: unexpectedMutation,
    updateProjectBranchDataApi: unexpectedMutation,
    deleteProjectBranchDataApi: unexpectedMutation,
    listBranchFunctions: async () =>
      ["service", "worker"].map((slug) => ({
        id: slug,
        slug,
        name: slug,
        invocationUrl: `https://example.invalid/${slug}`,
        activeDeploymentId: 1,
        currentDeployment: { id: 1, status: "completed" as const },
      })),
    listBranchBuckets: async () => [],
    listBranchTriggers: async () => [],
    createBranchBucket: unexpectedMutation,
    deleteBranchBucket: unexpectedMutation,
    getProjectBranchStorage: unexpectedMutation,
    deleteBranchFunction: unexpectedMutation,
    deployBranchFunction: unexpectedMutation,
    getBranchFunction: unexpectedMutation,
    createBranchTrigger: unexpectedMutation,
    updateBranchTrigger: unexpectedMutation,
    deleteBranchTrigger: unexpectedMutation,
    listBranchCustomDomains: unexpectedMutation,
    registerBranchCustomDomain: unexpectedMutation,
    deleteBranchCustomDomain: unexpectedMutation,
    createCredential: unexpectedMutation,
    listCredentials: unexpectedMutation,
    revealCredential: unexpectedMutation,
    revokeCredential: unexpectedMutation,
  };
  async function options(
    artifacts: readonly MigrationArtifact[],
    reviewedHashes: string[] = [],
  ): Promise<NeonReleaseDatabaseOptions> {
    const project = await loadProject(root);
    const head = artifacts.at(-1);
    assert(head);
    return {
      releaseKey: "a".repeat(64),
      inputHash: "b".repeat(64),
      activationToken: "c".repeat(64),
      deployment: "preview",
      version: project.version,
      environment: "preview",
      quarantine: "clone",
      databaseName: decodeURIComponent(address.pathname.slice(1)),
      migrationRole: decodeURIComponent(address.username),
      runtimeRole,
      reviewedHashes,
      migrationHashes: artifacts.map((artifact) => artifact.plan.hash),
      schema: { minimum: head.plan.after, maximum: head.plan.after, target: head.plan.after },
    };
  }
  async function dryRun(input: NeonReleaseDatabaseOptions) {
    const { inputHash: _inputHash, activationToken: _activationToken, ...declaration } = input;
    await writeFile(
      join(root, "release.json"),
      JSON.stringify({
        ...declaration,
        format: 1,
        slugs: { service: "service", worker: "worker" },
        activationTokenEnv: "DEPLOY_TOKEN",
        variables: { LOOM_DATABASE_URL: "RUNTIME_URL" },
      }),
    );
    return planProjectRelease(root, "release.json", planner);
  }
  async function observe() {
    const ormTables = (
      await admin.query<{ tablename: string }>(
        "SELECT tablename FROM pg_tables WHERE schemaname=$1 AND tablename LIKE 'drizzle_%' ORDER BY tablename",
        [metadataNamespace],
      )
    ).rows;
    assert.equal(ormTables.length, 1);
    const ormTable = ormTables[0]!.tablename;
    assert.match(ormTable, /^drizzle_[a-f0-9]{48}$/);
    return {
      catalog: (
        await admin.query(
          `SELECT c.relname, c.relkind, pg_get_userbyid(c.relowner) AS owner,
        a.attname, a.atttypid, a.attnotnull, pg_get_expr(d.adbin,d.adrelid) AS default_expression
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        LEFT JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
        LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
        WHERE n.nspname=$1 ORDER BY c.relname,a.attnum`,
          [namespace],
        )
      ).rows,
      indexes: (
        await admin.query(
          `SELECT c.relname, pg_get_indexdef(c.oid) AS definition, i.indisvalid,
        i.indisready, am.amname, pg_get_userbyid(c.relowner) AS owner FROM pg_index i
        JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace
        JOIN pg_am am ON am.oid=c.relam WHERE n.nspname=$1 ORDER BY c.relname`,
          [namespace],
        )
      ).rows,
      history: (await admin.query(`SELECT * FROM "${metadataNamespace}".migration_history ORDER BY namespace,ordinal`))
        .rows,
      orm: (await admin.query(`SELECT * FROM "${metadataNamespace}"."${ormTable}" ORDER BY id`)).rows,
      framework: (await admin.query(`SELECT * FROM "${metadataNamespace}".framework_migrations ORDER BY version`)).rows,
      data: (await admin.query(`SELECT * FROM "${namespace}".tasks ORDER BY "_id"`)).rows,
    };
  }
  return {
    root,
    admin,
    namespace,
    metadataNamespace,
    runtimeRole,
    schema,
    provider,
    planner,
    options,
    dryRun,
    observe,
    providerMutations: () => mutations,
  };
}

async function artifactBytes(artifact: MigrationArtifact) {
  return Promise.all(["plan.json", "migration.sql"].map((file) => readFile(join(artifact.directory, file), "utf8")));
}

test("public release dry-run and database admission require exact review for a historical automatic existing-table GIN", async () => {
  await withFixture(async (fixture) => {
    const { root, admin, namespace, metadataNamespace, runtimeRole } = fixture;
    await fixture.schema(false);
    const baseline = await generateRelease(root, "baseline");
    const project = await loadProject(root);
    const runner = {
      root,
      connectionString: databaseUrl,
      namespace,
      metadataNamespace,
      runtimeRole,
      migrations: project.config.database.migrations,
    };
    assert.deepEqual((await applyMigrations(runner)).applied, [baseline.plan.hash]);
    await admin.query(
      `INSERT INTO "${namespace}".tasks(title,body) VALUES ('preserved','searchable body'),(NULL,NULL)`,
    );
    await fixture.schema(true);
    const gin = await generateRelease(root, "existing_table_gin");
    assert.equal(gin.plan.format, 2);
    assert.deepEqual(gin.plan.safety, { automatic: true, transactional: true, issues: [] });
    await validateMigration(gin.plan);
    const saved = await artifactBytes(gin);
    const assessment = await assessMigration(gin.plan);
    assert.equal(assessment.artifactHash, gin.plan.hash);
    assert.equal(assessment.safety.automatic, false);
    assert.equal(assessment.safety.transactional, true);
    assert(assessment.safety.issues.some((issue) => issue.reason === "review-required"));
    assert.deepEqual(assessment.blockingGinTimeout, { eligible: true });
    assert.equal(assessment.blockingGinOperations.length, 1);
    const operation = assessment.blockingGinOperations[0]!;
    assert.match(operation.index, /^tasks_content_[a-f0-9]{16}_fts_idx$/);
    assert.deepEqual(operation, {
      id: JSON.stringify([namespace, "tasks", operation.index, "create"]),
      schema: namespace,
      table: "tasks",
      index: operation.index,
      kind: "create",
    });
    const before = await fixture.observe();
    const input = await fixture.options([baseline, gin]);
    const report = await fixture.dryRun(input);
    assert.equal(report.dryRun, true);
    assert.deepEqual(
      report.blockers.filter((blocker) => blocker.code === "REVIEW_REQUIRED"),
      [{ code: "REVIEW_REQUIRED", resource: gin.plan.hash }],
    );
    assert.equal(report.migrations.pending.length, 1);
    const pending = report.migrations.pending[0]!;
    assert.equal(pending.hash, assessment.artifactHash);
    assert.equal(pending.reviewRequired, true);
    assert.deepEqual(pending.safety, assessment.safety);
    assert.deepEqual(pending.blockingGinOperations, assessment.blockingGinOperations);
    assert.deepEqual(pending.blockingGinTimeout, assessment.blockingGinTimeout);
    assert.deepEqual(await fixture.observe(), before);
    let callbacks = 0;
    for (const reviewedHashes of [[], [baseline.plan.hash], ["0".repeat(64)]]) {
      // Receipts bind reviewed inputs even for failed admission. Each denied attempt owns its key.
      const releaseKey = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
      await assert.rejects(
        withNeonReleaseDatabase(
          root,
          { ...input, releaseKey, reviewedHashes },
          async () => {
            callbacks++;
          },
          fixture.provider,
        ),
        /requires review/i,
      );
      assert.equal(callbacks, 0);
      assert.deepEqual(await fixture.observe(), before);
      assert.deepEqual(await artifactBytes(gin), saved);
    }
    const reviewed = { ...input, reviewedHashes: [gin.plan.hash] };
    const approvedReport = await fixture.dryRun(reviewed);
    assert(!approvedReport.blockers.some((blocker) => blocker.code === "REVIEW_REQUIRED"));
    assert.equal(approvedReport.migrations.pending[0]?.reviewRequired, false);
    assert.deepEqual(await fixture.observe(), before);
    await withNeonReleaseDatabase(
      root,
      reviewed,
      async ({ database }) => {
        callbacks++;
        assert.equal(database.head, gin.plan.after);
      },
      fixture.provider,
    );
    assert.equal(callbacks, 1);
    const after = await fixture.observe();
    assert.deepEqual(after.data, before.data);
    assert.deepEqual(after.framework, before.framework);
    assert.deepEqual(after.history.slice(0, before.history.length), before.history);
    assert.deepEqual(after.orm.slice(0, before.orm.length), before.orm);
    assert.equal(after.history.length, before.history.length + 1);
    assert.equal(after.orm.length, before.orm.length + 1);
    assert.equal(after.history.at(-1)?.hash, gin.plan.hash);
    assert.equal(after.orm.at(-1)?.hash, gin.plan.hash);
    assert.deepEqual(
      after.catalog.filter((row) => row.relname !== operation.index),
      before.catalog,
    );
    assert.deepEqual(
      after.indexes.filter((row) => row.relname !== operation.index),
      before.indexes,
    );
    const indexes = after.indexes.filter((row) => row.amname === "gin");
    assert.equal(indexes.length, 1);
    assert.equal(indexes[0]?.relname, operation.index);
    assert.equal(indexes[0]?.indisvalid, true);
    assert.equal(indexes[0]?.indisready, true);
    assert.equal(indexes[0]?.owner, "postgres");
    assert.match(indexes[0]?.definition, /to_tsvector/);
    assert.match(indexes[0]?.definition, /simple.*regconfig/);
    assert.match(indexes[0]?.definition, /setweight/);
    assert.deepEqual((await planRelease(root)).statements, []);
    assert.deepEqual((await applyMigrations(runner)).applied, []);
    await withNeonReleaseDatabase(
      root,
      reviewed,
      async ({ database }) => {
        assert.equal(database.head, gin.plan.after);
      },
      fixture.provider,
    );
    assert.deepEqual(await fixture.observe(), after);
    assert.deepEqual(await artifactBytes(gin), saved);
    assert.equal(fixture.providerMutations(), 0);
    console.log(
      "U2_RELEASE_NATIVE_REVIEW",
      JSON.stringify({
        artifactHash: assessment.artifactHash,
        historicalSafety: gin.plan.safety,
        effectiveSafety: assessment.safety,
        blockingGinOperations: assessment.blockingGinOperations,
        blockingGinTimeout: assessment.blockingGinTimeout,
        catalog: indexes,
        evidence: "local native database only; provider target seam",
      }),
    );
  });
}, 120_000);

test("public release accepts new-table GIN automatically without a reviewed hash", async () => {
  await withFixture(async (fixture) => {
    await fixture.schema(true);
    const initial = await generateRelease(fixture.root, "new_table_gin");
    const assessment = await assessMigration(initial.plan);
    assert.equal(initial.plan.safety.automatic, true);
    assert.equal(assessment.safety.automatic, true);
    const input = await fixture.options([initial]);
    const report = await fixture.dryRun(input);
    assert(!report.blockers.some((blocker) => blocker.code === "REVIEW_REQUIRED"));
    assert.equal(report.migrations.pending[0]?.reviewRequired, false);
    await withNeonReleaseDatabase(
      fixture.root,
      input,
      async ({ database }) => {
        assert.equal(database.head, initial.plan.after);
      },
      fixture.provider,
    );
    const after = await fixture.observe();
    const indexes = after.indexes.filter((row) => row.amname === "gin");
    assert.equal(indexes.length, 1);
    assert.equal(indexes[0]?.indisvalid, true);
    assert.equal(indexes[0]?.indisready, true);
    assert.deepEqual(
      after.history.map((row) => row.hash),
      [initial.plan.hash],
    );
    assert.deepEqual(
      after.orm.map((row) => row.hash),
      [initial.plan.hash],
    );
    assert.equal(after.orm.length, 1);
    assert.deepEqual((await planRelease(fixture.root)).statements, []);
    assert.equal(fixture.providerMutations(), 0);
  });
}, 120_000);
