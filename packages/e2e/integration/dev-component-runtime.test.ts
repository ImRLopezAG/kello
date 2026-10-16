import { startDevelopmentRuntime } from "../../../apps/kello/src/tooling/dev/runtime";
import { initializeProject } from "kello/tooling";
import assert from "node:assert/strict";
import { callExample } from "../fixtures/rpc-call";
import { expect, test } from "bun:test";
import { cp, mkdtemp, mkdir, readFile, realpath, symlink, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { loadProject, prepareProject, synchronizeDevelopment } from "kello/tooling";
import type { DevelopmentDatabaseProvider } from "kello/tooling";

const connectionString = process.env.LOOM_TEST_DATABASE_URL;
test.skipIf(!connectionString)(
  "development runtime mounts component procedures and keeps private calls off the public router",
  async () => {
    if (!connectionString) throw new Error("Missing test database");
    const root = await mkdtemp(join(tmpdir(), "loom-dev-runtime-"));
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const namespace = `app_${suffix}`;
    const metadataNamespace = `loom_${suffix}`;
    const runtimeRole = `runtime_${suffix}`;
    const componentNamespaces: string[] = [];
    const address = new URL(connectionString);
    const runtimeAddress = new URL(address);
    runtimeAddress.username = runtimeRole;
    runtimeAddress.password = "development-test-only";
    const admin = new pg.Client({ connectionString });
    await admin.connect();
    const runtimeUri = runtimeAddress.href;
    const branch = { id: "br-development", name: "development", protected: false, isDefault: false };
    const buckets: { name: string; accessLevel: "private" | "public_read" }[] = [];
    const provider: DevelopmentDatabaseProvider = {
      listBranchBuckets: async () => buckets,
      getProject: async () => ({ id: "project", name: "tasks", regionId: "test", pgVersion: 18 }),
      listBranches: async () => [branch],
      listEndpoints: async () => [
        {
          id: address.hostname.split(".")[0]!,
          branchId: "br-development",
          type: "read_write",
          autoscalingLimitMinCu: 0.25,
          autoscalingLimitMaxCu: 1,
          suspendTimeout: 300,
        },
      ],
      getConnectionUri: async (_project, request) => {
        return { uri: request.roleName === runtimeRole ? runtimeUri : connectionString };
      },
    };
    const options = {
      root,
      databaseName: decodeURIComponent(address.pathname.slice(1)),
      migrationRole: decodeURIComponent(address.username),
      runtimeRole,
      deployment: "local-development",
      activationToken: "e".repeat(64),
    };
    const runtimes: Awaited<ReturnType<typeof startDevelopmentRuntime>>["runtime"][] = [];
    try {
      await initializeProject(root, "tasks");
      await mkdir(join(root, "node_modules/@kello"), { recursive: true });
      for (const name of ["kello", "valibot", "drizzle-orm"])
        await symlink(
          await realpath(fileURLToPath(new URL(`../../tests/node_modules/${name}`, import.meta.url))),
          join(root, "node_modules", name),
        );
      await writeFile(
        join(root, "kello.config.ts"),
        `import { defineConfig } from "kello/tooling";
      export default defineConfig({project:"tasks",database:{namespace:"${namespace}",metadataNamespace:"${metadataNamespace}"},provider:{projectId:"project",targets:{development:{branchId:"br-development"}}}});`,
      );
      await writeFile(
        join(root, "kello/auth.config.ts"),
        'import { defineRpcAuth } from "kello/server"; export default defineRpcAuth({allowAnonymous:true, authorize: () => {}});',
      );
      const schemaFile = join(root, "kello/schema.ts");
      const initialSource = (await readFile(schemaFile, "utf8")).replace(
        'namespace: "app"',
        `namespace: "${namespace}"`,
      );
      await writeFile(schemaFile, initialSource);
      await cp(
        fileURLToPath(new URL("../../examples/tasks/kello/components/titles", import.meta.url)),
        join(root, "kello/components/titles"),
        { recursive: true, filter: (path) => !path.includes("_generated") },
      );
      await writeFile(
        join(root, "kello/components/titles/schema.ts"),
        'import { defineSchema } from "kello/server"; export default defineSchema((f) => ({ records: { title: f.text() } }));',
      );
      await writeFile(
        join(root, "kello/components/titles/crons.ts"),
        'import { procedureCron } from "kello/server"; import title from "./internal/title"; export default { tick: procedureCron("* * * * *", title.normalize, "cron") };',
      );
      await writeFile(
        join(root, "kello/app.config.ts"),
        `import { defineApplication } from "kello/server";
        import titles from "./components/titles/setup";
        const app = defineApplication({ rpc: ({ os }) => ({ os }) });
        app.use(titles, { name: "titles_${suffix}", public: "titles" }); export default app;`,
      );
      const first = await prepareProject(root);
      componentNamespaces.push(...(await loadProject(root)).componentScopes.map((scope) => scope.namespace));
      await synchronizeDevelopment({ ...options, sourceVersion: first.version }, provider);
      await admin.query(`ALTER ROLE "${runtimeRole}" LOGIN PASSWORD 'development-test-only'`);
      const startup = { ...options, sourceVersion: first.version };
      const started = await startDevelopmentRuntime(startup, provider);
      runtimes.push(started.runtime);
      if (!("router" in started.runtime)) throw new Error("Expected native fixture");
      assert.equal(started.binding.branchId, "br-development");
      assert.equal(started.binding.version, first.version);
      assert.equal(started.cronSchedules[`${componentNamespaces[0]}-tick`], "* * * * *");
      assert.ok(!JSON.stringify(started.binding).includes(options.activationToken));
      expect(await callExample(started.runtime, ["tasks", "list"], undefined, null)).toMatchObject({
        ok: true,
        value: [],
      });
      expect(
        await callExample(started.runtime, ["titles", "title", "prepare"], "  scoped title  ", null),
      ).toMatchObject({ ok: true, value: "scoped title" });
      expect(
        await callExample(started.runtime, ["titles", "internal", "title", "normalize"], "private", null),
      ).toMatchObject({ ok: false });
      await admin.query(`ALTER TABLE "${componentNamespaces[0]}".records ADD COLUMN unexpected text`);
      await assert.rejects(startDevelopmentRuntime(startup, provider), /database drift detected/);
    } finally {
      await Promise.all(runtimes.map((runtime) => runtime.stop()));
      for (const componentNamespace of componentNamespaces)
        await admin.query(`DROP SCHEMA IF EXISTS "${componentNamespace}" CASCADE`);
      await admin.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
      await admin.query(`DROP SCHEMA IF EXISTS "${metadataNamespace}" CASCADE`);
      await admin.query(`DROP ROLE IF EXISTS "${runtimeRole}"`);
      await admin.end();
      await rm(root, { recursive: true, force: true });
    }
  },
);
