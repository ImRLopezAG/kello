/** Explicit smoke test on the already authorized disposable branch; never imported by offline suites. */
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { buildNeonFunctionBundle, createKelloNeonApi, defineConfig, inspectDeploymentTarget } from "kello/tooling";
import * as v from "valibot";

const projectId = "late-moon-69483649";
const branchId = "br-dark-block-awbbt60w";
const run = crypto.randomUUID();
const slug = `ks${run.replaceAll("-", "").slice(0, 18)}`;
const nonce = crypto.randomUUID();
const version = "a".repeat(64);
const origin = "https://kello-smoke.invalid";
const root = await mkdtemp(join(tmpdir(), "kello-cloud-bundle-"));
interface SmokeReport {
  run: string;
  slug: string;
  stage: string;
  deployed: boolean;
  ordinaryRpc: boolean;
  wrongVersion: boolean;
  cleaned: boolean;
  failed: boolean;
  failureStatus: number | null;
}
const report: SmokeReport = {
  run,
  slug,
  stage: "admission",
  deployed: false,
  ordinaryRpc: false,
  wrongVersion: false,
  cleaned: false,
  failed: false,
  failureStatus: null,
};
const api = createKelloNeonApi();
let deploymentId: number | undefined;
let submitted = false;
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
  assert(!(await api.listBranchFunctions(projectId, branchId)).some((fn) => fn.slug === slug));
  await symlink(await realpath(new URL("../node_modules", import.meta.url)), join(root, "node_modules"));
  const source = join(root, "index.ts");
  await writeFile(
    source,
    `import {os} from "@orpc/server";
import {createRpcHttpApp} from "kello/neon";
import * as v from "valibot";
const app=createRpcHttpApp({router:{probe:os.input(v.strictObject({})).output(v.strictObject({nonce:v.string()})).handler(()=>({nonce:process.env.KELLO_PROBE_NONCE}))},version:${JSON.stringify(version)},origins:[${JSON.stringify(origin)}],allowAnonymous:true,verify:async()=>{throw new Error("No credentials accepted by this public test probe");}});
export default app;`,
  );
  report.stage = "bundle";
  const bundle = await buildNeonFunctionBundle(source);
  report.stage = "deploy";
  submitted = true;
  const deployment = await api.deployBranchFunction(projectId, branchId, slug, {
    bundle,
    runtime: "nodejs24",
    environment: { KELLO_PROBE_NONCE: nonce },
  });
  deploymentId = deployment.id;
  const signal = AbortSignal.timeout(180_000);
  for (;;) {
    signal.throwIfAborted();
    const current = (await api.listBranchFunctions(projectId, branchId)).find((fn) => fn.slug === slug);
    assert.notEqual(current?.currentDeployment?.status, "failed");
    if (current && current.activeDeploymentId === deploymentId && current.currentDeployment?.status === "completed") {
      report.deployed = true;
      report.stage = "http";
      const url = new URL("/api/kello/rpc/probe", current.invocationUrl);
      const response = await fetch(url, {
        method: "POST",
        headers: {
          origin,
          "content-type": "application/json",
          "x-loom-protocol": "loom-orpc-2",
          "x-loom-version": version,
        },
        body: JSON.stringify({ json: {} }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { json: { nonce } });
      report.ordinaryRpc = true;
      const stale = await fetch(url, {
        method: "POST",
        headers: {
          origin,
          "content-type": "application/json",
          "x-loom-protocol": "loom-orpc-2",
          "x-loom-version": "b".repeat(64),
        },
        body: JSON.stringify({ json: {} }),
        signal: AbortSignal.timeout(15000),
      });
      assert.equal(stale.status, 409);
      await stale.body?.cancel();
      report.wrongVersion = true;
      break;
    }
    await setTimeout(1000, undefined, { signal });
  }
} catch (cause) {
  const parsed = v.safeParse(v.object({ details: v.object({ status: v.number() }) }), cause);
  if (parsed.success) report.failureStatus = parsed.output.details.status;
  report.failed = true;
  process.exitCode = 1;
} finally {
  try {
    const current = (await api.listBranchFunctions(projectId, branchId)).find((fn) => fn.slug === slug);
    if (current) {
      assert(
        submitted && deploymentId && current.activeDeploymentId === deploymentId,
        "Ambiguous or replaced deployment requires reconciliation",
      );
      await api.deleteBranchFunction(projectId, branchId, slug);
    }
    assert(!(await api.listBranchFunctions(projectId, branchId)).some((fn) => fn.slug === slug));
    report.cleaned = true;
  } catch {
    report.failed = true;
    process.exitCode = 1;
  }
  await rm(root, { recursive: true, force: true });
  await writeFile(join(tmpdir(), `kello-cloud-u6-bundle-${run}.json`), JSON.stringify(report, null, 2), {
    mode: 0o600,
  });
  console.log(JSON.stringify(report));
}
