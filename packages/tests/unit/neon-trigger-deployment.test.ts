import { expect, test } from "vite-plus/test";
import {
  defineConfig,
  disableNeonTriggers,
  prepareNeonScheduleTriggers,
  prepareNeonStorageTriggers,
  prepareNeonStorageBuckets,
} from "kello-cli";
import { activateNeonTriggers } from "../../../apps/kello-cli/src/tooling/deploy/neon/triggers";
import type { DeploymentTriggerProvider, DeploymentStorageProvider, DeploymentStorageTriggerProvider } from "kello-cli";

function fixture() {
  const branch = { id: "br-preview", name: "preview", protected: false, isDefault: false };
  const triggers: Awaited<ReturnType<DeploymentTriggerProvider["listBranchTriggers"]>> = [];
  const calls: string[] = [];
  const buckets: Awaited<ReturnType<DeploymentStorageProvider["listBranchBuckets"]>> = [];
  const state = {
    failName: "",
    ignoreDisable: false,
    renameAfterWrite: false,
    loseBucketResponse: false,
    publicBucket: false,
    workerDeployment: 1,
    changeWorkerAfterWrite: false,
    loseUpdateResponse: false,
    ignoreEnable: false,
  };
  const provider: DeploymentStorageProvider & DeploymentStorageTriggerProvider = {
    listBranchBuckets: async () => structuredClone(buckets),
    createBranchBucket: async (_project, _branch, input) => {
      calls.push(`bucket:${input.name}`);
      const bucket = {
        name: input.name,
        accessLevel: state.publicBucket ? ("public_read" as const) : (input.accessLevel ?? "private"),
      };
      buckets.push(bucket);
      if (state.renameAfterWrite) branch.name = "changed";
      if (state.loseBucketResponse) throw new Error("secret bucket response lost");
      return structuredClone(bucket);
    },
    getProject: async () => ({ id: "project", name: "tasks", regionId: "aws-us-east-2", pgVersion: 18 }),
    listBranches: async () => [branch],
    listEndpoints: async () => [
      {
        id: "ep-preview",
        branchId: branch.id,
        type: "read_write",
        autoscalingLimitMinCu: 0.25,
        autoscalingLimitMaxCu: 1,
        suspendTimeout: 300,
      },
    ],
    listBranchFunctions: async () => [
      {
        id: "fn-worker",
        name: "worker",
        slug: "loomworker",
        invocationUrl: "https://example.test",
        activeDeploymentId: state.workerDeployment,
        currentDeployment: { id: state.workerDeployment, status: "completed" },
      },
    ],
    listBranchTriggers: async () => structuredClone(triggers),
    createBranchTrigger: async (_projectId, _branchId, input) => {
      calls.push(`create:${input.name}`);
      if (input.name === state.failName) throw new Error("secret provider failure");
      if (input.type === "storage_object_created") {
        const created = {
          ...input,
          triggerId: `trigger-${input.name}`,
          functionPath: input.functionPath ?? "/",
          enabled: state.ignoreDisable || (input.enabled ?? true),
          inherited: false,
        };
        triggers.push(created);
        if (state.changeWorkerAfterWrite) state.workerDeployment++;
        if (state.renameAfterWrite) branch.name = "changed";
        return structuredClone(created);
      }
      const created = {
        type: "schedule" as const,
        triggerId: `trigger-${input.name}`,
        name: input.name,
        functionSlug: input.functionSlug,
        functionPath: input.functionPath ?? "/",
        enabled: state.ignoreDisable || (input.enabled ?? true),
        inherited: false,
        cron: input.cron,
        nextRunAt: null,
      };
      triggers.push(created);
      if (state.renameAfterWrite) branch.name = "changed";
      return structuredClone(created);
    },
    updateBranchTrigger: async (_projectId, _branchId, id, input) => {
      calls.push(`update:${id}`);
      const current = triggers.find((trigger) => trigger.triggerId === id);
      if (!current) throw new Error("Missing trigger");
      if (current.name === state.failName) throw new Error("secret provider failure");
      if (input.functionPath !== undefined) current.functionPath = input.functionPath;
      if (current.type === "storage_object_created" && input.type === "storage_object_created") {
        current.bucketName = input.bucketName ?? current.bucketName;
        if (input.prefix !== undefined) current.prefix = input.prefix;
      }
      if (!(state.ignoreEnable && input.enabled === true))
        current.enabled = state.ignoreDisable || (input.enabled ?? current.enabled);
      if (current.type === "schedule" && input.type === "schedule") current.cron = input.cron ?? current.cron;
      if (state.renameAfterWrite) branch.name = "changed";
      if (state.changeWorkerAfterWrite) state.workerDeployment++;
      if (state.loseUpdateResponse) throw new Error("secret acknowledgement lost");
      return structuredClone(current);
    },
  };
  const config = defineConfig({
    project: "tasks",
    provider: { projectId: "project", targets: { preview: { branchId: branch.id } } },
  });
  const options = {
    config,
    environment: "preview" as const,
    workerSlug: "loomworker",
    schedules: [
      { name: "wake", schedule: "* * * * *", binding: { kind: "wake" as const, name: "wake" } },
      { name: "daily", schedule: "0 0 * * *", binding: { kind: "cron" as const, name: "daily", cron: "tasks:daily" } },
    ],
  };
  return { branch, provider, triggers, buckets, calls, state, options };
}

