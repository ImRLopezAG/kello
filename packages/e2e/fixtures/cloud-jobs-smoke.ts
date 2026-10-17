/** Explicit hosted-worker regression on the already authorized disposable branch. */
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import pg from "pg";
import {
  bootstrapDatabase,
  buildNeonFunctionBundle,
  createKelloNeonApi,
  defineConfig,
  inspectDeploymentTarget,
} from "kello/tooling";

const projectId = "late-moon-69483649";
const branchId = "br-dark-block-awbbt60w";
const run = crypto.randomUUID();
const suffix = run.replaceAll("-", "");
const slug = `kj${suffix.slice(0, 18)}`;
const metadataNamespace = `loom_cloud_jobs_${suffix}`;
const runtimeRole = `loom_cloud_role_${suffix}`;
const nonce = crypto.randomUUID();
const api = createKelloNeonApi();
const cleanupErrors: string[] = [];
const report = {
  run,
  slug,
  stage: "admission",
  deployed: false,
  hostedJob: false,
  functionRemoved: false,
  schemaRemoved: false,
  roleRemoved: false,
  failed: false,
  cleanupErrors,
};
let admin: pg.Client | undefined;
let databaseAttempted = false;
let deploymentId: number | undefined;
try {
  const target = await inspectDeploymentTarget(
    defineConfig({
      project: "acceptance",
      provider: { projectId, targets: { preview: { branchId, protected: false } } },
    }),
    "preview",
    api,
  );
  assert.equal(target.branchName, "loom-acceptance-kello-002-optimistic-20261007");
  assert.equal(target.endpointId, "ep-solitary-block-awijudvn");
  assert.equal(target.protected, false);
  assert(!(await api.listBranchFunctions(projectId, branchId)).some((entry) => entry.slug === slug));
  const databases = await api.listBranchDatabases(projectId, branchId);
  const database = databases.find((entry) => entry.name === "neondb");
  assert(database);
  const { uri } = await api.getConnectionUri(projectId, {
    branchId,
    endpointId: target.endpointId,
    databaseName: database.name,
    roleName: database.ownerName,
    pooled: false,
  });
  admin = new pg.Client({ connectionString: uri, connectionTimeoutMillis: 15_000 });
  await admin.connect();
  assert.deepEqual(
    (await admin.query("SELECT nspname FROM pg_namespace WHERE nspname=$1", [metadataNamespace])).rows,
    [],
  );
  assert.deepEqual((await admin.query("SELECT rolname FROM pg_roles WHERE rolname=$1", [runtimeRole])).rows, []);
  report.stage = "bootstrap";
  databaseAttempted = true;
  await bootstrapDatabase({ connectionString: uri, metadataNamespace, runtimeRole });
  const password = randomBytes(32).toString("hex");
  // Both SQL identifiers and the password are locally generated hex values, never caller input.
  await admin.query(`ALTER ROLE "${runtimeRole}" LOGIN PASSWORD '${password}'`);
  await admin.query(`CREATE TABLE "${metadataNamespace}".counter(value integer NOT NULL)`);
  await admin.query(`INSERT INTO "${metadataNamespace}".counter VALUES(0)`);
  await admin.query(`GRANT SELECT,UPDATE ON "${metadataNamespace}".counter TO "${runtimeRole}"`);
  const runtime = new URL(uri);
  runtime.username = runtimeRole;
  runtime.password = password;
  report.stage = "bundle";
  const bundle = await buildNeonFunctionBundle(new URL("./cloud-jobs-entry.ts", import.meta.url).pathname);
  report.stage = "deploy";
  const deployed = await api.deployBranchFunction(projectId, branchId, slug, {
    bundle,
    runtime: "nodejs24",
    environment: { KELLO_RUNTIME_URL: runtime.href, KELLO_METADATA: metadataNamespace, KELLO_PROBE_NONCE: nonce },
  });
  deploymentId = deployed.id;
  const signal = AbortSignal.timeout(180_000);
  for (;;) {
    signal.throwIfAborted();
    const current = (await api.listBranchFunctions(projectId, branchId)).find((entry) => entry.slug === slug);
    assert.notEqual(current?.currentDeployment?.status, "failed");
    if (current?.activeDeploymentId === deploymentId && current.currentDeployment?.status === "completed") {
      report.deployed = true;
      report.stage = "job";
      const response = await fetch(new URL("/api/kello/rpc/probe", current.invocationUrl), {
        method: "POST",
        headers: {
          origin: "https://kello-smoke.invalid",
          "content-type": "application/json",
          "x-loom-protocol": "loom-orpc-2",
          "x-loom-version": "a".repeat(64),
        },
        body: JSON.stringify({ json: { nonce } }),
        signal: AbortSignal.timeout(60_000),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { json: { succeeded: true, value: 7 } });
      assert.deepEqual((await admin.query(`SELECT value FROM "${metadataNamespace}".counter`)).rows, [{ value: 7 }]);
      report.hostedJob = true;
      report.stage = "complete";
      break;
    }
    await setTimeout(1000, undefined, { signal });
  }
} catch {
  report.failed = true;
  process.exitCode = 1;
} finally {
  try {
    const current = (await api.listBranchFunctions(projectId, branchId)).find((entry) => entry.slug === slug);
    if (current) {
      assert(deploymentId && current.currentDeployment?.id === deploymentId, "Ambiguous Function ownership");
      await api.deleteBranchFunction(projectId, branchId, slug);
    }
    assert(!(await api.listBranchFunctions(projectId, branchId)).some((entry) => entry.slug === slug));
    report.functionRemoved = true;
  } catch {
    cleanupErrors.push("function");
  }
  if (admin && databaseAttempted && report.functionRemoved) {
    try {
      await admin.query(`DROP SCHEMA IF EXISTS "${metadataNamespace}" CASCADE`);
      report.schemaRemoved =
        (await admin.query("SELECT nspname FROM pg_namespace WHERE nspname=$1", [metadataNamespace])).rowCount === 0;
    } catch {
      cleanupErrors.push("schema");
    }
    try {
      await admin.query(`DROP ROLE IF EXISTS "${runtimeRole}"`);
      report.roleRemoved =
        (await admin.query("SELECT rolname FROM pg_roles WHERE rolname=$1", [runtimeRole])).rowCount === 0;
    } catch {
      cleanupErrors.push("role");
    }
  }
  try {
    await admin?.end();
  } catch {
    cleanupErrors.push("admin");
  }
  if (cleanupErrors.length) {
    report.failed = true;
    process.exitCode = 1;
  }
  await writeFile(join(tmpdir(), `kello-cloud-u6-jobs-${run}.json`), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report));
}
