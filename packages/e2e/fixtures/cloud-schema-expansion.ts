import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import type { NeonApi } from "@neon/config-runtime/v1";
import {
  applyMigrations,
  applyProjectMigrations,
  deployProjectRelease,
  generateProject,
  generateRelease,
  loadProject,
  readMigrations,
  readNeonFunctionReceipt,
} from "kello-cli";

/** Exercise the public compatibility bridge before deploying code for an expanded schema. */
export async function verifyCloudSchemaExpansion(
  root: string,
  admin: pg.Client,
  provider: NeonApi,
  verifyRetainedRuntime: () => Promise<void>,
) {
  const project = await loadProject(root);
  const { namespace, metadataNamespace } = project.config.database;
  assert.match(namespace, /^[a-z_][a-z0-9_]*$/);
  assert.match(metadataNamespace, /^loom_[a-z0-9_]+$/);
  const tasksTable = `"${namespace}".tasks`;
  const historyTable = `"${metadataNamespace}".migration_history`;
  const settings = project.config.deployment;
  assert(settings);
  const migrations = await readMigrations(root, project.config.database.migrations);
  const declaration = {
    ...settings,
    format: 1,
    version: project.version,
    slugs: { service: `s${project.version.slice(0, 19)}`, worker: `w${project.version.slice(0, 19)}` },
    migrationHashes: migrations.map((entry) => entry.plan.hash),
    variables: {
      [project.config.database.runtimeUrlEnv]: project.config.database.runtimeUrlEnv,
      ...settings.variables,
    },
  };
  const schemaPath = join(root, "kello/schema.ts");
  const original = await readFile(schemaPath, "utf8");
  const expanded = original.replace(
    "done: s.boolean().notNull().default(false),",
    "done: s.boolean().notNull().default(false),\n        acceptanceNote: s.text(),",
  );
  assert.notEqual(expanded, original);
  await writeFile(schemaPath, expanded);
  const migration = await generateRelease(root, "acceptance-note");
  assert(migration.plan.safety.automatic);
  const history = (await admin.query(`SELECT hash FROM ${historyTable} ORDER BY ordinal`)).rows;
  const tasks = (await admin.query(`SELECT _id,title,done FROM ${tasksTable} ORDER BY _id`)).rows;
  assert(tasks.length > 0);
  const connectionString = process.env.LOOM_MIGRATION_DATABASE_URL;
  assert(connectionString);
  await assert.rejects(
    applyMigrations({
      connectionString,
      root,
      runtimeRole: declaration.runtimeRole,
      namespace,
      metadataNamespace,
      migrations: project.config.database.migrations,
    }),
    /lacks compatibility/,
  );
  assert.deepEqual((await admin.query(`SELECT hash FROM ${historyTable} ORDER BY ordinal`)).rows, history);

  // Old handlers use explicit projections and never depend on the new nullable column.
  // Retain their exact source version while declaring the reviewed migration range.
  await writeFile(schemaPath, original);
  assert.equal((await generateProject(root)).version, declaration.version);
  const compatibilityReleaseKey = crypto.randomUUID().replaceAll("-", "").repeat(2);
  await writeFile(
    join(root, "compatibility.release.json"),
    JSON.stringify({
      ...declaration,
      releaseKey: compatibilityReleaseKey,
      migrationHashes: [...declaration.migrationHashes, migration.plan.hash],
      schema: { minimum: migration.plan.before, maximum: migration.plan.after, target: migration.plan.after },
    }),
  );
  const command = Bun.spawn(
    [
      "bun",
      fileURLToPath(new URL("../../../apps/kello-cli/src/cli.ts", import.meta.url)),
      "migrations",
      "declare-compatibility",
      "--release",
      "compatibility.release.json",
      "--cwd",
      root,
      "--json",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const timeout = setTimeout(() => command.kill(), 30000);
  try {
    const [stdout, _stderr, code] = await Promise.all([
      new Response(command.stdout).text(),
      new Response(command.stderr).text(),
      command.exited,
    ]);
    assert.equal(code, 0, "CLI compatibility declaration failed");
    assert.equal(JSON.parse(stdout).receipt.version, declaration.version);
  } finally {
    clearTimeout(timeout);
  }
  assert.deepEqual((await admin.query(`SELECT hash FROM ${historyTable} ORDER BY ordinal`)).rows, history);
  await writeFile(schemaPath, expanded);
  const generated = await generateProject(root);
  assert.notEqual(generated.version, declaration.version);
  await applyProjectMigrations(root, declaration.runtimeRole);
  assert.deepEqual(
    (
      await admin.query(
        "SELECT data_type,is_nullable FROM information_schema.columns WHERE table_schema=$1 AND table_name='tasks' AND column_name='acceptance_note'",
        [namespace],
      )
    ).rows,
    [{ data_type: "text", is_nullable: "YES" }],
  );
  assert.deepEqual((await admin.query(`SELECT _id,title,done FROM ${tasksTable} ORDER BY _id`)).rows, tasks);
  assert.equal(
    (await admin.query(`SELECT count(*)::integer AS count FROM ${tasksTable} WHERE acceptance_note IS NULL`)).rows[0]
      .count,
    tasks.length,
  );
  assert.deepEqual((await admin.query(`SELECT hash FROM ${historyTable} ORDER BY ordinal`)).rows, [
    ...history,
    { hash: migration.plan.hash },
  ]);
  await verifyRetainedRuntime();

  const release = await deployProjectRelease(root, "kello.config.ts", provider, AbortSignal.timeout(240000));
  assert(release.completed.some((entry) => entry.stage === "complete"));
  const functions = release.completed.find((entry) => entry.stage === "functions");
  assert(functions);
  const deployed = await readNeonFunctionReceipt(root, functions.artifactHash);
  return {
    generated,
    deployed,
    evidence: {
      previousVersion: declaration.version,
      version: generated.version,
      migrationHash: migration.plan.hash,
      column: "acceptance_note",
      compatibilityDeclared: true,
      preservedTasks: tasks.length,
      undeclaredMigrationRejected: true,
    },
  };
}