test("trigger activation resumes partial and unacknowledged writes without enabling unrelated work", async () => {
  const f = fixture();
  const prepared = await prepareNeonScheduleTriggers(f.options, f.provider);
  let active = false;
  const options = {
    ...f.options,
    target: prepared.target,
    triggers: prepared.triggers,
    workerFunctionId: "fn-worker",
    workerDeploymentId: 1,
    assertActive: async () => {
      if (!active) throw new Error("quarantined");
    },
  };
  await expect(activateNeonTriggers(options, f.provider)).rejects.toThrow("Trigger activation incomplete");
  expect(f.calls).toEqual(["create:wake", "create:daily"]);
  active = true;
  f.state.failName = "daily";
  await expect(activateNeonTriggers(options, f.provider)).rejects.toThrow("Trigger activation incomplete");
  expect(f.triggers.map((trigger) => trigger.enabled)).toEqual([true, false]);
  f.state.failName = "";
  f.state.loseUpdateResponse = true;
  await expect(activateNeonTriggers(options, f.provider)).rejects.toThrow("Trigger activation incomplete");
  expect(f.triggers.map((trigger) => trigger.enabled)).toEqual([true, true]);
  f.state.loseUpdateResponse = false;
  const calls = [...f.calls];
  const result = await activateNeonTriggers(options, f.provider);
  expect(result.triggers.map((trigger) => trigger.triggerId)).toEqual(["trigger-wake", "trigger-daily"]);
  expect(f.calls).toEqual(calls);
  active = false;
  await expect(activateNeonTriggers(options, f.provider)).rejects.toThrow("Trigger activation incomplete");
  expect(f.calls).toEqual(calls);
});

test("trigger activation refuses drift and stops after worker replacement", async () => {
  const f = fixture();
  const prepared = await prepareNeonScheduleTriggers(f.options, f.provider);
  const options = {
    ...f.options,
    target: prepared.target,
    triggers: prepared.triggers,
    workerFunctionId: "fn-worker",
    workerDeploymentId: 1,
    assertActive: async () => {},
  };
  const first = f.triggers[0];
  if (!first || first.type !== "schedule") throw new Error("Missing schedule");
  first.cron = "*/2 * * * *";
  await expect(activateNeonTriggers(options, f.provider)).rejects.toThrow("Trigger activation incomplete");
  first.cron = "* * * * *";
  await expect(activateNeonTriggers({ ...options, workerFunctionId: "replaced" }, f.provider)).rejects.toThrow(
    "Trigger activation incomplete",
  );
  f.triggers.push({ ...first, triggerId: "unknown", name: "unknown", enabled: true });
  await expect(activateNeonTriggers(options, f.provider)).rejects.toThrow("Trigger activation incomplete");
  f.triggers.pop();
  expect(f.calls).toEqual(["create:wake", "create:daily"]);
  f.state.changeWorkerAfterWrite = true;
  await expect(activateNeonTriggers(options, f.provider)).rejects.toThrow("Trigger activation incomplete");
  expect(f.triggers.map((trigger) => trigger.enabled)).toEqual([true, false]);
});

