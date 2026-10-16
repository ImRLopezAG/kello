import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { generateRelease, initializeProject } from "kello/tooling";
import type { DeploymentDatabaseProvider } from "kello/tooling";
import { loadProject } from "../../../apps/kello/src/tooling/project/load";
import { quoteIdentifier } from "../../../apps/kello/src/tooling/migrations/connection";
import { ormHistoryTable } from "../../../apps/kello/src/tooling/migrations/state";
import { planProjectRelease } from "../../../apps/kello/src/tooling/deploy/neon/plan-release";

async function prepareFixture(root: string, url: string, admin: pg.Client, runtimeRole: string) {
  const address = new URL(url);
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const namespace = `app_${suffix}`;
  const metadataNamespace = `loom_${suffix}`;
  await initializeProject(root, "prefix-readiness");
  await mkdir(join(root, "node_modules"));
  for (const name of ["kello", "valibot", "drizzle-orm"])
    await symlink(
      await realpath(fileURLToPath(new URL(`../../tests/node_modules/${name}`, import.meta.url))),
      join(root, "node_modules", name),
    );
  await writeFile(
    join(root, "kello.config.ts"),
    `import {defineConfig} from "kello/tooling"; export default defineConfig(${JSON.stringify({ project: "prefix-readiness", database: { namespace, metadataNamespace }, provider: { projectId: "project", targets: { preview: { branchId: "br-preview" } } } })});`,
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
    activationToken: "c".repeat(64),
    deployment: "preview",
    version: project.version,
    environment: "preview" as const,
    databaseName: decodeURIComponent(address.pathname.slice(1)),
    migrationRole: decodeURIComponent(address.username),
    runtimeRole,
    quarantine: "clone" as const,
    reviewedHashes: [],
    migrationHashes: [artifact.plan.hash],
    schema: { minimum: artifact.plan.after, maximum: artifact.plan.after, target: artifact.plan.after },
  };
  let providerMutations = 0;
  async function unexpectedMutation(): Promise<never> {
    providerMutations++;
    throw new Error("Unexpected provider mutation");
  }
  const provider: DeploymentDatabaseProvider = {
    getProject: async () => ({ id: "project", name: "prefix-readiness", regionId: "test", pgVersion: 18 }),
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
    getConnectionUri: async () => ({ uri: url }),
  };
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
  return {
    root,
    url,
    admin,
    namespace,
    metadataNamespace,
    runtimeRole,
    schemaFile,
    artifact,
    options,
    provider,
    planner,
    providerMutations: () => providerMutations,
    migrations: project.config.database.migrations,
  };
}
export type FrameworkPrefixFixture = Awaited<ReturnType<typeof prepareFixture>>;

/** Uses the disposable database lifecycle from the baseline e2e fixtures. */
export async function withFrameworkPrefixFixture(operation: (fixture: FrameworkPrefixFixture) => Promise<void>) {
  const connectionString = process.env.LOOM_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("Missing PostgreSQL 18 test database");
  const database = `kello_prefix_${crypto.randomUUID().replaceAll("-", "")}`;
  const address = new URL(connectionString);
  address.pathname = `/${database}`;
  const root = await mkdtemp(join(tmpdir(), "kello-framework-prefix-"));
  const runtimeRole = `prefix_${crypto.randomUUID().replaceAll("-", "")}`;
  const control = new pg.Client({ connectionString });
  try {
    await control.connect();
    try {
      await control.query(`CREATE DATABASE ${quoteIdentifier(database)}`);
      const admin = new pg.Client({ connectionString: address.href });
      try {
        await admin.connect();
        try {
          await operation(await prepareFixture(root, address.href, admin, runtimeRole));
        } finally {
          if ((await admin.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [runtimeRole])).rowCount) {
            await admin.query(`GRANT ${quoteIdentifier(runtimeRole)} TO CURRENT_USER`);
            await admin.query(`DROP OWNED BY ${quoteIdentifier(runtimeRole)}`);
            await admin.query(`DROP ROLE ${quoteIdentifier(runtimeRole)}`);
          }
        }
      } finally {
        await admin.end();
      }
    } finally {
      await control.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(database)} WITH (FORCE)`);
    }
  } finally {
    try {
      await control.end();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}

export async function makeVersion26(fixture: FrameworkPrefixFixture) {
  const meta = quoteIdentifier(fixture.metadataNamespace);
  await fixture.admin.query("BEGIN");
  try {
    await fixture.admin.query(`DROP TABLE ${meta}.search_cursor_keys`);
    await fixture.admin.query(`DELETE FROM ${meta}.framework_migrations WHERE version>=27`);
    await fixture.admin.query("COMMIT");
  } catch (cause) {
    await fixture.admin.query("ROLLBACK");
    throw cause;
  }
}

export async function historySnapshot(fixture: FrameworkPrefixFixture) {
  const meta = quoteIdentifier(fixture.metadataNamespace);
  const runtimeScopesExist =
    (await fixture.admin.query("SELECT to_regclass($1) IS NOT NULL AS present", [`${meta}.runtime_scopes`])).rows[0]
      ?.present === true;
  const componentNamespacesExist =
    (await fixture.admin.query("SELECT to_regclass($1) IS NOT NULL AS present", [`${meta}.component_namespaces`]))
      .rows[0]?.present === true;
  return {
    framework: (await fixture.admin.query(`SELECT version,hash FROM ${meta}.framework_migrations ORDER BY version`))
      .rows,
    application: (await fixture.admin.query(`SELECT * FROM ${meta}.migration_history ORDER BY namespace,ordinal`)).rows,
    orm: (
      await fixture.admin.query(
        `SELECT * FROM ${meta}.${quoteIdentifier(ormHistoryTable(fixture.namespace))} ORDER BY id`,
      )
    ).rows,
    compatibility: (
      await fixture.admin.query(`SELECT * FROM ${meta}.runtime_compatibility ORDER BY namespace,deployment,version`)
    ).rows,
    data: (await fixture.admin.query(`SELECT * FROM ${quoteIdentifier(fixture.namespace)}.tasks ORDER BY "_id"`)).rows,
    jobs: (await fixture.admin.query(`SELECT * FROM ${meta}.jobs ORDER BY id`)).rows,
    grants: (await fixture.admin.query(`SELECT * FROM ${meta}.deployment_activations ORDER BY deployment`)).rows,
    ingress: (
      await fixture.admin.query(
        `SELECT * FROM ${meta}.release_ingress ORDER BY project_id,branch_id,deployment,release_key`,
      )
    ).rows,
    functionOwnership: (
      await fixture.admin.query(`SELECT * FROM ${meta}.function_ownership ORDER BY project_id,branch_id,slug`)
    ).rows,
    runtimeScopes: runtimeScopesExist
      ? (await fixture.admin.query(`SELECT * FROM ${meta}.runtime_scopes ORDER BY deployment,version,namespace`)).rows
      : null,
    componentNamespaces: componentNamespacesExist
      ? (await fixture.admin.query(`SELECT * FROM ${meta}.component_namespaces ORDER BY mount_path`)).rows
      : null,
    cursorTable: (await fixture.admin.query("SELECT to_regclass($1)::text AS relation", [`${meta}.search_cursor_keys`]))
      .rows,
  };
}
