import assert from "node:assert/strict";
import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRealNeonApi } from "@neon/config-runtime/v1";
import type { NeonApi } from "@neon/config-runtime/v1";
import { defineConfig, readNeonFunctionReceipt } from "kello-cli";
import { applyNeonFunctions } from "../../../apps/kello-cli/src/tooling/deploy/neon/apply";
import { createDevelopmentCoordinator } from "../../../apps/kello-cli/src/tooling/dev/coordinator";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "loom-function-apply-"));
  const hash = "b".repeat(64);
  const directory = join(root, ".kello/deploy", hash);
  await mkdir(directory, { recursive: true });
  for (const role of ["service", "worker"])
    await writeFile(join(directory, `${role}.mjs`), 'export default { fetch() { return new Response("ready"); } };');
  const branch = { id: "br-preview", name: "preview", isDefault: false, protected: false };
  const remote = new Map<string, Awaited<ReturnType<NeonApi["listBranchFunctions"]>>[number]>();
  const calls: string[] = [];
  const state = { failWorker: true, loseResponse: false, pending: false, nextId: 1, calls };
  const provider: NeonApi = {
    ...createRealNeonApi({ apiKey: "fixture", baseUrl: "http://127.0.0.1:1" }),
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
    listBranchFunctions: async () => [...remote.values()],
    deployBranchFunction: async (projectId, branchId, slug, input) => {
      assert.equal(projectId, "project");
      assert.equal(branchId, "br-preview");
      assert.equal(input.runtime, "nodejs24");
      assert.equal(input.environment.DATABASE_URL, "");
      assert.equal(input.environment.DATABASE_URL_UNPOOLED, "");
      assert.equal(input.environment.NEON_BRANCH, "");
      for (const name of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_ENDPOINT_URL_S3", "AWS_REGION"])
        assert.equal(input.environment[name], "");
      assert.equal(input.environment.LOOM_ACTIVATION_TOKEN, "c".repeat(64));
      assert.ok(input.bundle.byteLength > 0);
      state.calls.push(slug);
      if (slug === "loomworker" && state.failWorker) throw new Error("secret provider failure");
      const deployment = { id: state.nextId++, status: state.pending ? ("pending" as const) : ("completed" as const) };
      remote.set(slug, {
        id: `fn-${slug}`,
        slug,
        name: slug,
        invocationUrl: `https://functions.example.test/${slug}`,
        activeDeploymentId: deployment.id,
        currentDeployment: deployment,
      });
      if (state.loseResponse) throw new Error("secret response lost");
      return deployment;
    },
  };
  const options = {
    config: defineConfig({
      project: "tasks",
      provider: { projectId: "project", targets: { preview: { branchId: "br-preview" } } },
    }),
    environment: "preview" as const,
    entries: {
      directory,
      hash,
      binding: {
        metadataNamespace: "loom_meta",
        deployment: "preview",
        version: "a".repeat(64),
        projectId: "project",
        branchId: "br-preview",
        branchName: "preview",
        endpointHost: "ep-preview.example.test",
        databaseName: "neondb",
      },
      service: join(directory, "service.mjs"),
      worker: join(directory, "worker.mjs"),
    },
    slugs: { service: "loomservice", worker: "loomworker" },
    variables: {
      LOOM_DATABASE_URL: "postgresql://runtime:secret-password@ep-preview.example.test/neondb",
      LOOM_ACTIVATION_TOKEN: "c".repeat(64),
      APPLICATION_SECRET: "private-app-value",
    },
  };
  return { root, options, state, provider, remote, branch, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("function apply persists partial results, resumes only unfinished work and never stores secrets", async () => {
  const f = await fixture();
  try {
    await assert.rejects(applyNeonFunctions(f.root, f.options, f.provider), /Function deployment incomplete/);
    const partial = await readNeonFunctionReceipt(f.root, f.options.entries.hash);
    expect(partial.functions.map((fn) => fn.state)).toEqual(["completed", "submitting"]);
    expect(partial.functions[0].deploymentId).toBe(1);
    const contents = await readFile(join(f.options.entries.directory, "functions.json"), "utf8");
    for (const secret of Object.values(f.options.variables)) expect(contents).not.toContain(secret);
    f.state.failWorker = false;
    await writeFile(f.options.entries.worker, "invalid source after the immutable archive was saved");
    const result = await applyNeonFunctions(f.root, f.options, f.provider);
    expect(result.receipt.functions.map((fn) => fn.state)).toEqual(["completed", "completed"]);
    expect(f.state.calls).toEqual(["loomservice", "loomworker", "loomworker"]);
    await applyNeonFunctions(f.root, f.options, f.provider);
    expect(f.state.calls).toHaveLength(3);
    f.options.variables.APPLICATION_SECRET = "changed-secret";
    await assert.rejects(applyNeonFunctions(f.root, f.options, f.provider), /receipt inputs/i);
    expect(f.state.calls).toHaveLength(3);
  } finally {
    await f.cleanup();
  }
});

test("unacknowledged provider changes remain uncertain and are not overwritten on resume", async () => {
  const f = await fixture();
  try {
    f.state.loseResponse = true;
    await assert.rejects(applyNeonFunctions(f.root, f.options, f.provider));
    expect((await readNeonFunctionReceipt(f.root, f.options.entries.hash)).functions[0].state).toBe("submitting");
    f.state.loseResponse = false;
    await assert.rejects(applyNeonFunctions(f.root, f.options, f.provider));
    expect(f.state.calls).toEqual(["loomservice"]);
  } finally {
    await f.cleanup();
  }
});

test("function apply waits for provider completion and resumes a submitted deployment without reupload", async () => {
  const f = await fixture();
  try {
    f.state.failWorker = false;
    f.state.pending = true;
    await assert.rejects(applyNeonFunctions(f.root, { ...f.options, timeoutMs: 20 }, f.provider));
    expect((await readNeonFunctionReceipt(f.root, f.options.entries.hash)).functions[0].state).toBe("submitted");
    const service = f.remote.get("loomservice");
    assert.ok(service?.currentDeployment);
    service.currentDeployment.status = "completed";
    f.state.pending = false;
    await applyNeonFunctions(f.root, f.options, f.provider);
    expect(f.state.calls).toEqual(["loomservice", "loomworker"]);
  } finally {
    await f.cleanup();
  }
});

test("function apply rejects identity overrides and tampered archived bundles", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      applyNeonFunctions(
        f.root,
        { ...f.options, variables: { ...f.options.variables, DATABASE_URL: "forged" } },
        f.provider,
      ),
    );
    for (const name of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_ENDPOINT_URL_S3", "AWS_REGION"]) {
      await assert.rejects(
        applyNeonFunctions(
          f.root,
          { ...f.options, variables: { ...f.options.variables, [name]: "forged" } },
          f.provider,
        ),
        /reserved/,
      );
    }
    expect(f.state.calls).toHaveLength(0);
    await assert.rejects(applyNeonFunctions(f.root, f.options, f.provider));
    const receipt = await readNeonFunctionReceipt(f.root, f.options.entries.hash);
    await writeFile(join(f.options.entries.directory, `${receipt.functions[1].bundleHash}.zip`), "tampered");
    f.state.failWorker = false;
    await assert.rejects(applyNeonFunctions(f.root, f.options, f.provider));
    expect(f.state.calls).toEqual(["loomservice", "loomworker"]);
  } finally {
    await f.cleanup();
  }
});