test("trigger activation verifies provider state and honors cancellation before mutation", async () => {
  const f = fixture();
  const prepared = await prepareNeonScheduleTriggers(f.options, f.provider);
  const options = {
    ...f.options,
    target: prepared.target,
    triggers: prepared.triggers,
    workerFunctionId: "fn-worker",
    workerDeploymentId: 1,
    assertActive: async () => {},
  };
  const cancelled = AbortSignal.abort();
  await expect(activateNeonTriggers({ ...options, signal: cancelled }, f.provider)).rejects.toBe(cancelled.reason);
  expect(f.calls).toEqual(["create:wake", "create:daily"]);
  f.state.ignoreEnable = true;
  await expect(activateNeonTriggers(options, f.provider)).rejects.toThrow("Trigger activation incomplete");
  expect(f.triggers.every((trigger) => !trigger.enabled)).toBe(true);
  f.state.ignoreEnable = false;
  f.state.renameAfterWrite = true;
  await expect(activateNeonTriggers(options, f.provider)).rejects.toThrow("Trigger activation incomplete");
  expect(f.triggers.map((trigger) => trigger.enabled)).toEqual([true, false]);
});

test("schedule preparation creates disabled triggers and binds their provider IDs", async () => {
  const f = fixture();
  const result = await prepareNeonScheduleTriggers(f.options, f.provider);
  expect(result.bindings).toEqual({
    "trigger-wake": { kind: "wake", name: "wake" },
    "trigger-daily": { kind: "cron", name: "daily", cron: "tasks:daily" },
  });
  expect(f.triggers.every((trigger) => !trigger.enabled && trigger.functionPath === "/api/kello/triggers")).toBe(true);
  await prepareNeonScheduleTriggers(f.options, f.provider);
  expect(f.calls).toEqual(["create:wake", "create:daily"]);
  f.options.schedules[0]!.schedule = "*/5 * * * *";
  await prepareNeonScheduleTriggers(f.options, f.provider);
  expect(f.calls.at(-1)).toBe("update:trigger-wake");
  expect(f.triggers[0]).toMatchObject({ triggerId: "trigger-wake", cron: "*/5 * * * *", enabled: false });
});

test("trigger disabling includes inherited schedules and storage events only for selected workers", async () => {
  const f = fixture();
  await prepareNeonScheduleTriggers(f.options, f.provider);
  for (const trigger of f.triggers) {
    trigger.enabled = true;
    trigger.inherited = true;
  }
  f.triggers.push({
    type: "storage_object_created",
    triggerId: "storage",
    name: "uploads",
    functionSlug: "loomworker",
    functionPath: "/api/kello/triggers",
    bucketName: "uploads",
    enabled: true,
    inherited: true,
  });
  f.triggers.push({
    type: "schedule",
    triggerId: "other",
    name: "other",
    functionSlug: "otherworker",
    functionPath: "/",
    cron: "* * * * *",
    nextRunAt: null,
    enabled: true,
    inherited: false,
  });
  const result = await disableNeonTriggers(
    { config: f.options.config, environment: "preview", workerSlugs: ["loomworker"] },
    f.provider,
  );
  expect(result.triggers.map((trigger) => trigger.triggerId)).toEqual(["trigger-wake", "trigger-daily", "storage"]);
  expect(
    f.triggers.filter((trigger) => trigger.functionSlug === "loomworker").every((trigger) => !trigger.enabled),
  ).toBe(true);
  expect(f.triggers.find((trigger) => trigger.triggerId === "other")?.enabled).toBe(true);
  const count = f.calls.length;
  await disableNeonTriggers(
    { config: f.options.config, environment: "preview", workerSlugs: ["loomworker"] },
    f.provider,
  );
  expect(f.calls).toHaveLength(count);
});

test("a failed preparation is redacted and resumes existing names without duplicate creation", async () => {
  const f = fixture();
  f.state.failName = "daily";
  await expect(prepareNeonScheduleTriggers(f.options, f.provider)).rejects.toThrow(
    "Could not prepare Neon schedule triggers",
  );
  expect(f.triggers).toHaveLength(1);
  f.state.failName = "";
  await prepareNeonScheduleTriggers(f.options, f.provider);
  expect(f.calls).toEqual(["create:wake", "create:daily", "create:daily"]);
  expect(f.triggers).toHaveLength(2);
});

test("trigger preparation rejects input errors and refuses a name owned by another worker", async () => {
  const f = fixture();
  await expect(
    prepareNeonScheduleTriggers(
      { ...f.options, schedules: [f.options.schedules[0]!, f.options.schedules[0]!] },
      f.provider,
    ),
  ).rejects.toThrow();
  await expect(
    prepareNeonScheduleTriggers(
      { ...f.options, schedules: [{ name: "wake", schedule: "61 * * * *", binding: { kind: "wake", name: "wake" } }] },
      f.provider,
    ),
  ).rejects.toThrow();
  await expect(
    prepareNeonScheduleTriggers(
      { ...f.options, schedules: [{ name: "wake", schedule: "* * * * *", binding: { kind: "wake", name: "other" } }] },
      f.provider,
    ),
  ).rejects.toThrow();
  f.triggers.push({
    type: "schedule",
    triggerId: "other",
    name: "wake",
    functionSlug: "otherworker",
    functionPath: "/",
    cron: "* * * * *",
    nextRunAt: null,
    enabled: false,
    inherited: false,
  });
  await expect(prepareNeonScheduleTriggers(f.options, f.provider)).rejects.toThrow();
  expect(f.calls).toHaveLength(0);
});

