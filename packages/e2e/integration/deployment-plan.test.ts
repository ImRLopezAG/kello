import assert from "node:assert/strict";
import { expect, test } from "bun:test";
import { createRealNeonApi } from "@neon/config-runtime/v1";
import type { NeonApi } from "@neon/config-runtime/v1";
import { defineConfig, planNeonFunctions } from "kello-cli";

function fixture() {
  const project = { id: "project", name: "tasks", regionId: "aws-us-east-2", pgVersion: 18 };
  const branch = { id: "br-preview", name: "preview", protected: false, isDefault: false };
  const endpoint = {
    id: "ep-preview",
    branchId: branch.id,
    type: "read_write" as const,
    autoscalingLimitMinCu: 0.25,
    autoscalingLimitMaxCu: 1,
    suspendTimeout: 300,
  } satisfies Awaited<ReturnType<NeonApi["listEndpoints"]>>[number];
  let mutations = 0;
  const provider = {
    // Any unexpected API operation fails locally instead of contacting Neon.
    ...createRealNeonApi({ apiKey: "fixture", baseUrl: "http://127.0.0.1:1" }),
    getProject: async () => project,
    listBranches: async () => [branch],
    listEndpoints: async () => [endpoint],
    listBranchFunctions: async () => [
      {
        id: "fn-existing",
        slug: "loomservice",
        name: "service",
        invocationUrl: "https://example.test?token=provider-secret",
        activeDeploymentId: 3,
      },
    ],
    deployBranchFunction: async () => {
      mutations++;
      throw new Error("must not mutate");
    },
  };
  const binding = {
    metadataNamespace: "loom_meta",
    deployment: "preview",
    version: "a".repeat(64),
    projectId: project.id,
    branchId: branch.id,
    branchName: branch.name,
    endpointHost: "ep-preview.example.test",
    databaseName: "neondb",
  };
  const options = {
    config: defineConfig({
      project: "tasks",
      provider: { projectId: project.id, targets: { preview: { branchId: branch.id } } },
    }),
    environment: "preview" as const,
    entries: {
      directory: "/not-read",
      hash: "b".repeat(64),
      binding,
      service: "/not-read/service.mjs",
      worker: "/not-read/worker.mjs",
    },
    slugs: { service: "loomservice", worker: "loomworker" },
  };
  return { options, provider, project, branch, endpoint, mutations: () => mutations };
}

test("Neon function dry run uses the real planner without bundling, application credentials or mutations", async () => {
  const f = fixture();
  const receipt = await planNeonFunctions(f.options, f.provider);
  expect(receipt.target.branchId).toBe("br-preview");
  expect(receipt.version).toBe(f.options.entries.binding.version);
  expect(receipt.artifactHash).toBe(f.options.entries.hash);
  expect(receipt.functions).toEqual([
    { role: "service", slug: "loomservice", action: "update" },
    { role: "worker", slug: "loomworker", action: "create" },
  ]);
  expect(receipt.dryRun).toBe(true);
  expect(f.mutations()).toBe(0);
  expect(JSON.stringify(receipt)).not.toContain("/not-read");
  expect(JSON.stringify(receipt)).not.toContain("fixture");
  expect(JSON.stringify(receipt)).not.toContain("provider-secret");
});

test("function planning refuses duplicate slugs and mismatched activation bindings", async () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => {
      f.options.slugs.worker = f.options.slugs.service;
    },
    (f: ReturnType<typeof fixture>) => {
      f.options.entries.binding.branchId = "br-other";
    },
    (f: ReturnType<typeof fixture>) => {
      f.options.entries.binding.branchName = "other";
    },
    (f: ReturnType<typeof fixture>) => {
      f.options.entries.binding.projectId = "other";
    },
    (f: ReturnType<typeof fixture>) => {
      f.options.entries.binding.endpointHost = "ep-other.example.test";
    },
    (f: ReturnType<typeof fixture>) => {
      f.options.entries.binding.metadataNamespace = "loom_other";
    },
  ]) {
    const f = fixture();
    change(f);
    await assert.rejects(planNeonFunctions(f.options, f.provider));
    expect(f.mutations()).toBe(0);
  }
});

test("function planning redacts provider errors and detects target drift during the plan", async () => {
  const f = fixture();
  f.provider.listBranchFunctions = async () => {
    throw new Error("secret provider response");
  };
  await assert.rejects(planNeonFunctions(f.options, f.provider), { message: "Could not plan Neon functions" });
  f.provider.listBranchFunctions = async () => {
    f.branch.name = "renamed";
    return [];
  };
  await assert.rejects(planNeonFunctions(f.options, f.provider), /target changed/i);
  expect(f.mutations()).toBe(0);
});

test("a production function plan preserves protected branch settings", async () => {
  const f = fixture();
  f.branch.protected = true;
  f.branch.isDefault = true;
  const receipt = await planNeonFunctions(
    {
      ...f.options,
      environment: "production",
      config: defineConfig({
        project: "tasks",
        provider: { projectId: f.project.id, targets: { production: { branchId: f.branch.id, protected: true } } },
      }),
    },
    f.provider,
  );
  expect(receipt.target.protected).toBe(true);
  expect(receipt.functions).toHaveLength(2);
  expect(f.mutations()).toBe(0);
});

test("function planning captures caller inputs before awaiting provider metadata", async () => {
  const f = fixture();
  f.provider.getProject = async () => {
    f.options.entries.binding.branchName = "changed input";
    f.options.slugs.service = "changedinput";
    return f.project;
  };
  const receipt = await planNeonFunctions(f.options, f.provider);
  expect(receipt.target.branchName).toBe("preview");
  expect(receipt.functions[0]?.slug).toBe("loomservice");
});
