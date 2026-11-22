/** The disposable branch the pre-commit hook selected; fixtures never pin a branch that can expire. */
import { defineConfig, inspectDeploymentTarget } from "kello-cli";
import * as v from "valibot";

const identifier = v.pipe(v.string(), v.regex(/^[a-zA-Z0-9_-]+$/));
export const projectId = v.parse(identifier, process.env.KELLO_CLOUD_PROJECT_ID ?? "late-moon-69483649");
export const branchId = v.parse(identifier, process.env.KELLO_CLOUD_BRANCH_ID);
const target = await inspectDeploymentTarget(
  defineConfig({
    project: "acceptance",
    provider: { projectId, targets: { preview: { branchId, protected: false } } },
  }),
  "preview",
);
if (target.protected || !target.branchName.startsWith("kello-acceptance-"))
  throw new Error("Fixtures require an unprotected kello-acceptance-* branch");
export const branchName = target.branchName;
export const endpointId = target.endpointId;
