import { expect, test } from "vite-plus/test";
import { defineConfig, inspectDeploymentTarget } from "kello-cli";
import type { DeploymentProvider } from "kello-cli";

function fixture() {
  const project = { id: "project", name: "tasks", regionId: "aws-us-east-2", pgVersion: 18 };
  const branch = { id: "br-preview", name: "preview/review", protected: false, isDefault: false };
  const endpoint = {
    id: "ep-preview",
    branchId: branch.id,
    type: "read_write" as const,
    autoscalingLimitMinCu: 0.25,
    autoscalingLimitMaxCu: 1,
    suspendTimeout: 300,
  } satisfies Awaited<ReturnType<DeploymentProvider["listEndpoints"]>>[number];
  const api: DeploymentProvider = {
    getProject: async () => project,
    listBranches: async () => [branch],
    listEndpoints: async () => [endpoint],
  };
  const config = defineConfig({
    project: "tasks",
    provider: {
      projectId: "project",
      targets: {
        development: { branchId: "br-dev" },
        preview: { branchId: "br-preview" },
        production: { branchId: "br-production", protected: true },
      },
    },
  });
  return { project, branch, endpoint, api, config };
}

test("deployment inspection resolves explicit target identity without mutations", async () => {
  const f = fixture();
  expect(await inspectDeploymentTarget(f.config, "preview", f.api)).toEqual({
    environment: "preview",
    projectId: "project",
    branchId: "br-preview",
    branchName: "preview/review",
    endpointId: "ep-preview",
    postgresVersion: 18,
    protected: false,
  });
  f.branch.id = "br-production";
  f.branch.name = "main";
  f.branch.protected = true;
  f.branch.isDefault = true;
  f.endpoint.branchId = f.branch.id;
  expect(await inspectDeploymentTarget(f.config, "production", f.api)).toMatchObject({
    protected: true,
    branchId: "br-production",
  });
});

test("linked targets allow preview but never implicitly authorize production", async () => {
  const f = fixture();
  const linked = defineConfig({ projectId: "project", branchId: "br-preview" });
  expect((await inspectDeploymentTarget(linked, "preview", f.api)).branchId).toBe("br-preview");
  await expect(inspectDeploymentTarget(linked, "production", f.api)).rejects.toThrow("explicit production");
  f.branch.isDefault = true;
  await expect(inspectDeploymentTarget(linked, "preview", f.api)).rejects.toThrow("default");
});

test("deployment inspection rejects mismatches, ambiguous endpoints and unexpected protection", async () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => {
      f.project.id = "other";
    },
    (f: ReturnType<typeof fixture>) => {
      f.project.pgVersion = 17;
    },
    (f: ReturnType<typeof fixture>) => {
      f.branch.id = "br-other";
    },
    (f: ReturnType<typeof fixture>) => {
      f.branch.protected = true;
    },
    (f: ReturnType<typeof fixture>) => {
      f.branch.isDefault = true;
    },
    (f: ReturnType<typeof fixture>) => {
      f.endpoint.branchId = "br-other";
    },
    (f: ReturnType<typeof fixture>) => {
      f.api.listEndpoints = async () => [f.endpoint, { ...f.endpoint, id: "ep-second" }];
    },
    (f: ReturnType<typeof fixture>) => {
      f.api.listBranches = async () => [f.branch, f.branch];
    },
  ]) {
    const f = fixture();
    change(f);
    await expect(inspectDeploymentTarget(f.config, "preview", f.api)).rejects.toThrow();
  }
});

test("missing or shared deployment environments fail before provider reads", async () => {
  const f = fixture();
  f.api.getProject = async () => {
    throw new Error("Provider must not be called");
  };
  for (const targets of [
    {},
    { preview: { branchId: "br-preview" }, production: { branchId: "br-preview" } },
    { preview: { branchId: "br-preview" }, development: { branchId: "br-preview" } },
  ]) {
    const config = defineConfig({ project: "tasks", provider: { projectId: "project", targets } });
    await expect(inspectDeploymentTarget(config, "preview", f.api)).rejects.toThrow(/explicit|separate/);
  }
});

test("deployment provider failures redact downstream credentials", async () => {
  const f = fixture();
  f.api.listBranches = async () => {
    throw new Error("https://secret-token@example.test");
  };
  await expect(inspectDeploymentTarget(f.config, "preview", f.api)).rejects.toThrow(
    "Could not inspect deployment target",
  );
});
