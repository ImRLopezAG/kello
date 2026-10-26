import assert from "node:assert/strict";
import { test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { pgSchema } from "drizzle-orm/pg-core";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api-postgres";
import * as v from "valibot";
import { createRpcRuntime, defineRpcAuth } from "kello/server";
import {
  bootstrapDatabase,
  generateProject,
  initializeProject,
  loadProject,
  reconcileComponentNamespaces,
  withMigrationConnection,
} from "kello-cli";
import { callExample } from "../fixtures/rpc-call";
import { writeSearchComponent } from "../fixtures/search-component";

const connectionString = process.env.LOOM_TEST_DATABASE_URL;
test.skipIf(!connectionString)(
  "generated search mounts retain local graphs, data and cursor authority (U6)",
  async () => {
    if (!connectionString) throw new Error("Missing database URL");
    const root = await mkdtemp(join(tmpdir(), "loom-search-components-"));
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const metadataNamespace = `loom_search_components_${suffix}`;
    const runtimeRole = `search_component_reader_${suffix}`;
    const namespaces: string[] = [];
    const owner = new pg.Pool({ connectionString });
    let runtime: Awaited<ReturnType<typeof createRpcRuntime>> | undefined;
    try {
      await initializeProject(root, "searchcomponents");
      await mkdir(join(root, "node_modules"));
      for (const name of ["kello", "valibot", "drizzle-orm", "effect"])
        await symlink(
          await realpath(fileURLToPath(new URL(`../../tests/node_modules/${name}`, import.meta.url))),
          join(root, "node_modules", name),
        );
      await writeFile(
        join(root, "kello.config.ts"),
        `import { defineConfig } from "kello-cli"; export default defineConfig({ database: { namespace: "search_root_${suffix}", metadataNamespace: "${metadataNamespace}" } });`,
      );
      await rm(join(root, "kello/contracts"), { recursive: true });
      await rm(join(root, "kello/functions"), { recursive: true });
      await mkdir(join(root, "kello/contracts"));
      await mkdir(join(root, "kello/functions"));
      await writeFile(
        join(root, "kello/schema.ts"),
        `import { defineSchema } from "kello/server"; export default defineSchema(() => ({}), { namespace: "search_root_${suffix}" });`,
      );
      await writeSearchComponent(join(root, "kello"));
      await writeFile(
        join(root, "kello/app.config.ts"),
        `import { defineApplication } from "kello";
import catalog from "./components/catalog/setup";
import reader from "./components/reader/setup";
const app = defineApplication({ rpc: ({ os }) => ({ os }) });
const catalogMount = app.use(catalog, { name: "catalog_${suffix}", public: "store" });
const staffMount = app.use(catalog, { name: "staff_${suffix}", public: "staff" });
app.use(reader, { name: "reader_${suffix}", public: "readerStore", dependencies: { catalog: catalogMount } });
app.use(reader, { name: "staffreader_${suffix}", public: "readerStaff", dependencies: { catalog: staffMount } });
export default app;`,
      );
      await generateProject(root);
      const project = await loadProject(root);
      assert.equal(project.componentScopes.length, 4);
      await bootstrapDatabase({ connectionString, metadataNamespace, runtimeRole });
      const mounted = project.componentScopes.map((scope) => ({
        mountPath: scope.mountPath,
        namespace: scope.namespace,
      }));
      await withMigrationConnection(connectionString, (client) =>
        reconcileComponentNamespaces(client, metadataNamespace, mounted),
      );
      const actor = await owner.query<{ name: string }>("SELECT current_user AS name");
      const ownerName = actor.rows[0]?.name;
      assert(ownerName);
      await owner.query(`GRANT "${runtimeRole}" TO "${ownerName.replaceAll('"', '""')}"`);
      await owner.query(`ALTER ROLE "${runtimeRole}" LOGIN PASSWORD 'loom-search-Test-06!'`);
      for (const scope of project.componentScopes) {
        if (!scope.schema.tables.tasks) continue;
        const index = scope.mountPath.startsWith("catalog_") ? 0 : 1;
        const namespace = scope.namespace;
        namespaces.push(namespace);
        const empty = await generateDrizzleJson({}, undefined, [namespace]);
        const snapshot = await generateDrizzleJson(
          { namespace: pgSchema(namespace), ...scope.schema.tables },
          empty.id,
          [namespace],
        );
        await owner.query((await generateMigration(empty, snapshot)).join("\n"));
        await owner.query(
          `GRANT USAGE ON SCHEMA "${namespace}" TO "${runtimeRole}"; GRANT SELECT ON ALL TABLES IN SCHEMA "${namespace}" TO "${runtimeRole}"`,
        );
        const db = drizzle({ client: owner, relations: scope.relations });
        const tasks = scope.schema.tables.tasks;
        const labels = scope.schema.tables.labels;
        const taskLabels = scope.schema.tables.taskLabels;
        assert(tasks && labels && taskLabels);
        await db.insert(tasks).values(
          ["A", "B", "C"].map((title) => ({
            title: `${index}-${title}`,
            done: index === 1,
            at: new Date("2026-01-01"),
            count: 1n,
            amount: "1",
          })),
        );
        const task = (await db.select().from(tasks))[0];
        const label = (
          await db
            .insert(labels)
            .values({ name: `label-${index}` })
            .returning()
        )[0];
        assert(task && label);
        await db.insert(taskLabels).values({ taskId: task._id, labelId: label._id });
      }
      const address = new URL(connectionString);
      address.username = runtimeRole;
      address.password = "loom-search-Test-06!";
      runtime = await createRpcRuntime({
        schema: project.schema,
        relations: project.relations,
        connectionString: address.href,
        application: project.application,
        version: project.version,
        deployment: "search-components",
        metadataNamespace,
        branchId: "br-wispy-dew-awdp5g3y",
        environment: { LOOM_SEARCH_CURSOR_KEY: "06".repeat(32) },
        auth: defineRpcAuth({ allowAnonymous: true, authorize: () => {} }),
        procedures: project.componentScopes.flatMap((scope) =>
          scope.procedures.map((entry) => ({
            scope: scope.mountPath,
            path: entry.path,
            visibility: entry.visibility === "internal" ? ("internal" as const) : ("exported" as const),
            procedure: entry.definition,
          })),
        ),
        scopes: [
          { name: "", dependencies: {} },
          ...project.componentScopes.map((scope) => ({
            name: scope.mountPath,
            dependencies: Object.fromEntries(
              Object.entries(project.components.find((node) => node.path === scope.mountPath)!.dependencies).map(
                ([alias, reference]) => [alias, project.components.find((node) => node.reference === reference)!.path],
              ),
            ),
            schema: scope.schema,
          })),
        ],
        exposures: project.components.map((node) => ({ scope: node.path, prefix: node.public! })),
        assertActive: async () => {},
      });
      const page = v.object({
        rows: v.array(v.object({ title: v.string() })),
        nextCursor: v.nullable(v.string()),
        previousCursor: v.nullable(v.string()),
      });
      const selection = { columns: { title: true }, limit: 1 };
      const first = await callExample(runtime, ["store", "items", "list"], selection, null);
      assert(first.ok);
      const parsed = v.parse(page, first.value);
      assert.equal(parsed.rows[0]?.title.startsWith("0-"), true);
      assert(parsed.nextCursor);
      const other = await callExample(runtime, ["staff", "items", "list"], selection, null);
      assert(other.ok);
      assert.equal(v.parse(page, other.value).rows[0]?.title.startsWith("1-"), true);
      for (const [prefix, expected] of [
        ["readerStore", "0-"],
        ["readerStaff", "1-"],
      ] as const) {
        const dependency = await callExample(runtime, [prefix, "items", "title"], undefined, null);
        assert(dependency.ok, JSON.stringify(dependency));
        assert.equal(v.parse(v.string(), dependency.value).startsWith(expected), true);
      }
      assert.equal(
        (await callExample(runtime, ["staff", "items", "list"], { ...selection, cursor: parsed.nextCursor }, null)).ok,
        false,
      );
      assert.equal(
        (
          await callExample(
            runtime,
            ["store", "items", "effectList"],
            { ...selection, cursor: parsed.nextCursor },
            null,
          )
        ).ok,
        false,
      );
      const next = await callExample(
        runtime,
        ["store", "items", "list"],
        { ...selection, cursor: parsed.nextCursor },
        null,
      );
      assert(next.ok);
      assert.notEqual(v.parse(page, next.value).rows[0]?.title, parsed.rows[0]?.title);
      for (const [prefix, index] of [
        ["store", 0],
        ["staff", 1],
      ] as const) {
        const effect = await callExample(
          runtime,
          [prefix, "items", "effectList"],
          { columns: { done: true }, with: { labels: { columns: { name: true } } } },
          null,
        );
        assert(effect.ok);
        const rows = v.parse(
          v.object({
            rows: v.array(v.strictObject({ done: v.boolean(), labels: v.array(v.strictObject({ name: v.string() })) })),
          }),
          effect.value,
        ).rows;
        assert(rows.every((row) => row.done === Boolean(index)));
        assert.equal(rows.flatMap((row) => row.labels).at(0)?.name, `label-${index}`);
        const privateResult = await callExample(runtime, [prefix, "items", "throughPrivate"], selection, null);
        assert(privateResult.ok);
        assert.equal(v.parse(page, privateResult.value).rows[0]?.title.startsWith(`${index}-`), true);
        assert.equal((await callExample(runtime, [prefix, "internal", "items", "list"], selection, null)).ok, false);
      }
      assert.equal((await callExample(runtime, ["catalog", "items", "list"], selection, null)).ok, false);
      const before = await readFile(join(root, "kello/components/catalog/_generated/schema.ts"), "utf8");
      assert.match(before, /createProjectContext\(schema, relations\)/);
      await runtime.stop();
      runtime = undefined;
      const retained = mounted.find((mount) => mount.mountPath.startsWith("catalog_"));
      assert(retained);
      await withMigrationConnection(connectionString, (client) =>
        reconcileComponentNamespaces(client, metadataNamespace, [retained]),
      );
      const ownership = await owner.query<{ state: string }>(
        `SELECT state FROM "${metadataNamespace}".component_namespaces ORDER BY mount_path`,
      );
      assert.equal(ownership.rows.filter((row) => row.state === "mounted").length, 1);
      assert.equal(ownership.rows.filter((row) => row.state === "detached").length, 3);
      for (const namespace of namespaces) {
        const data = await owner.query<{ count: number }>(`SELECT count(*)::int AS count FROM "${namespace}".tasks`);
        assert.equal(
          data.rows[0]?.count,
          3,
          "Unmount must retain selected root data in both mounted and detached scopes",
        );
        for (const table of ["labels", "task_labels"]) {
          const children = await owner.query<{ count: number }>(
            `SELECT count(*)::int AS count FROM "${namespace}"."${table}"`,
          );
          assert.equal(children.rows[0]?.count, 1, "Unmount must retain child and junction data");
        }
      }
    } finally {
      await runtime?.stop();
      for (const namespace of namespaces) await owner.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
      await owner.query(`DROP SCHEMA IF EXISTS "${metadataNamespace}" CASCADE`);
      await owner.query(`DROP ROLE IF EXISTS "${runtimeRole}"`);
      await owner.end();
      await rm(root, { recursive: true, force: true });
    }
  },
  120_000,
);
