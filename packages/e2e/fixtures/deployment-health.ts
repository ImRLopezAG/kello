import assert from "node:assert/strict";
import * as v from "valibot";
import { createServer } from "node:https";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defineConfig, inspectNeonFunctionHealth, NeonFunctionHealthError } from "kello-cli";
import type { NeonFunctionReceipt, DeploymentHealthProvider } from "kello-cli";

const [certificate, key, mode, root] = process.argv.slice(2);
if (!certificate || !key || !root) throw new Error("Missing fixture paths");
const hash = "a".repeat(64);
const version = "b".repeat(64);
const token = "c".repeat(64);
let behavior:
  | "healthy"
  | "wrong-build"
  | "redirect"
  | "large"
  | "stall"
  | "supersede"
  | "previous-once"
  | "previous-always" = "healthy";
const previousHash = "f".repeat(64);
let drainProtocol: number | undefined;
let workerDrainProtocol: number | undefined;
let requests = 0;
let redirects = 0;
let deployment = 1;
let stallObservation = false;
const observation = Promise.withResolvers<void>();
const server = createServer({ cert: await readFile(certificate), key: await readFile(key) }, (request, response) => {
  requests++;
  assert.equal(request.headers.authorization, `Bearer ${token}`);
  assert.equal(request.method, "POST");
  if (request.url === "/redirect-target") {
    redirects++;
    response.end("unexpected");
    return;
  }
  assert.match(request.url ?? "", /^\/(service|worker)\/_loom\/deployment\/health$/);
  if (behavior === "redirect") {
    response.writeHead(307, { location: "/redirect-target" });
    response.end();
    return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  if (behavior === "stall") {
    response.write("{");
    return;
  }
  if (behavior === "large") {
    response.end(" ".repeat(5000));
    return;
  }
  if (behavior === "supersede") deployment++;
  const artifactHash = behavior === "previous-once" || behavior === "previous-always" ? previousHash : hash;
  if (behavior === "previous-once") behavior = "healthy";
  response.end(
    JSON.stringify({
      format: 1,
      databaseDrainProtocol: request.url?.startsWith("/service/") ? drainProtocol : workerDrainProtocol,
      version: behavior === "wrong-build" ? "d".repeat(64) : version,
      artifactHash,
      role: request.url?.startsWith("/service/") ? "service" : "worker",
    }),
  );
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || v.is(v.string(), address)) throw new Error("Missing listener");
const origin = `https://127.0.0.1:${address.port}`;
const branch = { id: "br-preview", name: "preview", protected: false, isDefault: false };
const provider: DeploymentHealthProvider = {
  getProject: async () => ({ id: "project", name: "test", regionId: "aws-us-east-2", pgVersion: 18 }),
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
  listBranchFunctions: async () => {
    if (stallObservation) await observation.promise;
    return ["service", "worker"].map((role) => ({
      id: `fn-${role}`,
      slug: role,
      name: role,
      invocationUrl: `${origin}/${role}`,
      activeDeploymentId: deployment,
      currentDeployment: { id: deployment, status: "completed" },
    }));
  },
};
function functionReceipt(role: "service" | "worker"): NeonFunctionReceipt["functions"][number] {
  return {
    role,
    slug: role,
    bundleHash: "e".repeat(64),
    state: "completed",
    baselineId: null,
    deploymentId: 1,
    deploymentIds: [1],
    functionId: `fn-${role}`,
    invocationUrl: `${origin}/${role}`,
  };
}
const receipt: NeonFunctionReceipt = {
  format: 1,
  version,
  artifactHash: hash,
  inputHash: "d".repeat(64),
  target: {
    environment: "preview",
    projectId: "project",
    branchId: branch.id,
    branchName: branch.name,
    endpointId: "ep-preview",
    postgresVersion: 18,
    protected: false,
  },
  functions: [functionReceipt("service"), functionReceipt("worker")],
};
const directory = join(root, ".kello/deploy", hash);
await mkdir(directory, { recursive: true });
const saved = JSON.stringify(receipt);
await writeFile(join(directory, "functions.json"), saved);
const options = {
  artifactHash: hash,
  activationToken: token,
  environment: "preview" as const,
  config: defineConfig({
    project: "test",
    provider: { projectId: "project", targets: { preview: { branchId: branch.id } } },
  }),
};
const refused = /^Error: Deployment health verification failed$/;
try {
  if (mode === "untrusted") {
    await assert.rejects(inspectNeonFunctionHealth(root, options, provider), refused);
    assert.equal(requests, 0);
  } else {
    const proof = await inspectNeonFunctionHealth(root, options, provider);
    assert.equal(proof.version, version);
    assert.equal(proof.artifactHash, hash);
    assert.deepEqual(
      proof.functions.map((fn) => fn.functionId),
      ["fn-service", "fn-worker"],
    );
    assert.ok(!JSON.stringify(proof).includes(token));
    assert.equal(requests, 2);
    const previous = { ...receipt, artifactHash: previousHash };
    await mkdir(join(root, ".kello/deploy", previousHash), { recursive: true });
    await writeFile(join(root, ".kello/deploy", previousHash, "functions.json"), JSON.stringify(previous));
    behavior = "previous-once";
    const propagated = await inspectNeonFunctionHealth(
      root,
      { ...options, previousArtifactHash: previousHash },
      provider,
    );
    assert.equal(propagated.artifactHash, hash);
    assert.equal(requests, 5);
    behavior = "previous-always";
    await assert.rejects(
      inspectNeonFunctionHealth(root, { ...options, previousArtifactHash: previousHash, timeoutMs: 100 }, provider),
      refused,
    );
    await assert.rejects(inspectNeonFunctionHealth(root, options, provider), refused);
    behavior = "healthy";
    const invalidPrevious = { ...previous, version: "e".repeat(64) };
    await writeFile(join(root, ".kello/deploy", previousHash, "functions.json"), JSON.stringify(invalidPrevious));
    const beforeInvalidPrevious = requests;
    await assert.rejects(
      inspectNeonFunctionHealth(root, { ...options, previousArtifactHash: previousHash }, provider),
      refused,
    );
    assert.equal(requests, beforeInvalidPrevious);
    assert.deepEqual(
      proof.functions.map((fn) => fn.databaseDrainProtocol),
      [0, 0],
    );
    drainProtocol = 1;
    workerDrainProtocol = 1;
    const guarded = await inspectNeonFunctionHealth(root, options, provider);
    assert.deepEqual(
      guarded.functions.map((fn) => fn.databaseDrainProtocol),
      [1, 1],
    );
    workerDrainProtocol = undefined;
    const mixed = await inspectNeonFunctionHealth(root, options, provider);
    assert.deepEqual(
      mixed.functions.map((fn) => fn.databaseDrainProtocol),
      [1, 0],
    );
    drainProtocol = 2;
    await assert.rejects(inspectNeonFunctionHealth(root, options, provider), refused);
    drainProtocol = undefined;
    for (const next of ["wrong-build", "redirect", "large", "stall", "supersede"] as const) {
      behavior = next;
      const beforeFailure: number = requests;
      await assert.rejects(
        inspectNeonFunctionHealth(root, { ...options, timeoutMs: next === "stall" ? 100 : 10_000 }, provider),
        (error) => {
          assert(error instanceof NeonFunctionHealthError);
          assert.match(String(error), refused);
          assert.equal(error.stage, next === "supersede" ? "confirm deployments" : "service health");
          assert.equal(error.aborted, next === "stall");
          assert.equal(error.identityMismatch, next === "wrong-build" ? "version" : undefined);
          assert.ok(!JSON.stringify(error).includes(token));
          return true;
        },
      );
      assert.equal(requests, beforeFailure + (next === "supersede" ? 2 : 1));
      deployment = 1;
    }
    assert.equal(redirects, 0);
    behavior = "healthy";
    const before = requests;
    deployment = 2;
    await assert.rejects(inspectNeonFunctionHealth(root, options, provider), refused);
    assert.equal(requests, before);
    deployment = 1;
    branch.name = "changed";
    await assert.rejects(inspectNeonFunctionHealth(root, options, provider), refused);
    assert.equal(requests, before);
    branch.name = "preview";
    stallObservation = true;
    await assert.rejects(inspectNeonFunctionHealth(root, { ...options, timeoutMs: 20 }, provider), refused);
    observation.resolve();
    stallObservation = false;
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(requests, before);
    await assert.rejects(
      inspectNeonFunctionHealth(root, { ...options, activationToken: "invalid-secret" }, provider),
      refused,
    );
    const partial = structuredClone(receipt);
    partial.functions[1].state = "submitted";
    await writeFile(join(directory, "functions.json"), JSON.stringify(partial));
    await assert.rejects(inspectNeonFunctionHealth(root, options, provider), refused);
    await writeFile(join(directory, "functions.json"), saved);
    assert.equal(requests, before);
    const cancellation = AbortSignal.abort(new Error("health cancelled"));
    await assert.rejects(
      inspectNeonFunctionHealth(root, { ...options, signal: cancellation }, provider),
      (error) => error === cancellation.reason,
    );
    assert.equal(requests, before);
    assert.equal(await readFile(join(directory, "functions.json"), "utf8"), saved);
  }
} finally {
  observation.resolve();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
