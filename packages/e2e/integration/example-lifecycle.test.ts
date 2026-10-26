import { defineRpcAuth } from "kello/server";
import { callExample } from "../fixtures/rpc-call";
import assert from "node:assert/strict";
import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import {
  applyMigrations,
  generateRelease,
  loadProject,
  planRelease,
  prepareProject,
  projectRuntimeGraph,
} from "kello-cli";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectDatabase, createRpcRuntime } from "kello/server";
import type { InvocationIdentity, JsonValue } from "kello/server";
import pg from "pg";
import * as v from "valibot";

test("tasks example loads its schema, relations, authorization and registered functions", async () => {
  const root = fileURLToPath(new URL("../../examples/tasks/", import.meta.url));
  const project = await loadProject(root);
  if (project.protocol !== "loom-orpc-2") throw new Error("Expected native fixture");
  assert.equal(project.config.database.namespace, "app");
  assert.deepEqual(project.schema.metadata.entities.map((entry) => entry.name).sort(), [
    "labels",
    "projects",
    "taskLabels",
    "tasks",
  ]);
  assert.deepEqual(
    project.procedures.map((entry) => entry.path.join(":")),
    ["projects:create", "projects:list", "tasks:create", "tasks:list", "tasks:search", "tasks:setDone"],
  );
});

