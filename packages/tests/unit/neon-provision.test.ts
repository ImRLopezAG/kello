import { expect, test } from "vite-plus/test";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { provisionNeonBranch, planNeonBranchProvision } from "kello/tooling";
import type { NeonBranchProvisionProvider } from "kello/tooling";

const input = {
  key: "a".repeat(64),
  projectId: "project",
  parentBranchId: "br-parent",
  branchName: "preview/feature",
  environment: "preview" as const,
};
function fixture() {
  const project = { id: "project", name: "fixture", pgVersion: 18, regionId: "aws-us-east-2" };
  const branches: Awaited<ReturnType<NeonBranchProvisionProvider["listBranches"]>> = [
    { id: "br-parent", name: "production", protected: true, isDefault: true },
  ];
  const endpoints: Awaited<ReturnType<NeonBranchProvisionProvider["listEndpoints"]>> = [];
  let creates = 0;
  let lostResponse = false;
  let onCreate: (() => Promise<void>) | undefined;
  const api: NeonBranchProvisionProvider = {
    getProject: async () => project,
    listBranches: async () => structuredClone(branches),
    listEndpoints: async () => structuredClone(endpoints),
    createBranch: async (projectId, values) => {
      expect(projectId).toBe(input.projectId);
      expect(values).toEqual({
        name: input.branchName,
        parentId: input.parentBranchId,
        protected: false,
        initSource: "parent-data",
      });
      creates++;
      await onCreate?.();
      const branch = {
        id: "br-created",
        name: values.name,
        parentId: input.parentBranchId,
        protected: false,
        isDefault: false,
      };
      branches.push(branch);
      if (lostResponse) throw new Error("secret-provider-response");
      return { branch, endpoints: [] };
    },
  };
  function addEndpoint() {
    endpoints.push({
      id: "ep-created",
      branchId: "br-created",
      type: "read_write",
      autoscalingLimitMinCu: 0.25,
      autoscalingLimitMaxCu: 1,
      suspendTimeout: 300,
    });
  }
  return {
    project,
    branches,
    endpoints,
    api,
    addEndpoint,
    creates: () => creates,
    loseResponse: () => {
      lostResponse = true;
    },
    duringCreate: (operation: () => Promise<void>) => {
      onCreate = operation;
    },
  };
}

