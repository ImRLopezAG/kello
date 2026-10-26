import { releaseHistoryNeedsRecovery } from "../../../apps/kello-cli/src/tooling/deploy/neon/history-readiness";
import assert from "node:assert/strict";
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import type { DeploymentDatabaseProvider } from "kello-cli";
import {
  captureSchemaBaseline,
  establishSchemaBaselines,
} from "../../../apps/kello-cli/src/tooling/migrations/branch-baseline";
import { withMigrationConnection as withBaselineConnection } from "../../../apps/kello-cli/src/tooling/migrations/connection";
import { ormHistoryTable } from "../../../apps/kello-cli/src/tooling/migrations/state";
import { fileURLToPath } from "node:url";
import { getTableConfig } from "drizzle-orm/pg-core";
import { bindSchemaNamespace, defineSchema } from "kello/server";
import {
  initializeProject,
  loadProject,
  generateProject,
  generateRelease,
  readMigrations,
  withNeonReleaseDatabase,
  componentNamespace,
  reconcileComponentNamespaces,
  withMigrationConnection,
  bootstrapDatabase,
  applyMigrationsOnConnection,
  emptySnapshot,
  planMigration,
  writeMigration,
} from "kello-cli";

test("component release planning permits pending framework bootstrap but retains history recovery blockers", () => {
  const oldMetadata = {
    initialized: true,
    consistent: false,
    issues: ["FRAMEWORK_UPGRADE_REQUIRED" as const],
    framework: { state: "upgrade-required" as const, appliedVersion: 26, pending: [{ version: 27, hash: "pending" }] },
  };
  expect(releaseHistoryNeedsRecovery(oldMetadata, false)).toBe(false);
  expect(releaseHistoryNeedsRecovery(oldMetadata, true)).toBe(false);
  const fresh = {
    initialized: false,
    consistent: true,
    issues: [],
    framework: { state: "fresh" as const, appliedVersion: 0 as const, pending: [] },
  };
  expect(releaseHistoryNeedsRecovery(fresh, false)).toBe(false);
  expect(releaseHistoryNeedsRecovery(fresh, true)).toBe(true);
  expect(releaseHistoryNeedsRecovery({ ...oldMetadata, issues: ["FRAMEWORK_HISTORY_DIVERGED"] }, false)).toBe(true);
  expect(releaseHistoryNeedsRecovery({ ...oldMetadata, issues: ["LIVE_DRIFT"] }, false)).toBe(true);
});

test("mount namespaces remain bounded, case-sensitive in identity, and independent of source declarations", () => {
  const paths = ["catalog", "Catalog", "parent/catalog", `a${"b".repeat(300)}`];
  const namespaces = paths.map(componentNamespace);
  expect(new Set(namespaces).size).toBe(paths.length);
  expect(namespaces.every((name) => Buffer.byteLength(name) <= 63)).toBe(true);
  expect(namespaces[0]).toBe(componentNamespace("catalog"));
  expect(() => componentNamespace("../catalog")).toThrow();
  const authored = defineSchema((f) => ({ products: { title: f.text() } }));
  const first = bindSchemaNamespace(authored, componentNamespace("first"));
  const second = bindSchemaNamespace(authored, componentNamespace("second"));
  assert(first.tables.products && second.tables.products && authored.tables.products);
  expect(getTableConfig(first.tables.products).schema).toBe(componentNamespace("first"));
  expect(getTableConfig(second.tables.products).schema).toBe(componentNamespace("second"));
  expect(getTableConfig(authored.tables.products).schema).toBeUndefined();
  expect(first.tables.products).not.toBe(second.tables.products);
});

