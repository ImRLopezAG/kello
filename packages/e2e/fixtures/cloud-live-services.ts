import assert from "node:assert/strict";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { buildNeonFunctionBundle } from "kello/tooling";
import type { NeonApi } from "@neon/config-runtime/v1";

/** Deploy the generated service under independently identified Functions. */
export async function deployLiveServices(options: {
  root: string;
  artifactHash: string;
  projectId: string;
  branchId: string;
  provider: NeonApi;
  environment: Record<string, string>;
  slugs?: readonly string[];
}) {
  const source = join(options.root, ".loom/deploy", options.artifactHash, "service.mjs");
  const result = [];
  const existing = await options.provider.listBranchFunctions(options.projectId, options.branchId);
  for (const slug of options.slugs ?? ["loomlivea", "loomliveb"]) {
    assert(!existing.some((fn) => fn.slug === slug), "Live test requires unused owned function slugs");
    const bundle = await buildNeonFunctionBundle(source);
    const deployment = await options.provider.deployBranchFunction(options.projectId, options.branchId, slug, {
      bundle,
      runtime: "nodejs24",
      environment: options.environment,
    });
    const deadline = AbortSignal.timeout(90_000);
    for (;;) {
      deadline.throwIfAborted();
      const current = (await options.provider.listBranchFunctions(options.projectId, options.branchId)).find(
        (fn) => fn.slug === slug,
      );
      assert.notEqual(current?.currentDeployment?.status, "failed", "Live function deployment failed");
      if (current?.activeDeploymentId === deployment.id && current.currentDeployment?.status === "completed") {
        result.push({ slug, functionId: current.id, deploymentId: deployment.id, url: current.invocationUrl });
        break;
      }
      await setTimeout(500, undefined, { signal: deadline });
    }
  }
  return result;
}