test("branch provisioning plans explicit PG18 parents and resumes acknowledged creation", async () => {
  const root = await mkdtemp(join(tmpdir(), "loom-provision-"));
  const f = fixture();
  try {
    expect(await planNeonBranchProvision(input, f.api)).toMatchObject({
      dryRun: true,
      projectId: "project",
      parentBranchId: "br-parent",
      branchName: "preview/feature",
      postgresVersion: 18,
    });
    expect(f.creates()).toBe(0);
    await expect(provisionNeonBranch(root, input, f.api)).rejects.toThrow("endpoint");
    expect(f.creates()).toBe(1);
    const path = join(root, ".kello/provision", input.key, "branch.json");
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ state: "created", branchId: "br-created" });
    f.addEndpoint();
    const receipt = await provisionNeonBranch(root, input, f.api);
    expect(receipt).toMatchObject({ state: "complete", branchId: "br-created", endpointId: "ep-created" });
    expect(await provisionNeonBranch(root, input, f.api)).toEqual(receipt);
    expect(f.creates()).toBe(1);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await expect(provisionNeonBranch(root, { ...input, parentBranchId: "changed" }, f.api)).rejects.toThrow("identity");
    const endpoint = f.endpoints[0];
    if (!endpoint) throw new Error("Missing fixture endpoint");
    f.endpoints.push({ ...endpoint, branchId: "another-branch" });
    await expect(provisionNeonBranch(root, input, f.api)).rejects.toThrow("endpoint");
    f.endpoints.pop();
    endpoint.id = "ep-replaced";
    await expect(provisionNeonBranch(root, input, f.api)).rejects.toThrow("endpoint");
    expect(f.creates()).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("branch provisioning refuses unsupported, missing and occupied targets before creation", async () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => {
      f.project.pgVersion = 17;
    },
    (f: ReturnType<typeof fixture>) => {
      f.project.id = "other";
    },
    (f: ReturnType<typeof fixture>) => {
      f.branches.length = 0;
    },
    (f: ReturnType<typeof fixture>) => {
      f.branches.push({ id: "occupied", name: input.branchName, protected: false, isDefault: false });
    },
  ]) {
    const root = await mkdtemp(join(tmpdir(), "loom-provision-refused-"));
    const f = fixture();
    change(f);
    try {
      await expect(provisionNeonBranch(root, input, f.api)).rejects.toThrow();
      expect(f.creates()).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("lost branch create responses remain uncertain and cannot adopt matching names", async () => {
  const root = await mkdtemp(join(tmpdir(), "loom-provision-uncertain-"));
  const f = fixture();
  f.loseResponse();
  try {
    await expect(provisionNeonBranch(root, input, f.api)).rejects.toThrow("uncertain");
    await expect(provisionNeonBranch(root, input, f.api)).rejects.toThrow("uncertain");
    expect(f.creates()).toBe(1);
    const contents = await readFile(join(root, ".kello/provision", input.key, "branch.json"), "utf8");
    expect(JSON.parse(contents).state).toBe("submitting");
    expect(contents).not.toContain("secret-provider-response");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("provisioning awaits in-flight creation on cancellation and rejects concurrent writers", async () => {
  const root = await mkdtemp(join(tmpdir(), "loom-provision-cancel-"));
  const f = fixture();
  const controller = new AbortController();
  try {
    f.duringCreate(async () => {
      await expect(provisionNeonBranch(root, input, f.api)).rejects.toThrow("locked");
      controller.abort(new Error("Cancelled"));
    });
    await expect(provisionNeonBranch(root, { ...input, signal: controller.signal }, f.api)).rejects.toThrow(
      "Cancelled",
    );
    expect(JSON.parse(await readFile(join(root, ".kello/provision", input.key, "branch.json"), "utf8")).state).toBe(
      "created",
    );
    f.addEndpoint();
    expect(await provisionNeonBranch(root, input, f.api)).toMatchObject({ state: "complete" });
    expect(f.creates()).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("provisioning refuses escaped or corrupt receipts without provider mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "loom-provision-files-"));
  const outside = await mkdtemp(join(tmpdir(), "loom-provision-outside-"));
  const f = fixture();
  try {
    const directory = join(root, ".kello/provision", input.key);
    await mkdir(directory, { recursive: true });
    const path = join(directory, "branch.json");
    const target = join(outside, "receipt.json");
    await writeFile(target, "external-value");
    await symlink(target, path);
    await expect(provisionNeonBranch(root, input, f.api)).rejects.toThrow("escape");
    await rm(path);
    await writeFile(path, "{broken");
    await expect(provisionNeonBranch(root, input, f.api)).rejects.toThrow("read");
    expect(await readFile(path, "utf8")).toBe("{broken");
    expect(await readFile(target, "utf8")).toBe("external-value");
    expect(f.creates()).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("provisioning redacts provider observation failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "loom-provision-redaction-"));
  const f = fixture();
  try {
    const unreadable = {
      ...f.api,
      getProject: async () => {
        throw new Error("secret-provider-response");
      },
    };
    await expect(planNeonBranchProvision(input, unreadable)).rejects.toEqual(
      new Error("Could not inspect branch provisioning target"),
    );
    await expect(provisionNeonBranch(root, input, unreadable)).rejects.toEqual(
      new Error("Could not inspect branch provisioning target"),
    );
    const unreadableEndpoint = {
      ...f.api,
      listEndpoints: async () => {
        throw new Error("secret-provider-response");
      },
    };
    await expect(provisionNeonBranch(root, input, unreadableEndpoint)).rejects.toEqual(
      new Error("Could not inspect provisioned branch endpoints"),
    );
    expect(f.creates()).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("production branch creation requests protection and checks it on retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "loom-provision-production-"));
  const f = fixture();
  const branch = {
    id: "br-created",
    name: input.branchName,
    parentId: input.parentBranchId,
    protected: true,
    isDefault: false,
  };
  let creates = 0;
  const api: NeonBranchProvisionProvider = {
    ...f.api,
    createBranch: async (_projectId, values) => {
      expect(values.protected).toBe(true);
      creates++;
      f.branches.push(branch);
      f.addEndpoint();
      return { branch, endpoints: f.endpoints };
    },
  };
  const production = { ...input, environment: "production" as const };
  try {
    expect((await planNeonBranchProvision(production, api)).protected).toBe(true);
    await expect(
      provisionNeonBranch(root, { ...production, signal: AbortSignal.abort(new Error("Cancelled")) }, api),
    ).rejects.toThrow("Cancelled");
    expect(creates).toBe(0);
    expect(await provisionNeonBranch(root, production, api)).toMatchObject({ state: "complete" });
    branch.protected = false;
    await expect(provisionNeonBranch(root, production, api)).rejects.toThrow("identity changed");
    expect(creates).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("development defaults to an independent schema-only root and verifies its ancestry", async () => {
  const root = await mkdtemp(join(tmpdir(), "loom-provision-schema-"));
  const f = fixture();
  const branch = { id: "br-created", name: input.branchName, protected: false, isDefault: false };
  const api: NeonBranchProvisionProvider = {
    ...f.api,
    createBranch: async (_projectId, values) => {
      expect(values).toMatchObject({ initSource: "schema-only", parentId: input.parentBranchId });
      f.branches.push(branch);
      f.addEndpoint();
      return { branch, endpoints: f.endpoints };
    },
  };
  const development = { ...input, environment: "development" as const };
  try {
    expect(await planNeonBranchProvision(development, api)).toMatchObject({ initSource: "schema-only" });
    expect(await provisionNeonBranch(root, development, api)).toMatchObject({ state: "complete" });
    Object.assign(branch, { parentId: input.parentBranchId });
    await expect(provisionNeonBranch(root, development, api)).rejects.toThrow("identity changed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a definite branch precondition rejection permits a checked explicit retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "loom-provision-rejected-"));
  const f = fixture();
  let attempts = 0;
  const api: NeonBranchProvisionProvider = {
    ...f.api,
    createBranch: async (projectId, options) => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error("private provider response"), { kind: "api", status: 412 });
      return f.api.createBranch(projectId, options);
    },
  };
  try {
    await expect(provisionNeonBranch(root, input, api)).rejects.toThrow("HTTP 412");
    const receipt = await readFile(join(root, ".kello/provision", input.key, "branch.json"), "utf8");
    expect(JSON.parse(receipt)).toMatchObject({ state: "rejected", status: 412 });
    expect(receipt).not.toContain("private provider response");
    f.addEndpoint();
    expect(await provisionNeonBranch(root, input, api)).toMatchObject({ state: "complete" });
    expect(attempts).toBe(2);
    expect(f.creates()).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
