import { initializeProject } from "kello/tooling";
import assert from "node:assert/strict";
import { mkdir, realpath, symlink, writeFile, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { unzipSync } from "fflate";
import pg from "pg";
import * as v from "valibot";
import { createRealNeonApi } from "@neon/config-runtime/v1";
import type { NeonApi } from "@neon/config-runtime/v1";
import type { NeonEntrypointApplication } from "kello/neon";
import { RPCLink } from "@orpc/client/fetch";
import { RPCSerializer } from "@orpc/client";
import { encodeRpcJobCall } from "kello/server";
import {
  generateRelease,
  generateCustomRelease,
  loadProject,
  deployNeonRelease,
  deployProjectRelease,
  planProjectRelease,
  inspectNeonFunctionHealth,
  retireNeonReleaseDatabase,
  retireProjectReleaseDatabase,
} from "kello/tooling";

const [root, certificate, key] = process.argv.slice(2);
const connectionString = process.env.LOOM_TEST_DATABASE_URL;
if (!root || !certificate || !key || !connectionString) throw new Error("Missing fixture inputs");
const suffix = crypto.randomUUID().replaceAll("-", "");
const namespace = `app_${suffix}`;
const metadataNamespace = `loom_${suffix}`;
const runtimeRole = `runtime_${suffix}`;
const admin = new pg.Client({ connectionString });
await admin.connect();
const runtime = new URL(connectionString);
const migrationRole = decodeURIComponent(runtime.username);
runtime.username = runtimeRole;
runtime.password = "loom-test-only";
const apps = new Map<string, NeonEntrypointApplication>();
const supersededWorkers: NeonEntrypointApplication[] = [];
const functions: Awaited<ReturnType<NeonApi["listBranchFunctions"]>> = [];
const triggers: Awaited<ReturnType<NeonApi["listBranchTriggers"]>> = [];
const buckets: Awaited<ReturnType<NeonApi["listBranchBuckets"]>> = [];
let healthFailure = true;
let legacyWorkerHealth = false;
let healthDrift = false;
let healthTriggerDrift = false;
let healthRoleDrift = false;
let triggerFailure = true;
let deploymentId = 0;
let enableWrites = 0;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  tls: { cert: await readFile(certificate), key: await readFile(key) },
  async fetch(request) {
    const url = new URL(request.url);
    const role = url.pathname.split("/")[1] ?? "";
    const app = apps.get(role);
    if (!app) return new Response("Not found", { status: 404 });
    url.pathname = url.pathname.slice(role.length + 1);
    if (url.pathname === "/_loom/deployment/health" && healthFailure)
      return new Response("Unavailable", { status: 503 });
    const response = await app.fetch(new Request(url, request));
    if (url.pathname === "/_loom/deployment/health" && role === "worker" && healthDrift) {
      healthDrift = false;
      await admin.query(`ALTER TABLE "${namespace}".tasks ADD COLUMN external_change text`);
    }
    if (url.pathname === "/_loom/deployment/health" && role === "worker" && healthTriggerDrift) {
      healthTriggerDrift = false;
      const trigger = triggers.find((entry) => entry.type === "schedule");
      assert.ok(trigger);
      trigger.cron = "0 * * * *";
    }
    if (url.pathname === "/_loom/deployment/health" && role === "worker" && healthRoleDrift) {
      healthRoleDrift = false;
      await admin.query(`ALTER ROLE "${runtimeRole}" BYPASSRLS`);
    }
    if (url.pathname === "/_loom/deployment/health" && role === "worker" && legacyWorkerHealth) {
      return Response.json(
        v.parse(
          v.object({
            format: v.literal(1),
            version: v.string(),
            artifactHash: v.string(),
            role: v.string(),
          }),
          await response.json(),
        ),
      );
    }
    return response;
  },
});
const provider: NeonApi = {
  ...createRealNeonApi({ apiKey: "fixture", baseUrl: "http://127.0.0.1:1" }),
  getProject: async () => ({ id: "project", name: "test", regionId: "aws-us-east-2", pgVersion: 18 }),
  listBranches: async () => [{ id: "br-preview", name: "preview", protected: false, isDefault: false }],
  listEndpoints: async () => [
    {
      id: runtime.hostname.split(".")[0] ?? "",
      branchId: "br-preview",
      type: "read_write",
      autoscalingLimitMinCu: 0.25,
      autoscalingLimitMaxCu: 1,
      suspendTimeout: 300,
    },
  ],
  getConnectionUri: async () => ({ uri: connectionString }),
  listBranchFunctions: async () => structuredClone(functions),
  listBranchBuckets: async () => structuredClone(buckets),
  createBranchBucket: async (_project, _branch, input) => {
    const bucket = { name: input.name, accessLevel: input.accessLevel ?? "private" };
    buckets.push(bucket);
    return bucket;
  },
  listBranchTriggers: async () => structuredClone(triggers),
  createBranchTrigger: async (_project, _branch, input) => {
    if (input.type !== "schedule" && input.type !== "storage_object_created") throw new Error("Unexpected trigger");
    const trigger = {
      ...input,
      functionPath: input.functionPath ?? "/",
      enabled: input.enabled ?? true,
      triggerId: crypto.randomUUID(),
      inherited: false,
      nextRunAt: null,
    };
    triggers.push(trigger);
    return trigger;
  },
  updateBranchTrigger: async (_project, _branch, id, input) => {
    const trigger = triggers.find((entry) => entry.triggerId === id);
    assert.ok(trigger);
    assert.equal(input.enabled, true);
    assert.deepEqual((await admin.query(`SELECT state FROM "${metadataNamespace}".deployment_activations`)).rows, [
      { state: "active" },
    ]);
    enableWrites++;
    if (enableWrites === 2 && triggerFailure) throw new Error("Interrupted trigger enablement");
    trigger.enabled = true;
    return trigger;
  },
  deployBranchFunction: async (_project, _branch, slug, input) => {
    assert.deepEqual((await admin.query(`SELECT state FROM "${metadataNamespace}".deployment_activations`)).rows, [
      { state: "quarantined" },
    ]);
    const id = ++deploymentId;
    const directory = join(root, "packed", String(id));
    for (const [filename, contents] of Object.entries(unzipSync(input.bundle))) {
      const destination = join(directory, filename);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, contents);
    }
    const loaded = v.parse(
      v.object({
        default: v.custom<NeonEntrypointApplication>((value) =>
          v.is(v.object({ fetch: v.function(), stop: v.function() }), value),
        ),
      }),
      await import(pathToFileURL(join(directory, "index.mjs")).href),
    );
    const previous = apps.get(slug);
    if (slug === "worker" && previous) supersededWorkers.push(previous);
    else await previous?.stop();
    apps.set(slug, loaded.default);
    const deployment = { id, status: "completed" as const };
    const fn = {
      id: `fn-${slug}`,
      name: slug,
      slug,
      invocationUrl: new URL(slug, server.url).href,
      activeDeploymentId: id,
      currentDeployment: deployment,
    };
    const index = functions.findIndex((entry) => entry.slug === slug);
    if (index === -1) functions.push(fn);
    else functions[index] = fn;
    return deployment;
  },
};
try {
  await admin.query(`CREATE ROLE "${runtimeRole}" LOGIN PASSWORD 'loom-test-only' NOINHERIT`);
  await initializeProject(root, "release");
  await writeFile(
    join(root, "kello/functions/tasks.ts"),
    `import { os } from "../_generated/rpc";
export default os.tasks.router({ list: os.tasks.list.handler(async ({ context: { db, tables } }) =>
  (await db.select({ title: tables.tasks.title }).from(tables.tasks)).map((row) => row.title)) });`,
  );
  await writeFile(
    join(root, "kello/auth.config.ts"),
    'import { defineRpcAuth } from "kello/server"; export default defineRpcAuth({ allowAnonymous: true, authorize: ({ path }) => { if (path.join(":") !== "tasks:list") throw new Error("Denied"); } });',
  );
  await mkdir(join(root, "node_modules/@kello"), { recursive: true });
  for (const name of ["kello", "valibot", "drizzle-orm"])
    await symlink(
      await realpath(fileURLToPath(new URL(`../../tests/node_modules/${name}`, import.meta.url))),
      join(root, "node_modules", name),
    );
  await writeFile(
    join(root, "kello.config.ts"),
    `import { defineConfig } from "kello/tooling"; export default defineConfig(${JSON.stringify({ project: "release", database: { namespace, metadataNamespace }, provider: { projectId: "project", targets: { preview: { branchId: "br-preview" } } } })});`,
  );
  await writeFile(
    join(root, "kello/storage.ts"),
    'import { defineProcedureStorage } from "kello/server"; export default defineProcedureStorage({ buckets: { uploads: {} } });',
  );
  await mkdir(join(root, "kello/internal"), { recursive: true });
  await mkdir(join(root, "kello/contracts/internal"), { recursive: true });
  await writeFile(
    join(root, "kello/contracts/internal/tasks.ts"),
    'import { defineContract, oc } from "kello/contract"; import * as v from "valibot"; export default defineContract({ retained: oc.output(v.null()) });',
  );
  await writeFile(
    join(root, "kello/internal/tasks.ts"),
    'import { os } from "../_generated/rpc"; export default os.internal.tasks.router({ retained: os.internal.tasks.retained.handler(() => null) });',
  );
  const schemaFile = join(root, "kello/schema.ts");
  await writeFile(
    schemaFile,
    (await readFile(schemaFile, "utf8")).replace('namespace: "app"', `namespace: "${namespace}"`),
  );
  const migration = await generateRelease(root, "initial");
  const project = await loadProject(root);
  const options = {
    releaseKey: "a".repeat(64),
    deployment: "preview",
    version: project.version,
    activationToken: "c".repeat(64),
    environment: "preview" as const,
    databaseName: decodeURIComponent(runtime.pathname.slice(1)),
    migrationRole,
    runtimeRole,
    quarantine: "clone" as const,
    reviewedHashes: [],
    migrationHashes: [migration.plan.hash],
    schema: { minimum: migration.plan.after, maximum: migration.plan.after, target: migration.plan.after },
    slugs: { service: "service", worker: "worker" },
    variables: { LOOM_DATABASE_URL: runtime.href },
  };
  Object.assign(process.env, {
    LOOM_DATABASE_URL: runtime.href,
    DATABASE_URL: runtime.href,
    NEON_BRANCH: "preview",
    LOOM_ACTIVATION_TOKEN: options.activationToken,
    AWS_ACCESS_KEY_ID: "fixture",
    AWS_SECRET_ACCESS_KEY: "fixture",
    AWS_ENDPOINT_URL_S3: "https://br-preview.storage.c-1.us-east-2.aws.neon.tech",
    AWS_REGION: "us-east-2",
  });
  const { activationToken: _token, variables: _variables, ...declaration } = options;
  const release = {
    format: 1,
    ...declaration,
    activationTokenEnv: "LOOM_ACTIVATION_TOKEN",
    variables: { LOOM_DATABASE_URL: "LOOM_DATABASE_URL" },
  };
  const releaseFile = join(root, "release.json");
  await writeFile(releaseFile, JSON.stringify({ ...release, activationToken: options.activationToken }));
  await assert.rejects(deployProjectRelease(root, "release.json", provider), /Invalid release declaration/);
  await writeFile(releaseFile, JSON.stringify({ ...release, variables: { LOOM_DATABASE_URL: "UNSET_RELEASE_URL" } }));
  await assert.rejects(deployProjectRelease(root, "release.json", provider), /Missing release environment value/);
  await writeFile(releaseFile, JSON.stringify({ ...release, variables: { LOOM_DATABASE_URL: "NEON_API_KEY" } }));
  await assert.rejects(deployProjectRelease(root, "release.json", provider), /Reserved release environment source/);
  await writeFile(releaseFile, JSON.stringify({ ...release, variables: { DATABASE_URL: "LOOM_DATABASE_URL" } }));
  await assert.rejects(
    deployProjectRelease(root, "release.json", provider),
    /Reserved release environment destination/,
  );
  await writeFile(releaseFile, JSON.stringify({ ...release, version: "f".repeat(64) }));
  await assert.rejects(deployProjectRelease(root, "release.json", provider), /Release source version changed/);
  await writeFile(releaseFile, JSON.stringify({ ...release, activationTokenEnv: "UNSET_RELEASE_TOKEN" }));
  await assert.rejects(deployProjectRelease(root, "release.json", provider), /Missing release environment value/);
  await writeFile(releaseFile, JSON.stringify(release));
  await assert.rejects(deployProjectRelease(root, "../release.json", provider), /escape/);
  await assert.rejects(
    deployProjectRelease(root, "release.json", provider, AbortSignal.abort(new Error("Cancelled release"))),
    /Cancelled release/,
  );
  assert.equal(deploymentId, 0);
  const readOnlyProvider: NeonApi = {
    ...provider,
    deployBranchFunction: async () => {
      throw new Error("Dry run attempted function deployment");
    },
    createBranchBucket: async () => {
      throw new Error("Dry run attempted bucket creation");
    },
    createBranchTrigger: async () => {
      throw new Error("Dry run attempted trigger creation");
    },
    updateBranchTrigger: async () => {
      throw new Error("Dry run attempted trigger update");
    },
  };
  delete process.env.LOOM_ACTIVATION_TOKEN;
  delete process.env.LOOM_DATABASE_URL;
  const initialPlan = await planProjectRelease(root, "release.json", readOnlyProvider);
  assert.equal(initialPlan.dryRun, true);
  assert.deepEqual(initialPlan.blockers, []);
  assert.equal(initialPlan.metadata, "initialize");
  assert.deepEqual(
    initialPlan.migrations.pending.map((entry) => entry.hash),
    [migration.plan.hash],
  );
  assert.deepEqual(
    initialPlan.functions.map((entry) => entry.action),
    ["create", "create"],
  );
  assert.deepEqual(initialPlan.buckets, [{ name: "uploads", action: "create" }]);
  assert.deepEqual(
    initialPlan.triggers.map((entry) => entry.action),
    ["create", "create"],
  );
  assert.equal(
    (await admin.query("SELECT to_regnamespace($1) AS namespace", [metadataNamespace])).rows[0].namespace,
    null,
  );
  await assert.rejects(readFile(join(root, ".kello/releases", options.releaseKey, "release.json")), { code: "ENOENT" });
  assert.deepEqual([functions, triggers, buckets], [[], [], []]);
  buckets.push({ name: "uploads", accessLevel: "public_read" });
  assert.ok(
    (await planProjectRelease(root, "release.json", readOnlyProvider)).blockers.some(
      (entry) => entry.code === "PRIVATE_BUCKET_REQUIRED",
    ),
  );
  buckets.pop();
  triggers.push({
    triggerId: "conflict",
    name: "loom:worker:jobs",
    type: "schedule",
    functionSlug: "someoneelse",
    functionPath: "/",
    enabled: true,
    inherited: false,
    cron: "* * * * *",
    nextRunAt: null,
  });
  assert.ok(
    (await planProjectRelease(root, "release.json", readOnlyProvider)).blockers.some(
      (entry) => entry.code === "TRIGGER_CONFLICT",
    ),
  );
  assert.equal(triggers[0]?.enabled, true);
  triggers.pop();
  process.env.LOOM_ACTIVATION_TOKEN = options.activationToken;
  process.env.LOOM_DATABASE_URL = runtime.href;
  await assert.rejects(deployNeonRelease(root, options, provider), /health verification failed/i);
  assert.equal(deploymentId, 4);
  assert.equal(enableWrites, 0);
  assert.deepEqual((await admin.query(`SELECT state FROM "${metadataNamespace}".deployment_activations`)).rows, [
    { state: "quarantined" },
  ]);
  healthFailure = false;
  healthDrift = true;
  await assert.rejects(deployNeonRelease(root, options, provider), /inconsistent/i);
  assert.ok(
    (await planProjectRelease(root, "release.json", readOnlyProvider)).blockers.some(
      (entry) => entry.code === "DATABASE_INCONSISTENT",
    ),
  );
  assert.equal(enableWrites, 0);
  assert.deepEqual((await admin.query(`SELECT state FROM "${metadataNamespace}".deployment_activations`)).rows, [
    { state: "quarantined" },
  ]);
  await admin.query(`ALTER TABLE "${namespace}".tasks DROP COLUMN external_change`);
  healthRoleDrift = true;
  await assert.rejects(deployNeonRelease(root, options, provider), /Runtime database preflight failed/);
  assert.equal(enableWrites, 0);
  await admin.query(`ALTER ROLE "${runtimeRole}" NOBYPASSRLS`);
  healthTriggerDrift = true;
  await assert.rejects(deployNeonRelease(root, options, provider), /Trigger activation incomplete/);
  assert.equal(enableWrites, 0);
  assert.deepEqual((await admin.query(`SELECT state FROM "${metadataNamespace}".deployment_activations`)).rows, [
    { state: "quarantined" },
  ]);
  const schedule = triggers.find((entry) => entry.type === "schedule");
  assert.ok(schedule);
  schedule.cron = "* * * * *";
  await assert.rejects(deployNeonRelease(root, options, provider), /Trigger activation incomplete/);
  assert.equal(triggers.filter((entry) => entry.enabled).length, 1);
  const receiptPath = join(root, ".kello/releases", options.releaseKey, "release.json");
  const saved = v.parse(
    v.looseObject({ completed: v.array(v.looseObject({ stage: v.string() })) }),
    JSON.parse(await readFile(receiptPath, "utf8")),
  );
  assert.equal(saved.completed.at(-1)?.stage, "activated");
  saved.completed = saved.completed.slice(0, -1);
  await writeFile(receiptPath, JSON.stringify(saved));
  await admin.query(
    `INSERT INTO "${metadataNamespace}".jobs (id, deployment, deduplication_key, fingerprint, call, identity, due_at, max_attempts, retry_delay_seconds) VALUES (uuidv7(), 'preview', 'keep', repeat('a', 64), $1::jsonb, 'null', now(), 1, 0)`,
    [JSON.stringify(encodeRpcJobCall(project.version, ["tasks", "retained"], undefined))],
  );
  triggerFailure = false;
  const completed = await deployProjectRelease(root, "release.json", provider);
  assert.deepEqual(
    completed.completed.map((stage) => stage.stage),
    [
      "metadata",
      "quarantine",
      "migrations",
      "prepared",
      "bootstrap",
      "triggers",
      "functions",
      "health",
      "activated",
      "complete",
    ],
  );
  const finalFunctions = completed.completed.find((stage) => stage.stage === "functions");
  assert.ok(finalFunctions);
  await admin.query(`INSERT INTO "${metadataNamespace}".deployment_trigger_bindings
    SELECT deployment,version,project_id,'br-other','{}'::jsonb FROM "${metadataNamespace}".deployment_trigger_bindings`);
  const bootstrapWorker = supersededWorkers[0];
  assert.ok(bootstrapWorker);
  const wake = triggers.find((trigger) => trigger.name === "loom:worker:jobs");
  assert.ok(wake);
  await admin.query(`UPDATE "${metadataNamespace}".jobs SET due_at=now()+interval '1 day'`);
  const delivery = await bootstrapWorker.fetch(
    new Request("https://worker.test/api/kello/triggers", {
      method: "POST",
      headers: { "content-type": "application/json", "x-neon-trigger-invocation-id": "bootstrap-wake" },
      body: JSON.stringify({
        version: 1,
        invocation_id: "bootstrap-wake",
        trigger: { type: "schedule", id: wake.triggerId, name: wake.name },
        data: { scheduled_at: new Date().toISOString() },
      }),
    }),
  );
  assert.equal(delivery.status, 200, "A still-routed bootstrap must use the release's verified trigger bindings");
  const unbound = await bootstrapWorker.fetch(
    new Request("https://worker.test/api/kello/triggers", {
      method: "POST",
      headers: { "content-type": "application/json", "x-neon-trigger-invocation-id": "unbound" },
      body: JSON.stringify({
        version: 1,
        invocation_id: "unbound",
        trigger: { type: "schedule", id: "unknown", name: wake.name },
        data: { scheduled_at: new Date().toISOString() },
      }),
    }),
  );
  assert.equal(unbound.status, 403);
  const runtimeClient = new pg.Client({ connectionString: runtime.href });
  try {
    await runtimeClient.connect();
    assert.equal(
      (await runtimeClient.query(`SELECT bindings FROM "${metadataNamespace}".deployment_trigger_bindings`)).rowCount,
      2,
    );
    await assert.rejects(
      runtimeClient.query(`UPDATE "${metadataNamespace}".deployment_trigger_bindings SET bindings='{}'`),
      /permission denied/,
    );
  } finally {
    await runtimeClient.end();
  }
  const savedBindings = await admin.query<{ bindings: unknown }>(
    `SELECT bindings FROM "${metadataNamespace}".deployment_trigger_bindings WHERE branch_id='br-preview'`,
  );
  await admin.query(`UPDATE "${metadataNamespace}".deployment_trigger_bindings SET bindings='{}'`);
  await assert.rejects(deployProjectRelease(root, "release.json", provider), /trigger bindings changed/);
  assert.deepEqual(
    (
      await admin.query(
        `SELECT bindings FROM "${metadataNamespace}".deployment_trigger_bindings WHERE branch_id='br-preview'`,
      )
    ).rows,
    [{ bindings: {} }],
  );
  await admin.query(
    `UPDATE "${metadataNamespace}".deployment_trigger_bindings SET bindings=$1::jsonb WHERE branch_id='br-preview'`,
    [JSON.stringify(savedBindings.rows[0]?.bindings)],
  );
  await admin.query(`UPDATE "${metadataNamespace}".jobs SET due_at=now()`);
  const drainHealth = await inspectNeonFunctionHealth(
    root,
    {
      config: project.config,
      environment: options.environment,
      artifactHash: finalFunctions.artifactHash,
      activationToken: options.activationToken,
    },
    provider,
  );
  assert.deepEqual(
    drainHealth.functions.map((fn) => fn.databaseDrainProtocol),
    [1, 1],
  );
  assert.equal(deploymentId, 4);
  assert.equal(enableWrites, 3);
  assert.ok(triggers.every((entry) => entry.enabled));
  assert.deepEqual((await admin.query(`SELECT state FROM "${metadataNamespace}".jobs`)).rows, [{ state: "pending" }]);
  await admin.query(`INSERT INTO "${namespace}".tasks (title) VALUES ('deployed')`);
  const client = new RPCLink({
    origin: server.url.origin,
    url: "/service/api/kello/rpc",
    headers: { "x-loom-protocol": "loom-orpc-2", "x-loom-version": project.version },
    serializer: new RPCSerializer({ omitUndefinedProperties: false }),
  });
  assert.deepEqual(await client.call(["tasks", "list"], undefined, { context: {} }), ["deployed"]);
  assert.deepEqual(await deployProjectRelease(root, "release.json", provider), completed);
  assert.equal(deploymentId, 4);
  assert.equal(enableWrites, 3);
  const retainedDeclaration = {
    ...release,
    releaseKey: "f".repeat(64),
    retainedReleaseKey: release.releaseKey,
    quarantine: "preserve",
  };
  await writeFile(join(root, "rollback.json"), JSON.stringify(retainedDeclaration));
  const rollbackPlan = await planProjectRelease(root, "rollback.json", readOnlyProvider);
  assert.deepEqual(rollbackPlan.blockers, []);
  assert.deepEqual(rollbackPlan.disableTriggerIds, []);
  assert.deepEqual(rollbackPlan.functionPasses, { bootstrap: "skip", final: "verify" });
  await admin.query(`UPDATE "${metadataNamespace}".deployment_activations SET state='quarantined' WHERE version=$1`, [
    project.version,
  ]);
  assert.ok(
    (await planProjectRelease(root, "rollback.json", readOnlyProvider)).blockers.some(
      (entry) => entry.code === "RETAINED_RUNTIME_INACTIVE",
    ),
  );
  await admin.query(`UPDATE "${metadataNamespace}".deployment_activations SET state='active' WHERE version=$1`, [
    project.version,
  ]);

  healthFailure = true;
  await assert.rejects(deployProjectRelease(root, "rollback.json", provider), /health verification failed/i);
  assert.deepEqual(
    (await admin.query(`SELECT release_key FROM "${metadataNamespace}".release_ingress WHERE state='current'`)).rows,
    [{ release_key: release.releaseKey }],
  );
  healthFailure = false;
  const restored = await deployProjectRelease(root, "rollback.json", provider);
  assert.equal(restored.completed.at(-1)?.stage, "complete");
  assert.equal(deploymentId, 4);
  assert.equal(enableWrites, 3);
  assert.deepEqual(await client.call(["tasks", "list"], undefined, { context: {} }), ["deployed"]);
  assert.deepEqual(await deployProjectRelease(root, "rollback.json", provider), restored);
  await assert.rejects(deployProjectRelease(root, "release.json", provider), /superseded/);
  // Restore the fixture's original claim for the independent planner fault-injection cases below.
  await admin.query(`UPDATE "${metadataNamespace}".release_ingress SET state='retired'`);
  await admin.query(`UPDATE "${metadataNamespace}".release_ingress SET state='current' WHERE release_key=$1`, [
    release.releaseKey,
  ]);
  healthFailure = true;
  const beforePlan = await readFile(receiptPath, "utf8");
  const providerBeforePlan = JSON.stringify({ functions, triggers, buckets });
  const resumedPlan = await planProjectRelease(root, "release.json", readOnlyProvider);
  assert.deepEqual(resumedPlan.blockers, []);
  assert.deepEqual(resumedPlan.ingressHandoff, { retainedWorkers: [], disableTriggerIds: [] });
  await admin.query(`UPDATE "${metadataNamespace}".release_ingress SET state='retired'`);
  assert.ok(
    (await planProjectRelease(root, "release.json", readOnlyProvider)).blockers.some(
      (entry) => entry.code === "RELEASE_SUPERSEDED",
    ),
  );
  await assert.rejects(deployProjectRelease(root, "release.json", provider), /superseded/);
  await admin.query(`UPDATE "${metadataNamespace}".release_ingress SET state='current' WHERE release_key=$1`, [
    release.releaseKey,
  ]);

  assert.deepEqual(resumedPlan.migrations.pending, []);
  assert.deepEqual(
    resumedPlan.functions.map((entry) => entry.action),
    ["verify", "verify"],
  );
  assert.deepEqual(
    resumedPlan.triggers.map((entry) => entry.action),
    ["verify", "verify"],
  );
  assert.equal(resumedPlan.acknowledgedStages.at(-1), "complete");
  assert.equal(await readFile(receiptPath, "utf8"), beforePlan);
  assert.equal(JSON.stringify({ functions, triggers, buckets }), providerBeforePlan);
  assert.deepEqual((await admin.query(`SELECT state FROM "${metadataNamespace}".jobs`)).rows, [{ state: "pending" }]);
  assert.ok(!JSON.stringify(resumedPlan).includes(options.activationToken));
  assert.ok(!JSON.stringify(resumedPlan).includes("loom-test-only"));
  await writeFile(releaseFile, JSON.stringify({ ...release, deployment: "other" }));
  const ownershipBeforePlan = (
    await admin.query(`SELECT * FROM "${metadataNamespace}".function_ownership ORDER BY slug`)
  ).rows;
  assert.ok(
    (await planProjectRelease(root, "release.json", readOnlyProvider)).blockers.some(
      (entry) => entry.code === "FUNCTION_NAMES_RESERVED",
    ),
  );
  assert.deepEqual(
    (await admin.query(`SELECT * FROM "${metadataNamespace}".function_ownership ORDER BY slug`)).rows,
    ownershipBeforePlan,
  );

  assert.ok(
    (await planProjectRelease(root, "release.json", readOnlyProvider)).blockers.some(
      (entry) => entry.code === "RECEIPT_IDENTITY_CHANGED",
    ),
  );
  await writeFile(releaseFile, JSON.stringify(release));
  const savedFunction = functions[0];
  assert.ok(savedFunction);
  const activeId = savedFunction.activeDeploymentId;
  assert.ok(activeId);
  savedFunction.activeDeploymentId = 999;
  assert.ok(
    (await planProjectRelease(root, "release.json", readOnlyProvider)).blockers.some(
      (entry) => entry.code === "FUNCTION_IDENTITY_CHANGED",
    ),
  );
  savedFunction.activeDeploymentId = activeId;
  const savedTrigger = triggers[0];
  assert.ok(savedTrigger);
  const savedPath = savedTrigger.functionPath;
  savedTrigger.functionPath = "/changed";
  assert.ok(
    (await planProjectRelease(root, "release.json", readOnlyProvider)).blockers.some(
      (entry) => entry.code === "TRIGGER_CONFLICT",
    ),
  );
  savedTrigger.functionPath = savedPath;
  await writeFile(releaseFile, JSON.stringify({ ...release, releaseKey: "d".repeat(64) }));
  const clonePlan = await planProjectRelease(root, "release.json", readOnlyProvider);
  assert.ok(clonePlan.blockers.some((entry) => entry.code === "ACTIVE_BRANCH_QUARANTINE"));
  assert.deepEqual(clonePlan.quarantine.observed, { activeGrants: "1", pendingJobs: "1" });
  await admin.query(`UPDATE "${metadataNamespace}".deployment_activations SET project_id = 'copied-project'`);
  await writeFile(releaseFile, JSON.stringify({ ...release, releaseKey: "d".repeat(64), quarantine: "preserve" }));
  assert.ok(
    (await planProjectRelease(root, "release.json", readOnlyProvider)).blockers.some(
      (entry) => entry.code === "QUARANTINE_REQUIRED",
    ),
  );
  assert.deepEqual((await admin.query(`SELECT state FROM "${metadataNamespace}".jobs`)).rows, [{ state: "pending" }]);
  await admin.query(`UPDATE "${metadataNamespace}".deployment_activations SET project_id = 'project'`);
  await writeFile(releaseFile, JSON.stringify(release));
  await assert.rejects(deployNeonRelease(root, options, provider), /health verification failed/i);
  assert.equal(deploymentId, 4);
  assert.equal(enableWrites, 3);
  await writeFile(join(root, "backfill.sql"), `UPDATE "${namespace}".tasks SET title = 'planned-not-applied'`);
  const custom = await generateCustomRelease(root, "backfill", "backfill.sql", "transactional");
  const expanded = {
    ...release,
    releaseKey: "e".repeat(64),
    quarantine: "preserve",
    migrationHashes: [...release.migrationHashes, custom.plan.hash],
  };
  await writeFile(releaseFile, JSON.stringify(expanded));
  // A foreign generation with no compatibility declaration must still block migration.
  await admin.query(
    `UPDATE "${metadataNamespace}".jobs SET call=jsonb_set(call,'{version}',to_jsonb(repeat('f',64))),claim_version=NULL WHERE deduplication_key='keep'`,
  );
  const unreviewed = await planProjectRelease(root, "release.json", readOnlyProvider);
  assert.ok(unreviewed.blockers.some((entry) => entry.code === "INCOMPATIBLE_RUNTIME"));
  const compatibilityBefore = (
    await admin.query(`SELECT * FROM "${metadataNamespace}".runtime_compatibility ORDER BY deployment,version`)
  ).rows;
  await admin.query(`UPDATE "${metadataNamespace}".jobs SET state='succeeded' WHERE state='pending'`);
  const compatiblePlan = await planProjectRelease(root, "release.json", readOnlyProvider);
  assert.ok(!compatiblePlan.blockers.some((entry) => entry.code === "INCOMPATIBLE_RUNTIME"));
  assert.deepEqual(
    (await admin.query(`SELECT * FROM "${metadataNamespace}".runtime_compatibility ORDER BY deployment,version`)).rows,
    compatibilityBefore,
  );
  await admin.query(`UPDATE "${metadataNamespace}".jobs SET state='pending' WHERE deduplication_key='keep'`);
  assert.ok(
    unreviewed.blockers.some((entry) => entry.code === "REVIEW_REQUIRED" && entry.resource === custom.plan.hash),
  );
  assert.equal(unreviewed.migrations.pending[0]?.reviewRequired, true);
  await writeFile(releaseFile, JSON.stringify({ ...expanded, reviewedHashes: [custom.plan.hash] }));
  assert.equal(
    (await planProjectRelease(root, "release.json", readOnlyProvider)).migrations.pending[0]?.reviewRequired,
    false,
  );
  await writeFile(join(root, "index.sql"), `CREATE INDEX CONCURRENTLY task_title ON "${namespace}".tasks(title)`);
  const concurrent = await generateCustomRelease(root, "index", "index.sql", "nontransactional");
  await writeFile(
    releaseFile,
    JSON.stringify({
      ...expanded,
      migrationHashes: [...expanded.migrationHashes, concurrent.plan.hash],
      reviewedHashes: [custom.plan.hash, concurrent.plan.hash],
    }),
  );
  assert.ok(
    (await planProjectRelease(root, "release.json", readOnlyProvider)).blockers.some(
      (entry) => entry.code === "NONTRANSACTIONAL_MIGRATION",
    ),
  );
  const retirement = {
    config: project.config,
    environment: options.environment,
    databaseName: options.databaseName,
    migrationRole,
    releaseKey: release.releaseKey,
    activationToken: options.activationToken,
  };
  await assert.rejects(
    retireNeonReleaseDatabase(root, { ...retirement, releaseKey: "8".repeat(64) }, provider),
    /completed release/i,
  );
  await assert.rejects(
    retireNeonReleaseDatabase(
      root,
      {
        ...retirement,
        config: { ...project.config, database: { ...project.config.database, namespace: "unrelated" } },
      },
      provider,
    ),
    /target differs/i,
  );
  healthFailure = false;
  await assert.rejects(retireNeonReleaseDatabase(root, retirement, provider), /ingress/i);
  await admin.query(`UPDATE "${metadataNamespace}".release_ingress SET state='retired'`);
  // Unidentifiable persisted work must conservatively prevent retirement.
  await admin.query(`UPDATE "${metadataNamespace}".jobs SET call='{}' WHERE deduplication_key='keep'`);
  await assert.rejects(retireNeonReleaseDatabase(root, retirement, provider), /jobs/i);
  await admin.query(
    `UPDATE "${metadataNamespace}".jobs SET call=jsonb_build_object('version',$1::text),state='running',lease_owner='retirement-test',lease_expires_at=clock_timestamp()+interval '1 minute' WHERE state='pending'`,
    [project.version],
  );
  await assert.rejects(retireNeonReleaseDatabase(root, retirement, provider), /jobs/i);
  await admin.query(
    `UPDATE "${metadataNamespace}".jobs SET state='pending',lease_owner=NULL,lease_expires_at=NULL WHERE state='running'`,
  );
  await admin.query(`UPDATE "${metadataNamespace}".jobs SET state='succeeded' WHERE state='pending'`);
  await admin.query(
    `INSERT INTO "${metadataNamespace}".client_sessions(namespace,deployment,version,ticket_hash,expires_at)
    VALUES ($1,$2,$3,repeat('9',64),clock_timestamp()+interval '1 hour')`,
    [namespace, options.deployment, project.version],
  );
  await assert.rejects(retireNeonReleaseDatabase(root, retirement, provider), /sessions/i);
  await admin.query(
    `UPDATE "${metadataNamespace}".client_sessions SET expires_at=clock_timestamp()-interval '1 second'`,
  );
  await assert.rejects(
    retireNeonReleaseDatabase(root, { ...retirement, activationToken: "0".repeat(64) }, provider),
    /grant/i,
  );
  await assert.rejects(
    retireNeonReleaseDatabase(root, { ...retirement, signal: AbortSignal.abort() }, provider),
    /aborted/i,
  );
  legacyWorkerHealth = true;
  await assert.rejects(retireNeonReleaseDatabase(root, retirement, provider), /drain support/i);
  legacyWorkerHealth = false;
  healthFailure = true;
  await assert.rejects(retireNeonReleaseDatabase(root, retirement, provider), /health verification failed/i);
  healthFailure = false;
  await admin.query(
    `ALTER TABLE "${metadataNamespace}".deployment_activations ADD CONSTRAINT refuse_retirement CHECK (state<>'retired')`,
  );
  try {
    await assert.rejects(retireNeonReleaseDatabase(root, retirement, provider), /refuse_retirement/);
  } finally {
    await admin.query(`ALTER TABLE "${metadataNamespace}".deployment_activations DROP CONSTRAINT refuse_retirement`);
  }
  await admin.query("BEGIN");
  await admin.query(`LOCK TABLE "${metadataNamespace}".deployment_activations IN ACCESS SHARE MODE`);
  try {
    await assert.rejects(retireNeonReleaseDatabase(root, retirement, provider), /drain/i);
  } finally {
    await admin.query("ROLLBACK");
  }
  assert.deepEqual((await admin.query(`SELECT state FROM "${metadataNamespace}".deployment_activations`)).rows, [
    { state: "active" },
  ]);
  await admin.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [`loom:migrations:${namespace}`]);
  try {
    await assert.rejects(
      retireNeonReleaseDatabase(root, { ...retirement, signal: AbortSignal.timeout(100) }, provider),
      /aborted|timeout/i,
    );
  } finally {
    await admin.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [`loom:migrations:${namespace}`]);
  }
  const retirementDeclaration = {
    format: 1,
    releaseKey: retirement.releaseKey,
    environment: retirement.environment,
    databaseName: retirement.databaseName,
    migrationRole,
    activationTokenEnv: "LOOM_TEST_RETIREMENT_TOKEN",
  };
  await writeFile(join(root, "retirement.json"), JSON.stringify(retirementDeclaration));
  await assert.rejects(retireProjectReleaseDatabase(root, "retirement.json", provider), /activation token/i);
  process.env.LOOM_TEST_RETIREMENT_TOKEN = options.activationToken;
  for (const activationTokenEnv of ["NEON_API_KEY", project.config.database.migrationUrlEnv]) {
    await writeFile(join(root, "retirement.json"), JSON.stringify({ ...retirementDeclaration, activationTokenEnv }));
    await assert.rejects(retireProjectReleaseDatabase(root, "retirement.json", provider), /reserved/i);
  }
  await writeFile(join(root, "retirement.json"), JSON.stringify(retirementDeclaration));
  const schemaSource = await readFile(schemaFile, "utf8");
  await writeFile(schemaFile, "This is deliberately invalid application source.");
  const retired = await retireProjectReleaseDatabase(root, "retirement.json", provider);
  assert.equal(retired.state, "retired");
  healthFailure = true;
  assert.deepEqual(await retireNeonReleaseDatabase(root, retirement, provider), retired);
  const providerServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      assert.equal(request.headers.get("authorization"), "Bearer retirement-fixture-key");
      assert.equal(request.method, "GET");
      switch (new URL(request.url).pathname) {
        case "/projects/project":
          return Response.json({
            project: {
              id: "project",
              name: "test",
              pg_version: 18,
              region_id: "aws-us-east-2",
              created_at: "2026-10-01T00:00:00Z",
            },
          });
        case "/projects/project/branches":
          return Response.json({
            branches: [
              {
                id: "br-preview",
                name: "preview",
                protected: false,
                default: false,
                created_at: "2026-10-01T00:00:00Z",
                init_source: "parent-data",
              },
            ],
          });
        case "/projects/project/endpoints":
          return Response.json({
            endpoints: [
              {
                id: runtime.hostname.split(".")[0],
                branch_id: "br-preview",
                type: "read_write",
                autoscaling_limit_min_cu: 0.25,
                autoscaling_limit_max_cu: 1,
                suspend_timeout_seconds: 300,
              },
            ],
          });
        case "/projects/project/connection_uri":
          return Response.json({ uri: connectionString });
        default:
          throw new Error("Unexpected retirement provider request");
      }
    },
  });
  try {
    const preload = join(root, ".kello/retirement-transport.mjs");
    await writeFile(
      preload,
      `
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.origin !== "https://console.neon.tech" || !url.pathname.startsWith("/api/v2/"))
    throw new Error("Unexpected test transport target");
  return originalFetch(new Request(new URL(url.pathname.slice("/api/v2".length) + url.search, ${JSON.stringify(providerServer.url.origin)}), request));
};
`,
    );
    const cli = fileURLToPath(new URL("../../../apps/kello/src/cli.ts", import.meta.url));
    const child = Bun.spawn(
      [
        process.execPath,
        "--preload",
        preload,
        cli,
        "retire",
        "database",
        "--retirement",
        "retirement.json",
        "--cwd",
        root,
        "--json",
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, NEON_API_KEY: "retirement-fixture-key" },
      },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    assert.equal(code, 0, stderr);
    assert.equal(stderr, "");
    assert.deepEqual(JSON.parse(stdout), { ok: true, command: "retire database", receipt: retired });
    assert.ok(!stdout.includes(options.activationToken));
  } finally {
    await providerServer.stop(true);
    delete process.env.LOOM_TEST_RETIREMENT_TOKEN;
    await writeFile(schemaFile, schemaSource);
  }
  assert.equal(await readFile(receiptPath, "utf8"), beforePlan);
  assert.equal(deploymentId, 4);
  assert.equal(enableWrites, 3);
  await assert.rejects(client.call(["tasks", "list"], undefined, { context: {} }));

  assert.ok(
    (await planProjectRelease(root, "release.json", readOnlyProvider)).blockers.some(
      (entry) => entry.code === "RUNTIME_RETIRED",
    ),
  );
  assert.deepEqual((await admin.query(`SELECT state FROM "${metadataNamespace}".deployment_activations`)).rows, [
    { state: "retired" },
  ]);
  assert.deepEqual((await admin.query(`SELECT title FROM "${namespace}".tasks`)).rows, [{ title: "deployed" }]);
  assert.equal((await admin.query("SELECT to_regclass($1) AS index", [`${namespace}.task_title`])).rows[0].index, null);
} finally {
  await Promise.all([...apps.values(), ...supersededWorkers].map((app) => app.stop()));
  await server.stop(true);
  await admin.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
  await admin.query(`DROP SCHEMA IF EXISTS "${metadataNamespace}" CASCADE`);
  await admin.query(`DROP ROLE IF EXISTS "${runtimeRole}"`);
  await admin.end();
}