test("trigger operations reject target drift and a provider that leaves work enabled", async () => {
  const f = fixture();
  f.state.renameAfterWrite = true;
  await expect(prepareNeonScheduleTriggers(f.options, f.provider)).rejects.toThrow();
  expect(f.calls).toEqual(["create:wake"]);
  f.branch.name = "preview";
  f.state.renameAfterWrite = false;
  f.state.ignoreDisable = true;
  await expect(prepareNeonScheduleTriggers(f.options, f.provider)).rejects.toThrow();
  await expect(
    disableNeonTriggers({ config: f.options.config, environment: "preview", workerSlugs: ["loomworker"] }, f.provider),
  ).rejects.toThrow();
});

test("storage preparation creates private buckets and disabled branch-scoped triggers with reusable provider IDs", async () => {
  const f = fixture();
  const common = { config: f.options.config, environment: "preview" as const };
  const buckets = await prepareNeonStorageBuckets({ ...common, buckets: ["uploads"] }, f.provider);
  expect(buckets.buckets).toEqual([{ name: "uploads", accessLevel: "private" }]);
  const options = { ...common, workerSlug: "loomworker", buckets: [{ name: "created", bucket: "uploads" }] };
  const prepared = await prepareNeonStorageTriggers(options, f.provider);
  expect(prepared.bindings).toEqual({ "trigger-created": { kind: "storage", name: "created", bucket: "uploads" } });
  expect(f.triggers[0]).toMatchObject({
    bucketName: "uploads",
    functionPath: "/api/kello/triggers",
    enabled: false,
    prefix: expect.stringMatching(/^kello\/[a-f0-9]{64}\/pending\/$/),
  });
  await prepareNeonStorageBuckets({ ...common, buckets: ["uploads"] }, f.provider);
  await prepareNeonStorageTriggers(options, f.provider);
  expect(f.calls).toEqual(["bucket:uploads", "create:created"]);
  const existing = f.triggers[0];
  if (!existing || existing.type !== "storage_object_created") throw new Error("Missing storage trigger");
  existing.prefix = "parent/prefix/";
  existing.enabled = true;
  existing.inherited = true;
  await prepareNeonStorageTriggers(options, f.provider);
  expect(f.triggers[0]).toMatchObject({ prefix: prepared.triggers[0]?.prefix, enabled: false });
});

test("storage preparation refuses public buckets, missing buckets and unrelated trigger ownership", async () => {
  const f = fixture();
  const common = { config: f.options.config, environment: "preview" as const };
  const options = { ...common, workerSlug: "loomworker", buckets: [{ name: "created", bucket: "uploads" }] };
  await expect(prepareNeonStorageTriggers(options, f.provider)).rejects.toThrow();
  f.buckets.push({ name: "uploads", accessLevel: "public_read" });
  await expect(prepareNeonStorageBuckets({ ...common, buckets: ["uploads"] }, f.provider)).rejects.toThrow();
  await expect(prepareNeonStorageTriggers(options, f.provider)).rejects.toThrow();
  expect(f.calls).toHaveLength(0);
  f.buckets[0]!.accessLevel = "private";
  f.triggers.push({
    triggerId: "unrelated",
    name: "created",
    type: "storage_object_created",
    bucketName: "other-bucket",
    functionSlug: "otherworker",
    functionPath: "/",
    enabled: true,
    inherited: false,
  });
  await expect(prepareNeonStorageTriggers(options, f.provider)).rejects.toThrow();
  expect(f.calls).toHaveLength(0);
  f.triggers[0]!.functionSlug = "loomworker";
  await expect(prepareNeonStorageTriggers(options, f.provider)).rejects.toThrow();
  expect(f.calls).toHaveLength(0);
});

