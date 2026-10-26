import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  initializeProject,
  loadProject,
  generateRelease,
  readMigrations,
  componentNamespace,
  generateProject,
} from "kello-cli";

test("explicit auth component mounts own native migrations and retain removed plugin tables", async () => {
  const root = await mkdtemp(join(tmpdir(), "loom-auth-migrations-"));
  try {
    await initializeProject(root, "auth");
    await mkdir(join(root, "node_modules"));
    for (const name of ["kello", "kello-cli", "valibot", "zod", "drizzle-orm", "better-auth"])
      await symlink(
        await realpath(fileURLToPath(new URL(`../node_modules/${name}`, import.meta.url))),
        join(root, "node_modules", name),
      );
    const directory = join(root, "kello/components/identity");
    await mkdir(directory, { recursive: true });
    const writeAuth = (plugins: string) =>
      writeFile(
        join(directory, "setup.ts"),
        `
      import { defineBetterAuth } from "kello/better-auth";
      import { betterAuth } from "better-auth";
      import { organization } from "better-auth/plugins";
      export default defineBetterAuth({ name: "identity", env: {}, create: ({ database }) => betterAuth({
        database, secret: "test-only-auth-migration-secret-at-least-32-chars", baseURL: "https://auth.example.test", plugins: ${plugins}
      }) });
    `,
      );
    await writeAuth("[organization()]");
    await writeFile(
      join(root, "kello/app.config.ts"),
      `import { defineApplication } from "kello"; import identity from "./components/identity/setup"; const app = defineApplication({ rpc: ({ os }) => ({ os }) }); app.use(identity); export default app;`,
    );
    const project = await loadProject(root);
    expect(project.authScopes).toHaveLength(1);
    const result = await generateRelease(root, "initial");
    expect(result.scopes.map((scope) => scope.mountPath)).toContain("identity");
    const path = `kello/_generated/migrations/components/${componentNamespace("identity")}`;
    const history = await readMigrations(root, path);
    expect(history).toHaveLength(1);
    expect(history[0]?.plan.statements.join("\n")).toContain('"organization"');
    expect(history[0]?.plan.statements.join("\n")).not.toContain('"_id"');
    await writeAuth("[]");
    await rejects(generateRelease(root, "remove"), /no structural change/);
    const ownership = await readFile(join(root, path, ".auth-ownership.json"), "utf8");
    await generateProject(root);
    expect(await readFile(join(root, path, ".auth-ownership.json"), "utf8")).toBe(ownership);
    expect(await readMigrations(root, path)).toHaveLength(1);
    await writeAuth("[organization()]");
    await rejects(generateRelease(root, "restore"), /no structural change/);
    await writeFile(
      join(root, "kello/app.config.ts"),
      `import { defineApplication } from "kello"; export default defineApplication({ rpc: ({ os }) => ({ os }) });`,
    );
    expect((await loadProject(root)).authScopes).toHaveLength(0);
    expect(await readMigrations(root, path)).toHaveLength(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

const connectionString = process.env.LOOM_TEST_DATABASE_URL;
test.skipIf(!connectionString)(
  "migration runner grants native auth DML without entity triggers and preserves plugin records",
  async () => {
    const { Client } = await import("pg");
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const { betterAuth } = await import("better-auth");
    const { organization } = await import("better-auth/plugins");
    const { compileBetterAuthSchema, createBetterAuthDatabase } = await import("kello/better-auth");
    const {
      emptySnapshot,
      planMigration,
      writeMigration,
      applyMigrations,
      reconcileComponentNamespaces,
      withMigrationConnection,
    } = await import("kello-cli");
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const mountPath = `identity_${suffix}`;
    const namespace = componentNamespace(mountPath);
    const metadataNamespace = `loom_test_${suffix}`;
    const runtimeRole = `runtime_${suffix}`;
    const root = await mkdtemp(join(tmpdir(), "loom-auth-runner-"));
    const admin = new Client({ connectionString });
    await admin.connect();
    const migrations = "kello/_generated/migrations";
    try {
      const options = { advanced: { database: { generateId: "serial" as const } }, plugins: [organization()] };
      const schema = compileBetterAuthSchema(options, namespace);
      const plan = await planMigration(await emptySnapshot(namespace), {
        namespace,
        tables: schema.ownedTables,
        retainRemoved: true,
      });
      await writeMigration(root, migrations, "initial", plan);
      await applyMigrations({
        connectionString: connectionString!,
        root,
        migrations,
        namespace,
        metadataNamespace,
        runtimeRole,
      });
      const triggers = await admin.query(
        "SELECT tgname FROM pg_trigger JOIN pg_class ON tgrelid=pg_class.oid JOIN pg_namespace ON relnamespace=pg_namespace.oid WHERE nspname=$1 AND NOT tgisinternal",
        [namespace],
      );
      expect(triggers.rows).toEqual([]);
      await admin.query(`GRANT "${runtimeRole}" TO CURRENT_USER`);
      await admin.query(`SET ROLE "${runtimeRole}"`);
      const auth = betterAuth({
        ...options,
        database: createBetterAuthDatabase(drizzle({ client: admin }), namespace),
        secret: "test-only-auth-migration-secret-at-least-32-chars",
        baseURL: "https://auth.example.test",
        emailAndPassword: { enabled: true },
      });
      const user = await auth.api.signUpEmail({
        body: { email: "migration@example.test", password: "integration-password-1", name: "Owner" },
      });
      expect(user.user.id).toBeTruthy();
      await rejects(admin.query(`CREATE TABLE "${namespace}".forbidden(id text)`), /permission denied/);
      await admin.query(
        `INSERT INTO "${namespace}".organization(id, name, slug, "createdAt") VALUES (900, 'Retained', 'retained', now())`,
      );
      await admin.query("RESET ROLE");
      const removed = compileBetterAuthSchema({ advanced: options.advanced }, namespace);
      const removal = await planMigration(plan.snapshot, {
        namespace,
        tables: removed.ownedTables,
        retainRemoved: true,
      });
      expect(removal.statements).toEqual([]);
      const restored = await planMigration(removal.snapshot, {
        namespace,
        tables: schema.ownedTables,
        retainRemoved: true,
      });
      expect(restored.statements).toEqual([]);
      expect((await admin.query(`SELECT name FROM "${namespace}".organization WHERE id=900`)).rows).toEqual([
        { name: "Retained" },
      ]);
      // Register the already-created scope as owned, then verify detachment retains it.
      await admin.query(
        `INSERT INTO "${metadataNamespace}".component_namespaces(mount_path,namespace,state) VALUES($1,$2,'mounted')`,
        [mountPath, namespace],
      );
      await withMigrationConnection(connectionString!, (client) =>
        reconcileComponentNamespaces(client, metadataNamespace, []),
      );
      expect(
        (
          await admin.query(`SELECT state FROM "${metadataNamespace}".component_namespaces WHERE mount_path=$1`, [
            mountPath,
          ])
        ).rows,
      ).toEqual([{ state: "detached" }]);
      expect((await admin.query(`SELECT count(*)::int AS count FROM "${namespace}"."user"`)).rows).toEqual([
        { count: 1 },
      ]);
    } finally {
      await admin.query("RESET ROLE");
      await admin.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
      await admin.query(`DROP SCHEMA IF EXISTS "${metadataNamespace}" CASCADE`);
      await admin.query(`DROP ROLE IF EXISTS "${runtimeRole}"`);
      await admin.end();
      await rm(root, { recursive: true, force: true });
    }
  },
  90_000,
);
