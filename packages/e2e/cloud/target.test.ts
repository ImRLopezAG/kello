import assert from "node:assert/strict";
import { test } from "bun:test";
import { defineConfig, inspectDeploymentTarget } from "kello-cli";
import * as v from "valibot";

const identifier = v.pipe(v.string(), v.regex(/^[a-zA-Z0-9_-]+$/));
test.skipIf(!process.env.KELLO_CLOUD_PROJECT_ID)(
  "deployment SDK resolves a real disposable Neon target with the selected Neon credentials",
  async () => {
    const projectId = v.parse(identifier, process.env.KELLO_CLOUD_PROJECT_ID);
    const branchId = v.parse(identifier, process.env.LOOM_CLOUD_BRANCH_ID);
    const target = await inspectDeploymentTarget(
      defineConfig({
        project: "loom-cloud-acceptance",
        provider: { projectId, targets: { preview: { branchId, protected: false } } },
      }),
      "preview",
    );
    assert.equal(target.projectId, projectId);
    assert.equal(target.branchId, branchId);
    assert.match(target.branchName, /^loom-acceptance-/);
    assert.equal(target.postgresVersion, 18);
    assert.equal(target.protected, false);
    assert(target.endpointId.length > 0);
  },
  30000,
);
