import assert from "node:assert/strict";
import { expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, symlink, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { fullTextLocalTarget } from "./full-text-local-target";
import * as v from "valibot";
// This fixture is an external consumer throughout; never mix source helper identities with package exports.
import {
  assessMigration,
  initializeProject,
  prepareProject,
  generateRelease,
  planRelease,
  synchronizeDevelopment,
  DevelopmentReviewRequired,
  validateMigration,
} from "kello/tooling";
import type { DevelopmentDatabaseProvider } from "kello/tooling";

const databaseUrl = fullTextLocalTarget(process.env.LOOM_TEST_DATABASE_URL);

test("public CLI and development admission use current assessment without changing historical artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "kello-006-callers-"));
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const namespace = `fts_callers_${suffix}`;
  const metadata = `loom_${suffix}`;
  const runtimeRole = `runtime_${suffix}`;
  const url = new URL(databaseUrl);
  const admin = new pg.Client({ connectionString: databaseUrl });
  await admin.connect();
  let targetVerified = false;
  const api: DevelopmentDatabaseProvider = {
    getProject: async () => ({ id: "project", name: "tasks", regionId: "test", pgVersion: 18 }),
    listBranches: async () => [{ id: "br-developer", name: "developer", protected: false, isDefault: false }],
    listEndpoints: async () => [
      {
        id: url.hostname.split(".")[0]!,
        branchId: "br-developer",
        type: "read_write",
        autoscalingLimitMinCu: 0.25,
        autoscalingLimitMaxCu: 1,
        suspendTimeout: 300,
      },
    ],
    getConnectionUri: async () => ({ uri: databaseUrl }),
  };
  const options = {
    root,
    databaseName: decodeURIComponent(url.pathname.slice(1)),
    migrationRole: decodeURIComponent(url.username),
    runtimeRole,
  };
  const schema = (fullText: boolean) => `import { defineSchema, defineTable } from "kello/server";
export default defineSchema((s) => ({tasks: defineTable({title:s.text().notNull(), body:s.text()}, {
publicFields:["_id","title"], ${fullText ? 'fullText:{content:{config:"pg_catalog.simple",fields:[{field:"title",weight:"A"},{field:"body",weight:"D"}],version:"1"}}' : ""}
})}),{namespace:${JSON.stringify(namespace)}});`;
  const cli = fileURLToPath(new URL("../../../apps/loom/cli.js", import.meta.url));
  const run = async (args: string[]) => {
    const child = Bun.spawn([process.execPath, cli, ...args, "--cwd", root, "--json"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    return v.parse(
      v.object({
        plan: v.optional(v.unknown()),
        assessment: v.optional(v.unknown()),
        assessments: v.optional(v.array(v.object({ namespace: v.string(), assessment: v.unknown() }))),
      }),
      JSON.parse(stdout),
    );
  };
  try {
    const version = Number((await admin.query("SHOW server_version_num")).rows[0].server_version_num);
    assert(version >= 180000 && version < 190000, "Native caller proof requires PostgreSQL 18");
    const database = (await admin.query("SELECT current_database() AS database")).rows[0].database;
    assert.equal(database, "kello_test");
    targetVerified = true;
    console.log("U2_CALLER_TARGET", JSON.stringify({ version, database, namespace }));
    await initializeProject(root, "tasks");
    await mkdir(join(root, "node_modules"), { recursive: true });
    for (const name of ["kello", "valibot", "drizzle-orm"])
      await symlink(
        await realpath(fileURLToPath(new URL(`../../tests/node_modules/${name}`, import.meta.url))),
        join(root, "node_modules", name),
      );
    await writeFile(
      join(root, "kello.config.ts"),
      `import {defineConfig} from "kello/tooling";
export default defineConfig({project:"tasks",database:{namespace:${JSON.stringify(namespace)},metadataNamespace:${JSON.stringify(metadata)}},provider:{projectId:"project",targets:{development:{branchId:"br-developer"}}}});`,
    );
    await writeFile(join(root, "kello/schema.ts"), schema(false));
    await generateRelease(root, "initial");
    const initial = await prepareProject(root);
    await synchronizeDevelopment({ ...options, sourceVersion: initial.version }, api);
    await admin.query(`INSERT INTO "${namespace}".tasks(title) VALUES ('preserved')`);
    const prior = await admin.query(
      `SELECT artifact_hash, after_catalog_hash FROM "${metadata}".development_history ORDER BY ordinal`,
    );
    await writeFile(join(root, "kello/schema.ts"), schema(true));
    const changed = await prepareProject(root);
    const plan = await planRelease(root);
    const assessment = await assessMigration(plan);
    expect(plan.safety.automatic).toBe(true);
    expect(assessment.safety.automatic).toBe(false);
    expect(assessment.artifactHash).toBe(plan.hash);
    expect(assessment.blockingGinTimeout).toEqual({ eligible: true });
    expect(assessment.blockingGinOperations).toHaveLength(1);
    await validateMigration(plan);
    const diff = await run(["schema", "diff"]);
    expect(diff.plan).toEqual(plan);
    expect(diff.assessment).toEqual(assessment);
    await assert.rejects(
      synchronizeDevelopment({ ...options, sourceVersion: changed.version }, api),
      (cause: unknown) => {
        assert(cause instanceof DevelopmentReviewRequired);
        assert.equal(cause.plan.safety.automatic, true);
        assert.equal(cause.assessment?.safety.automatic, false);
        assert.equal(cause.assessment?.artifactHash, cause.plan.hash);
        assert.equal(cause.assessment?.blockingGinOperations.length, 1);
        return true;
      },
    );
    expect(
      (
        await admin.query(
          `SELECT artifact_hash, after_catalog_hash FROM "${metadata}".development_history ORDER BY ordinal`,
        )
      ).rows,
    ).toEqual(prior.rows);
    expect((await admin.query(`SELECT title, body FROM "${namespace}".tasks`)).rows).toEqual([
      { title: "preserved", body: null },
    ]);
    expect(
      (await admin.query("SELECT 1 FROM pg_indexes WHERE schemaname=$1 AND indexdef LIKE '%USING gin%';", [namespace]))
        .rows,
    ).toEqual([]);
    const generated = await run(["migrations", "generate", "--name", "search"]);
    expect(generated.assessments).toEqual([{ namespace, assessment }]);
    expect((await assessMigration(await planRelease(root))).blockingGinOperations).toEqual([]);
  } finally {
    try {
      if (targetVerified) {
        await admin.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
        await admin.query(`DROP SCHEMA IF EXISTS "${metadata}" CASCADE`);
        await admin.query(`DROP ROLE IF EXISTS "${runtimeRole}"`);
      }
    } finally {
      await admin.end();
      await rm(root, { recursive: true, force: true });
    }
  }
}, 60_000);