test("repeated mounts evaluate authored relations against independent instance tables", async () => {
  const root = await mkdtemp(join(tmpdir(), "loom-component-relations-"));
  try {
    await initializeProject(root, "relations");
    await mkdir(join(root, "node_modules"));
    for (const name of ["kello", "kello-cli", "valibot", "zod", "drizzle-orm"])
      await symlink(
        await realpath(fileURLToPath(new URL(`../../tests/node_modules/${name}`, import.meta.url))),
        join(root, "node_modules", name),
      );
    const directory = join(root, "kello/components/catalog");
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "setup.ts"),
      `import { defineComponent } from "kello"; export default defineComponent({ name: "catalog" });`,
    );
    await writeFile(
      join(directory, "schema.ts"),
      `import { defineSchema } from "kello/server"; export default defineSchema((f) => ({ products: { title: f.text() } }));`,
    );
    await writeFile(
      join(directory, "relations.ts"),
      `import { defineRelations } from "drizzle-orm"; import schema from "./schema"; export default defineRelations(schema.tables);`,
    );
    await writeFile(
      join(root, "kello/app.config.ts"),
      `import { defineApplication } from "kello"; import catalog from "./components/catalog/setup"; const app = defineApplication({ rpc: ({ os }) => ({ os }) }); app.use(catalog); app.use(catalog, { name: "second" }); export default app;`,
    );
    const project = await loadProject(root);
    expect(project.componentScopes).toHaveLength(2);
    for (const scope of project.componentScopes) {
      const table = scope.schema.tables.products;
      assert(table);
      expect(scope.schema.metadata.namespace).toBe(componentNamespace(scope.mountPath));
      expect(scope.relations.products?.table).toBe(table);
      expect(getTableConfig(table).schema).toBe(componentNamespace(scope.mountPath));
    }
    expect(project.componentScopes[0]?.schema.tables.products).not.toBe(
      project.componentScopes[1]?.schema.tables.products,
    );
    await generateRelease(root, "initial");
    await writeFile(
      join(directory, "schema.ts"),
      `import { defineSchema } from "kello/server"; export default defineSchema(() => ({}));`,
    );
    const removal = await generateRelease(root, "remove_last_table");
    expect(removal.scopes.map((scope) => scope.mountPath).sort()).toEqual(["catalog", "second"]);
    expect(await readMigrations(root, "kello/_generated/migrations")).toHaveLength(1);
    await assert.rejects(generateRelease(root, "no_change"), /Migration has no structural change/);
    for (const scope of project.componentScopes) {
      const history = await readMigrations(root, `kello/_generated/migrations/components/${scope.namespace}`);
      expect(history).toHaveLength(2);
      expect(history[1]?.plan.safety.automatic).toBe(false);
      expect(history[1]?.plan.statements.join("\n")).toContain("DROP TABLE");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const connectionString = process.env.LOOM_TEST_DATABASE_URL;
// These multi-scope workflows make hundreds of sequential database round trips on Neon.
const migrationTestTimeout = 180_000;
test.skipIf(!connectionString)(
  "component ownership retains independent rows and history on additive upgrade and unmount",
  async () => {
    if (!connectionString) throw new Error("Missing test database");
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const metadataNamespace = `loom_meta_${suffix}`;
    const runtimeRole = `loom_runtime_${suffix}`;
    const scopes = ["first", "second"].map((name) => ({
      mountPath: `${name}_${suffix}`,
      namespace: componentNamespace(`${name}_${suffix}`),
    }));
    const root = await mkdtemp(join(tmpdir(), "loom-component-migrations-"));
    const admin = new pg.Client({ connectionString });
    await admin.connect();
    try {
      await bootstrapDatabase({ connectionString, metadataNamespace, runtimeRole });
      // Permit the fixture to assume the restricted role without changing runtime authority.
      await admin.query(`GRANT "${runtimeRole}" TO CURRENT_USER`);
      await withMigrationConnection(connectionString, async (client) => {
        await reconcileComponentNamespaces(client, metadataNamespace, scopes);
        for (const [index, scope] of scopes.entries()) {
          const schema = defineSchema((f) => ({ products: { title: f.text() } }), { namespace: scope.namespace });
          const initial = await planMigration(await emptySnapshot(scope.namespace), schema);
          const migrations = `migrations/components/${scope.namespace}`;
          await writeMigration(root, migrations, "initial", initial);
          const options = { root, migrations, namespace: scope.namespace, metadataNamespace, runtimeRole };
          await applyMigrationsOnConnection(client, options);
          await admin.query(`SET ROLE "${runtimeRole}"`);
          await admin.query(`INSERT INTO "${scope.namespace}".products(title) VALUES($1)`, [`row-${index}`]);
          await assert.rejects(admin.query(`ALTER TABLE "${scope.namespace}".products ADD COLUMN denied text`));
          await admin.query("RESET ROLE");
          const expanded = defineSchema((f) => ({ products: { title: f.text(), description: f.text() } }), {
            namespace: scope.namespace,
          });
          const upgrade = await planMigration(initial.snapshot, expanded, [], initial.hash);
          await writeMigration(root, migrations, "expand", upgrade);
          await applyMigrationsOnConnection(client, options);
          expect((await applyMigrationsOnConnection(client, options)).applied).toEqual([]);
          expect((await admin.query(`SELECT title FROM "${scope.namespace}".products`)).rows).toEqual([
            { title: `row-${index}` },
          ]);
        }
        const first = scopes[0];
        assert(first);
        await assert.rejects(
          reconcileComponentNamespaces(client, metadataNamespace, [{ ...first, mountPath: "renamed" }]),
          /identity collision/,
        );
        await reconcileComponentNamespaces(client, metadataNamespace, [first]);
        expect(
          (await admin.query(`SELECT state FROM "${metadataNamespace}".component_namespaces ORDER BY mount_path`)).rows,
        ).toEqual([{ state: "mounted" }, { state: "detached" }]);
        expect(
          (
            await admin.query(
              `SELECT namespace,count(*)::int AS count FROM "${metadataNamespace}".migration_history GROUP BY namespace`,
            )
          ).rows,
        ).toHaveLength(2);
        for (const scope of scopes)
          expect((await admin.query(`SELECT count(*)::int AS count FROM "${scope.namespace}".products`)).rows).toEqual([
            { count: 1 },
          ]);
      });
    } finally {
      await admin.query("RESET ROLE");
      for (const scope of scopes) await admin.query(`DROP SCHEMA IF EXISTS "${scope.namespace}" CASCADE`);
      await admin.query(`DROP SCHEMA IF EXISTS "${metadataNamespace}" CASCADE`);
      await admin.query(`DROP ROLE IF EXISTS "${runtimeRole}"`);
      await admin.end();
      await rm(root, { recursive: true, force: true });
    }
  },
  migrationTestTimeout,
);

test.skipIf(!connectionString)(
  "a second-scope failure withholds runtime activation and a repaired rerun resumes",
  async () => {
    assert(connectionString);
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const namespace = `app_${suffix}`;
    const metadataNamespace = `loom_meta_${suffix}`;
    const runtimeRole = `loom_runtime_${suffix}`;
    const root = await mkdtemp(join(tmpdir(), "loom-component-release-"));
    const admin = new pg.Client({ connectionString });
    await admin.connect();
    const address = new URL(connectionString);
    const endpointId = address.hostname.split(".")[0] ?? "";
    const provider: DeploymentDatabaseProvider = {
      getProject: async () => ({ id: "project", name: "scopes", regionId: "aws-us-east-2", pgVersion: 18 }),
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
    const paths = [`first_${suffix}`, `second_${suffix}`];
    try {
      await initializeProject(root, "scopes");
      await mkdir(join(root, "node_modules"));
      for (const name of ["kello", "kello-cli", "valibot", "zod", "drizzle-orm"])
        await symlink(
          await realpath(fileURLToPath(new URL(`../../tests/node_modules/${name}`, import.meta.url))),
          join(root, "node_modules", name),
        );
      await rm(join(root, "kello/functions/tasks.ts"));
      await rm(join(root, "kello/contracts/tasks.ts"));
      await writeFile(
        join(root, "kello/schema.ts"),
        `import { defineSchema } from "kello/server"; export default defineSchema((f) => ({ tasks: { title: f.text() } }), { namespace: ${JSON.stringify(namespace)} });`,
      );
      await writeFile(
        join(root, "kello.config.ts"),
        `import { defineConfig } from "kello-cli"; export default defineConfig(${JSON.stringify({ project: "scopes", database: { namespace, metadataNamespace }, provider: { projectId: "project", targets: { preview: { branchId: "br-preview" } } } })});`,
      );
      const directory = join(root, "kello/components/catalog");
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, "setup.ts"),
        `import { defineComponent } from "kello"; export default defineComponent({ name: "catalog" });`,
      );
      const schema = (required: boolean) =>
        `import { defineSchema } from "kello/server"; export default defineSchema((f) => ({ products: { title: f.text()${required ? ".notNull()" : ""} } }));`;
      await writeFile(join(directory, "schema.ts"), schema(false));
      await writeFile(
        join(root, "kello/app.config.ts"),
        `import { defineApplication } from "kello"; import catalog from "./components/catalog/setup"; const app = defineApplication({ rpc: ({ os }) => ({ os }) }); ${paths.map((path) => `app.use(catalog, { name: ${JSON.stringify(path)} });`).join(" ")} export default app;`,
      );
      await generateProject(root);
      await generateRelease(root, "initial");
      const initialProject = await loadProject(root);
      await bootstrapDatabase({ connectionString, metadataNamespace, runtimeRole });
      await withMigrationConnection(connectionString, async (client) => {
        await reconcileComponentNamespaces(client, metadataNamespace, initialProject.componentScopes);
        for (const scope of [
          { namespace, migrations: "kello/_generated/migrations" },
          ...initialProject.componentScopes.map((scope) => ({
            namespace: scope.namespace,
            migrations: `kello/_generated/migrations/components/${scope.namespace}`,
          })),
        ])
          await applyMigrationsOnConnection(client, { root, ...scope, metadataNamespace, runtimeRole });
      });
      const second = initialProject.componentScopes[1];
      assert(second);
      await admin.query(`INSERT INTO "${second.namespace}".products(title) VALUES(NULL)`);
      await writeFile(join(directory, "schema.ts"), schema(true));
      await generateProject(root);
      await generateRelease(root, "required");
      const project = await loadProject(root);
      const application = await readMigrations(root, "kello/_generated/migrations");
      const head = application.at(-1);
      assert(head);
      const componentScopes = await Promise.all(
        project.componentScopes.map(async (scope) => {
          const migrations = `kello/_generated/migrations/components/${scope.namespace}`;
          const history = await readMigrations(root, migrations);
          const latest = history.at(-1);
          assert(latest);
          return {
            mountPath: scope.mountPath,
            namespace: scope.namespace,
            migrations,
            migrationHashes: history.map((entry) => entry.plan.hash),
            schema: { minimum: latest.plan.after, maximum: latest.plan.after, target: latest.plan.after },
          };
        }),
      );
      const options = {
        releaseKey: "b".repeat(64),
        inputHash: "c".repeat(64),
        deployment: "preview",
        version: project.version,
        activationToken: "d".repeat(64),
        environment: "preview" as const,
        databaseName: decodeURIComponent(address.pathname.slice(1)),
        migrationRole: decodeURIComponent(address.username),
        runtimeRole,
        quarantine: "preserve" as const,
        reviewedHashes: [
          ...application.map((entry) => entry.plan.hash),
          ...componentScopes.flatMap((scope) => scope.migrationHashes),
        ],
        migrationHashes: application.map((entry) => entry.plan.hash),
        schema: { minimum: head.plan.after, maximum: head.plan.after, target: head.plan.after },
        componentScopes,
      };
      let activated = false;
      const activate = async () =>
        withNeonReleaseDatabase(
          root,
          options,
          async ({ activation }) => {
            await activation.activate();
            activated = true;
          },
          provider,
        );
      await assert.rejects(activate());
      expect(activated).toBe(false);
      expect(
        (await admin.query(`SELECT 1 FROM "${metadataNamespace}".deployment_activations WHERE state='active'`))
          .rowCount,
      ).toBe(0);
      await admin.query(`UPDATE "${second.namespace}".products SET title='repaired'`);
      await activate();
      expect(activated).toBe(true);
      expect((await admin.query(`SELECT title FROM "${second.namespace}".products`)).rows).toEqual([
        { title: "repaired" },
      ]);
    } finally {
      for (const path of paths) await admin.query(`DROP SCHEMA IF EXISTS "${componentNamespace(path)}" CASCADE`);
      await admin.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
      await admin.query(`DROP SCHEMA IF EXISTS "${metadataNamespace}" CASCADE`);
      await admin.query(`DROP ROLE IF EXISTS "${runtimeRole}"`);
      await admin.end();
      await rm(root, { recursive: true, force: true });
    }
  },
  migrationTestTimeout,
);

test.skipIf(!connectionString)(
  "simulated schema-only clone adopts all component histories and detached ownership atomically",
  async () => {
    assert(connectionString);
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const targetName = `baseline_${suffix}`;
    const metadataNamespace = `loom_meta_${suffix}`;
    const runtimeRole = `loom_runtime_${suffix}`;
    const scopes = ["first", "second"].map((name) => ({
      mountPath: `${name}_${suffix}`,
      namespace: componentNamespace(`${name}_${suffix}`),
    }));
    const root = await mkdtemp(join(tmpdir(), "loom-component-baseline-"));
    const admin = new pg.Client({ connectionString });
    await admin.connect();
    const targetUrl = new URL(connectionString);
    targetUrl.pathname = `/${targetName}`;
    let targetCreated = false;
    try {
      await admin.query(`CREATE DATABASE "${targetName}"`);
      targetCreated = true;
      for (const uri of [connectionString, targetUrl.href]) {
        await bootstrapDatabase({ connectionString: uri, metadataNamespace, runtimeRole });
        await withMigrationConnection(uri, async (client) => {
          await reconcileComponentNamespaces(client, metadataNamespace, scopes);
          for (const scope of scopes) {
            const migrations = `migrations/components/${scope.namespace}`;
            if (uri === connectionString) {
              const schema = defineSchema((f) => ({ products: { title: f.text() } }), { namespace: scope.namespace });
              await writeMigration(
                root,
                migrations,
                "initial",
                await planMigration(await emptySnapshot(scope.namespace), schema),
              );
            }
            await applyMigrationsOnConnection(client, {
              root,
              namespace: scope.namespace,
              migrations,
              metadataNamespace,
              runtimeRole,
            });
          }
          const first = scopes[0];
          assert(first);
          await reconcileComponentNamespaces(client, metadataNamespace, [first]);
        });
      }
      // Identical runner-created DDL/grants, with every metadata row removed, models a schema-only copy.
      await withBaselineConnection(targetUrl.href, async (client) => {
        for (const table of [
          "framework_migrations",
          "migration_history",
          "component_namespaces",
          ...scopes.map((scope) => ormHistoryTable(scope.namespace)),
        ])
          await client.query(`TRUNCATE "${metadataNamespace}"."${table}"`);
      });
      await withBaselineConnection(connectionString, async (source) => {
        const ownership = (
          await source.query<{ mount_path: string; namespace: string; state: string }>(
            `SELECT mount_path,namespace,state FROM "${metadataNamespace}".component_namespaces ORDER BY mount_path`,
          )
        ).rows;
        const entries: {
          baseline: Awaited<ReturnType<typeof captureSchemaBaseline>>;
          artifacts: Awaited<ReturnType<typeof readMigrations>>;
        }[] = [];
        for (const scope of scopes) {
          const artifacts = await readMigrations(root, `migrations/components/${scope.namespace}`);
          entries.push({
            baseline: await captureSchemaBaseline(source, { namespace: scope.namespace, metadataNamespace }, artifacts),
            artifacts,
          });
        }
        await withBaselineConnection(targetUrl.href, async (target) => {
          await assert.rejects(establishSchemaBaselines(source, target, entries, []), /ownership/);
          expect(
            (await target.query(`SELECT count(*)::int AS count FROM "${metadataNamespace}".migration_history`)).rows,
          ).toEqual([{ count: 0 }]);
          await establishSchemaBaselines(source, target, entries, ownership);
          await establishSchemaBaselines(source, target, entries, ownership);
          expect(
            (await target.query(`SELECT count(*)::int AS count FROM "${metadataNamespace}".migration_history`)).rows,
          ).toEqual([{ count: 2 }]);
          expect(
            (
              await target.query(
                `SELECT mount_path,namespace,state FROM "${metadataNamespace}".component_namespaces ORDER BY mount_path`,
              )
            ).rows,
          ).toEqual(ownership);
          expect((await target.query(`SELECT 1 FROM "${metadataNamespace}".deployment_activations`)).rowCount).toBe(0);
        });
      });
    } finally {
      if (targetCreated) await admin.query(`DROP DATABASE "${targetName}" WITH (FORCE)`);
      for (const scope of scopes) await admin.query(`DROP SCHEMA IF EXISTS "${scope.namespace}" CASCADE`);
      await admin.query(`DROP SCHEMA IF EXISTS "${metadataNamespace}" CASCADE`);
      await admin.query(`DROP ROLE IF EXISTS "${runtimeRole}"`);
      await admin.end();
      await rm(root, { recursive: true, force: true });
    }
  },
  migrationTestTimeout,
);