const connectionString = process.env.LOOM_TEST_DATABASE_URL;
test.skipIf(!connectionString)(
  "tasks example replays committed migrations and enforces ownership on PostgreSQL",
  async () => {
    if (!connectionString) throw new Error("Missing test database");
    const project = await loadProject(fileURLToPath(new URL("../../examples/tasks/", import.meta.url)));
    if (project.protocol !== "loom-orpc-2") throw new Error("Expected native fixture");
    const database = `loom_example_${crypto.randomUUID().replaceAll("-", "")}`;
    const runtimeRole = `${database}_runtime`;
    const admin = new pg.Client({ connectionString });
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE "${database}"`);
      const address = new URL(connectionString);
      address.pathname = `/${database}`;
      const options = {
        connectionString: address.href,
        root: project.root,
        migrations: project.config.database.migrations,
        namespace: "app",
        metadataNamespace: project.config.database.metadataNamespace,
        runtimeRole,
      };
      const applied = await applyMigrations(options);
      assert.equal(applied.applied.length, 2, "example must replay its initial and many-to-many search migrations");
      assert.deepEqual((await applyMigrations(options)).applied, []);
      await admin.query(`ALTER ROLE "${runtimeRole}" LOGIN PASSWORD 'loom-test-only'`);
      address.username = runtimeRole;
      address.password = "loom-test-only";
      const connection = await connectDatabase({
        schema: project.schema,
        relations: project.relations,
        connectionString: address.href,
        maxConnections: 1,
      });
      try {
        const runtime = await createRpcRuntime({
          application: project.application,
          schema: project.schema,
          relations: project.relations,
          connectionString: address.href,
          version: project.version,
          branchId: "br-local-example",
          environment: { LOOM_SEARCH_CURSOR_KEY: "09".repeat(32) },
          ...projectRuntimeGraph(project),
          auth: defineRpcAuth({ authorize: project.auth.authorize, allowAnonymous: project.auth.allowAnonymous }),
          deployment: "tasks-example",
          metadataNamespace: options.metadataNamespace,
          assertActive: async () => {},
        });
        try {
          const alice = { issuer: "example", subject: "alice" };
          const bob = { issuer: "example", subject: "bob" };
          const call = (
            name: string,
            _kind: "query" | "mutation",
            args: JsonValue,
            identity: InvocationIdentity | null = alice,
          ) =>
            callExample(
              runtime,
              name.split(":"),
              args,
              identity,
              name === "projects:list" || name === "tasks:list"
                ? { database, query: (sql, values) => connection.pool.query(sql, values) }
                : undefined,
            );
          expect(await call("projects:list", "query", {}, null)).toMatchObject({
            ok: false,
            error: { code: "UNAUTHORIZED" },
          });
          expect(await call("projects:create", "mutation", { name: "Forged", ownerId: "bob" })).toMatchObject({
            ok: false,
            error: { code: "BAD_REQUEST" },
          });
          const created = await call("projects:create", "mutation", { name: "  Launch  " });
          assert(created.ok);
          const ownerProject = v.parse(v.strictObject({ _id: v.string(), name: v.literal("Launch") }), created.value);
          const taskResult = await call("tasks:create", "mutation", {
            projectId: ownerProject._id,
            title: "  Ship example  ",
          });
          assert(taskResult.ok);
          const task = v.parse(
            v.strictObject({
              _id: v.string(),
              projectId: v.literal(ownerProject._id),
              title: v.literal("Ship example"),
              done: v.literal(false),
            }),
            taskResult.value,
          );
          expect(await call("tasks:setDone", "mutation", { id: task._id, done: true })).toMatchObject({
            ok: true,
            value: { ...task, done: true },
          });
          for (const stranger of [bob, { ...alice, issuer: "other" }]) {
            expect(await call("projects:list", "query", {}, stranger)).toMatchObject({ ok: true, value: [] });
            expect(await call("tasks:list", "query", { projectId: ownerProject._id }, stranger)).toMatchObject({
              ok: true,
              value: [],
            });
            expect(
              await call("tasks:create", "mutation", { projectId: ownerProject._id, title: "Intrusion" }, stranger),
            ).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
            expect(await call("tasks:setDone", "mutation", { id: task._id, done: false }, stranger)).toMatchObject({
              ok: false,
              error: { code: "FORBIDDEN" },
            });
          }
          expect(
            await call("tasks:create", "mutation", { projectId: crypto.randomUUID(), title: "Missing project" }),
          ).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
          expect(await call("tasks:list", "query", { projectId: ownerProject._id })).toMatchObject({
            ok: true,
            value: [{ ...task, done: true }],
          });
          assert.equal(task._id[14], "7", "task ids use PostgreSQL UUIDv7");
          const persisted = await connection.pool.query<{ created: string }>(
            'SELECT "_createdAt"::text AS created FROM app.tasks WHERE "_id" = $1',
            [task._id],
          );
          const createdAt = Number(persisted.rows[0]?.created);
          assert(Number.isSafeInteger(createdAt) && Math.abs(Date.now() - createdAt) < 60_000);
          await assert.rejects(
            connection.pool.query("INSERT INTO app.tasks (project_id, title) VALUES ($1, $2)", [
              crypto.randomUUID(),
              "Invalid reference",
            ]),
            /foreign key/,
          );
          const bobCreated = await call("projects:create", "mutation", { name: "Bob's project" }, bob);
          assert(bobCreated.ok);
          expect(await call("projects:list", "query", {}, bob)).toMatchObject({ ok: true, value: [bobCreated.value] });
          expect(await call("projects:list", "query", {})).toMatchObject({ ok: true, value: [ownerProject] });
          await assert.rejects(connection.pool.query("ALTER TABLE app.tasks ADD COLUMN forbidden text"), /owner/);
        } finally {
          await runtime.stop();
        }
      } finally {
        await connection.close();
      }
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
      await admin.query(`DROP ROLE IF EXISTS "${runtimeRole}"`);
      await admin.end();
    }
  },
  60_000,
);

test.skipIf(!connectionString)(
  "tasks release schema evolution preserves data and replays into a fresh database",
  async () => {
    if (!connectionString) throw new Error("Missing test database");
    const root = await mkdtemp(join(tmpdir(), "loom-tasks-evolution-"));
    const source = fileURLToPath(new URL("../../examples/tasks/", import.meta.url));
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const developmentDatabase = `loom_evolve_${suffix}`;
    const releaseDatabase = `loom_replay_${suffix}`;
    const runtimeRole = `loom_evolve_role_${suffix}`;
    const releaseRole = `loom_replay_role_${suffix}`;
    const admin = new pg.Client({ connectionString });
    await admin.connect();
    const address = new URL(connectionString);
    address.pathname = `/${developmentDatabase}`;
    const development = new pg.Client({ connectionString: address.href });
    const releaseAddress = new URL(connectionString);
    releaseAddress.pathname = `/${releaseDatabase}`;
    const release = new pg.Client({ connectionString: releaseAddress.href });
    try {
      await cp(join(source, "kello"), join(root, "kello"), {
        recursive: true,
        filter: (path) => !path.includes("_generated"),
      });
      await cp(join(source, "kello/migrations"), join(root, "kello/migrations"), {
        recursive: true,
      });
      await mkdir(join(root, "node_modules/@kello"), { recursive: true });
      for (const name of ["kello", "kello-cli", "@orpc/server", "valibot", "drizzle-orm"]) {
        await mkdir(join(root, "node_modules", name, ".."), { recursive: true });
        await symlink(await realpath(join(source, "node_modules", name)), join(root, "node_modules", name));
      }
      await writeFile(
        join(root, "kello.config.ts"),
        `import { defineConfig } from "kello-cli";
      export default defineConfig({ project: "tasks", database: { namespace: "app", migrations: "kello/migrations" },
        provider: { projectId: "local-example", targets: { development: { branchId: "br-local-development" } } } });`,
      );
      await admin.query(`CREATE DATABASE "${developmentDatabase}"`);
      await admin.query(`CREATE DATABASE "${releaseDatabase}"`);
      await development.connect();
      await release.connect();
      const project = await loadProject(root);
      if (project.protocol !== "loom-orpc-2") throw new Error("Expected native fixture");
      const migrationOptions = {
        root,
        migrations: project.config.database.migrations,
        namespace: "app",
        metadataNamespace: project.config.database.metadataNamespace,
      };
      const initial = await applyMigrations({ ...migrationOptions, connectionString: address.href, runtimeRole });
      assert.equal(initial.applied.length, 2);
      const inserted = await development.query<{ _id: string }>(
        "INSERT INTO app.projects (name, owner_id, owner_issuer) VALUES ('Release checklist', 'alice', 'example') RETURNING _id",
      );
      const projectId = inserted.rows[0]?._id;
      assert(projectId);
      await development.query("INSERT INTO app.tasks (project_id, title) VALUES ($1, 'Preserve this task')", [
        projectId,
      ]);
      const schemaPath = join(root, "kello/schema.ts");
      const schema = await readFile(schemaPath, "utf8");
      const expanded = schema.replace("done: s.boolean()", "description: s.text(), done: s.boolean()");
      assert.notEqual(expanded, schema);
      await writeFile(schemaPath, expanded);
      const beforeSync = await planRelease(root);
      assert(beforeSync.statements.some((statement) => statement.includes('ADD COLUMN "description"')));
      const artifact = await generateRelease(root, "task_description");
      assert.equal(artifact.plan.hash, beforeSync.hash);
      const evolved = await applyMigrations({ ...migrationOptions, connectionString: address.href, runtimeRole });
      assert.deepEqual(evolved.applied, [artifact.plan.hash]);
      assert.deepEqual((await development.query("SELECT title, description FROM app.tasks")).rows, [
        { title: "Preserve this task", description: null },
      ]);
      const replay = await applyMigrations({
        ...migrationOptions,
        connectionString: releaseAddress.href,
        runtimeRole: releaseRole,
      });
      assert.deepEqual(replay.applied, [...initial.applied, artifact.plan.hash]);
      assert.deepEqual(
        (
          await applyMigrations({
            ...migrationOptions,
            connectionString: releaseAddress.href,
            runtimeRole: releaseRole,
          })
        ).applied,
        [],
      );
      const columns =
        "SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'app' AND table_name = 'tasks' ORDER BY ordinal_position";
      assert.deepEqual((await release.query(columns)).rows, (await development.query(columns)).rows);
      assert.equal((await release.query("SELECT * FROM app.tasks")).rowCount, 0);
      assert.deepEqual(
        (
          await development.query(
            `SELECT hash FROM "${project.config.database.metadataNamespace}".migration_history ORDER BY ordinal`,
          )
        ).rows.map((row) => row.hash),
        [...initial.applied, artifact.plan.hash],
      );
    } finally {
      await development.end();
      await release.end();
      await admin.query(`DROP DATABASE IF EXISTS "${developmentDatabase}" WITH (FORCE)`);
      await admin.query(`DROP DATABASE IF EXISTS "${releaseDatabase}" WITH (FORCE)`);
      await admin.query(`DROP ROLE IF EXISTS "${runtimeRole}"`);
      await admin.query(`DROP ROLE IF EXISTS "${releaseRole}"`);
      await admin.end();
      await rm(root, { recursive: true, force: true });
    }
  },
  60_000,
);

test("upload catalog loads independent configuration, storage handlers and registered jobs", async () => {
  const root = fileURLToPath(new URL("../../examples/jobs-storage/", import.meta.url));
  const project = await prepareProject(root);
  const loaded = await loadProject(root);
  assert.equal(project.version, loaded.version);
  assert.deepEqual(
    loaded.schema.metadata.entities.map((entry) => entry.name),
    ["files"],
  );
  assert.deepEqual(Object.keys(loaded.storage.buckets).sort(), ["failure-demo", "retry-demo", "uploads"]);
  assert.deepEqual(loaded.procedures.map((entry) => entry.path.join(":")).sort(), [
    "files:created",
    "files:list",
    "files:process",
    "files:status",
  ]);
});