test("storage trigger preparation redacts failures, resumes a partial result and rejects target drift", async () => {
  const f = fixture();
  f.buckets.push({ name: "uploads", accessLevel: "private" }, { name: "images", accessLevel: "private" });
  const options = {
    config: f.options.config,
    environment: "preview" as const,
    workerSlug: "loomworker",
    buckets: [
      { name: "created", bucket: "uploads" },
      { name: "images-created", bucket: "images" },
    ],
  };
  f.state.failName = "images-created";
  await expect(prepareNeonStorageTriggers(options, f.provider)).rejects.toThrow(
    "Could not prepare Neon storage triggers",
  );
  expect(f.triggers).toHaveLength(1);
  f.state.failName = "";
  await prepareNeonStorageTriggers(options, f.provider);
  expect(f.triggers).toHaveLength(2);
  expect(f.calls).toEqual(["create:created", "create:images-created", "create:images-created"]);
  f.triggers[0]!.enabled = true;
  f.state.renameAfterWrite = true;
  await expect(prepareNeonStorageTriggers(options, f.provider)).rejects.toThrow();
  f.branch.name = "preview";
  f.state.renameAfterWrite = false;
  f.state.ignoreDisable = true;
  f.triggers[0]!.enabled = true;
  await expect(prepareNeonStorageTriggers(options, f.provider)).rejects.toThrow();
});

test("private bucket preparation recovers a lost response and rejects public results and target drift", async () => {
  const f = fixture();
  const options = { config: f.options.config, environment: "preview" as const, buckets: ["uploads"] };
  f.state.loseBucketResponse = true;
  await expect(prepareNeonStorageBuckets(options, f.provider)).rejects.toThrow(
    "Could not prepare Neon storage buckets",
  );
  expect(f.buckets).toEqual([{ name: "uploads", accessLevel: "private" }]);
  f.state.loseBucketResponse = false;
  await prepareNeonStorageBuckets(options, f.provider);
  expect(f.calls).toEqual(["bucket:uploads"]);
  f.state.publicBucket = true;
  await expect(prepareNeonStorageBuckets({ ...options, buckets: ["images"] }, f.provider)).rejects.toThrow();
  f.state.publicBucket = false;
  f.state.renameAfterWrite = true;
  await expect(prepareNeonStorageBuckets({ ...options, buckets: ["documents"] }, f.provider)).rejects.toThrow();
  expect(f.calls).toEqual(["bucket:uploads", "bucket:images", "bucket:documents"]);
});

test("storage preparation rejects duplicate declarations before writes and detects a replaced worker", async () => {
  const f = fixture();
  const common = { config: f.options.config, environment: "preview" as const };
  await expect(prepareNeonStorageBuckets({ ...common, buckets: ["uploads", "uploads"] }, f.provider)).rejects.toThrow();
  const entry = { name: "created", bucket: "uploads" };
  const options = { ...common, workerSlug: "loomworker", buckets: [entry] };
  await expect(prepareNeonStorageTriggers({ ...options, buckets: [entry, entry] }, f.provider)).rejects.toThrow();
  await expect(
    prepareNeonStorageTriggers({ ...options, buckets: [entry, { ...entry, name: "second" }] }, f.provider),
  ).rejects.toThrow();
  expect(f.calls).toHaveLength(0);
  f.buckets.push({ name: "uploads", accessLevel: "private" });
  f.state.changeWorkerAfterWrite = true;
  await expect(prepareNeonStorageTriggers(options, f.provider)).rejects.toThrow(
    "Could not prepare Neon storage triggers",
  );
  expect(f.triggers).toHaveLength(1);
  expect(f.triggers[0]?.enabled).toBe(false);
});

test("ingress handoff requires and preserves a working old job wake", async () => {
  const f = fixture();
  await prepareNeonScheduleTriggers(f.options, f.provider);
  for (const trigger of f.triggers) trigger.enabled = true;
  const options = {
    config: f.options.config,
    environment: "preview" as const,
    workerSlugs: ["loomworker"],
    preserveJobWake: true,
  };
  await expect(disableNeonTriggers(options, f.provider)).rejects.toThrow("Could not disable");
  expect(f.triggers.every((trigger) => trigger.enabled)).toBe(true);
  const wake = f.triggers.find((trigger) => trigger.name === "wake");
  if (!wake || wake.type !== "schedule") throw new Error("Missing fixture wake");
  wake.name = "loom:loomworker:jobs";
  await disableNeonTriggers(options, f.provider);
  expect(wake.enabled).toBe(true);
  expect(f.triggers.find((trigger) => trigger.name === "daily")?.enabled).toBe(false);
  wake.cron = "0 * * * *";
  await expect(disableNeonTriggers(options, f.provider)).rejects.toThrow("Could not disable");
});