test("a stalled completion read times out with the acknowledged deployment preserved", async () => {
  const f = await fixture();
  try {
    f.state.failWorker = false;
    f.state.pending = true;
    let readsAfterSubmission = 0;
    f.provider.listBranchFunctions = async () => {
      if (f.state.calls.length && ++readsAfterSubmission >= 1) return new Promise(() => {});
      return [...f.remote.values()];
    };
    await assert.rejects(applyNeonFunctions(f.root, { ...f.options, timeoutMs: 20 }, f.provider));
    expect((await readNeonFunctionReceipt(f.root, f.options.entries.hash)).functions[0].deploymentId).toBe(1);
    expect(f.state.calls).toEqual(["loomservice"]);
  } finally {
    await f.cleanup();
  }
});

test("apply stops after target drift and refuses to overwrite a newer completed deployment", async () => {
  const f = await fixture();
  try {
    f.state.failWorker = false;
    const deploy = f.provider.deployBranchFunction.bind(f.provider);
    f.provider.deployBranchFunction = async (...args) => {
      const result = await deploy(...args);
      f.branch.name = "renamed";
      return result;
    };
    await assert.rejects(applyNeonFunctions(f.root, f.options, f.provider));
    expect(f.state.calls).toEqual(["loomservice"]);
    expect((await readNeonFunctionReceipt(f.root, f.options.entries.hash)).functions[0].state).toBe("completed");
    f.branch.name = "preview";
    f.provider.deployBranchFunction = deploy;
    await applyNeonFunctions(f.root, f.options, f.provider);
    const service = f.remote.get("loomservice");
    assert.ok(service?.currentDeployment);
    service.currentDeployment.id = 100;
    service.activeDeploymentId = 100;
    await assert.rejects(applyNeonFunctions(f.root, f.options, f.provider));
    expect(f.state.calls).toEqual(["loomservice", "loomworker"]);
  } finally {
    await f.cleanup();
  }
});

test("a terminal provider failure can retry while retaining every acknowledged deployment ID", async () => {
  const f = await fixture();
  try {
    f.state.failWorker = false;
    const deploy = f.provider.deployBranchFunction.bind(f.provider);
    let failBuild = true;
    f.provider.deployBranchFunction = async (...args) => {
      const result = await deploy(...args);
      if (failBuild) {
        const current = f.remote.get(args[2]);
        assert.ok(current?.currentDeployment);
        current.currentDeployment.status = "failed";
        result.status = "failed";
      }
      return result;
    };
    await assert.rejects(applyNeonFunctions(f.root, f.options, f.provider));
    expect((await readNeonFunctionReceipt(f.root, f.options.entries.hash)).functions[0].state).toBe("failed");
    failBuild = false;
    const result = await applyNeonFunctions(f.root, f.options, f.provider);
    expect(result.receipt.functions[0].deploymentIds).toEqual([1, 2]);
    expect(f.state.calls).toEqual(["loomservice", "loomservice", "loomworker"]);
  } finally {
    await f.cleanup();
  }
});

test("concurrent apply is locked and cancellation retains a late mutation acknowledgement", async () => {
  const f = await fixture();
  const release = Promise.withResolvers<void>();
  try {
    f.state.failWorker = false;
    const entered = Promise.withResolvers<void>();
    const deploy = f.provider.deployBranchFunction.bind(f.provider);
    f.provider.deployBranchFunction = async (...args) => {
      const result = await deploy(...args);
      entered.resolve();
      await release.promise;
      return result;
    };
    const controller = new AbortController();
    const rejected = assert.rejects(
      applyNeonFunctions(f.root, { ...f.options, signal: controller.signal }, f.provider),
      (cause) => cause === controller.signal.reason,
    );
    await entered.promise;
    await assert.rejects(applyNeonFunctions(f.root, f.options, f.provider), /locked/);
    controller.abort();
    release.resolve();
    await rejected;
    const partial = await readNeonFunctionReceipt(f.root, f.options.entries.hash);
    expect(partial.functions[0].state).toBe("submitted");
    expect(partial.functions[0].deploymentId).toBe(1);
    f.provider.deployBranchFunction = deploy;
    await applyNeonFunctions(f.root, f.options, f.provider);
    expect(f.state.calls).toEqual(["loomservice", "loomworker"]);
  } finally {
    release.resolve();
    await f.cleanup();
  }
});

for (const mode of ["polling timer", "pending read", "superseded", "cleanup failure"] as const)
  test(`development cancellation drains actual function apply (${mode})`, async () => {
    const f = await fixture();
    const polling = Promise.withResolvers<void>();
    const cleanupFailure = new Error("distinct cleanup failure");
    f.state.failWorker = false;
    f.state.pending = true;
    f.provider.listBranchFunctions = async () => {
      if (f.state.calls.length && f.state.pending) {
        polling.resolve();
        if (mode === "pending read") return new Promise(() => {});
      }
      return [...f.remote.values()];
    };
    const coordinator = createDevelopmentCoordinator(
      async (revision) => {
        await applyNeonFunctions(f.root, { ...f.options, signal: revision.signal }, f.provider).finally(() => {
          if (mode === "cleanup failure") return Promise.reject(cleanupFailure);
        });
      },
      { debounceMs: 0 },
    );
    try {
      coordinator.invalidate();
      await polling.promise;
      // Let the pending observation finish so apply reaches its real polling timer.
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (mode === "superseded") {
        f.state.pending = false;
        const service = f.remote.get("loomservice");
        assert.ok(service?.currentDeployment);
        service.currentDeployment.status = "completed";
        coordinator.invalidate();
        await coordinator.flush();
        expect(coordinator.failure).toBeNull();
        expect((await readNeonFunctionReceipt(f.root, f.options.entries.hash)).functions.map((fn) => fn.state)).toEqual(
          ["completed", "completed"],
        );
      }
      if (mode === "cleanup failure")
        await assert.rejects(coordinator.stop(), (cause) => cause instanceof Error && cause.cause === cleanupFailure);
      else await coordinator.stop();
    } finally {
      await coordinator.stop().catch(() => {});
      await f.cleanup();
    }
  });
