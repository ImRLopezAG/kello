import { NeonCredentialError } from "../../neon/credentials";
import { createKelloNeonApi } from "../../neon/api";
import { plan } from "@neon/config-runtime/v1";
import type { NeonApi } from "@neon/config-runtime/v1";
import { createNeonActivationVerifier } from "kello/neon";
import * as v from "valibot";
import { configValidator } from "../../config/define-config";
import type { KelloConfig } from "../../config/define-config";
import type { prepareNeonEntrypoints } from "./entrypoints";
import { inspectDeploymentTarget } from "./target";
import type { DeploymentEnvironment } from "./target";
import { neonFunctionPolicy } from "./policy";

export interface NeonFunctionPlanOptions {
  readonly config: KelloConfig;
  readonly environment: DeploymentEnvironment;
  readonly entries: Awaited<ReturnType<typeof prepareNeonEntrypoints>>;
  readonly slugs: Readonly<{ service: string; worker: string }>;
}

const slug = v.pipe(v.string(), v.regex(/^[a-z0-9]{1,20}$/));
export const slugsValidator = v.pipe(
  v.strictObject({ service: slug, worker: slug }),
  v.check((names) => names.service !== names.worker, "Service and worker require distinct function slugs"),
);
const plannedResult = v.object({
  projectId: v.string(),
  branchId: v.string(),
  branchName: v.string(),
  dryRun: v.literal(true),
  applied: v.array(
    v.object({
      kind: v.picklist(["branch", "service"]),
      action: v.picklist(["create", "update", "delete", "noop"]),
      identifier: v.string(),
    }),
  ),
  conflicts: v.array(v.unknown()),
});

/** Plans function code deployment without resolving application secrets, bundling code or changing provider resources. */
export async function planNeonFunctions(options: NeonFunctionPlanOptions, provider?: NeonApi) {
  const config = v.parse(configValidator, options.config);
  const environment = v.parse(v.picklist(["preview", "production"]), options.environment);
  const entries = structuredClone(options.entries);
  const slugs = v.parse(slugsValidator, options.slugs);
  createNeonActivationVerifier(entries.binding);
  if (!v.is(v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)), entries.hash))
    throw new Error("Invalid deployment artifact hash");
  const api = provider ?? createKelloNeonApi();
  const target = await inspectDeploymentTarget(config, environment, api);
  const binding = entries.binding;
  if (
    binding.projectId !== target.projectId ||
    binding.branchId !== target.branchId ||
    binding.branchName !== target.branchName ||
    binding.endpointHost.split(".")[0] !== target.endpointId ||
    binding.metadataNamespace !== config.database.metadataNamespace
  )
    throw new Error("Deployment activation binding does not match the selected target");
  const policy = neonFunctionPolicy([
    { role: "service", slug: slugs.service, source: entries.service },
    { role: "worker", slug: slugs.worker, source: entries.worker },
  ]);
  const planned = await plan(policy, { projectId: target.projectId, branchId: target.branchId, api }).catch((cause) => {
    if (cause instanceof NeonCredentialError) throw cause;
    throw new Error("Could not plan Neon functions");
  });
  const parsed = v.safeParse(plannedResult, planned);
  if (!parsed.success) throw new Error("Invalid Neon function plan");
  const result = parsed.output;
  if (
    result.projectId !== target.projectId ||
    result.branchId !== target.branchId ||
    result.branchName !== target.branchName
  )
    throw new Error("Neon function plan target changed");
  const current = await inspectDeploymentTarget(config, environment, api);
  if (JSON.stringify(current) !== JSON.stringify(target)) throw new Error("Neon function plan target changed");
  if (result.conflicts.length) throw new Error("Neon function policy conflicts with the selected target");
  if (
    result.applied.some(
      (change) =>
        !(change.kind === "branch" && change.action === "noop" && change.identifier === target.branchName) &&
        !(
          change.kind === "service" &&
          (change.action === "create" || change.action === "update") &&
          (change.identifier === `function:${slugs.service}` || change.identifier === `function:${slugs.worker}`)
        ),
    )
  )
    throw new Error("Neon function plan contains unexpected resource changes");
  const functions = (["service", "worker"] as const).map((role) => {
    const changes = result.applied.filter((change) => change.identifier === `function:${slugs[role]}`);
    const change = changes[0];
    if (changes.length !== 1 || !change || (change.action !== "create" && change.action !== "update"))
      throw new Error("Incomplete Neon function plan");
    return Object.freeze({ role, slug: slugs[role], action: change.action });
  });
  return Object.freeze({
    dryRun: true as const,
    target,
    version: binding.version,
    artifactHash: entries.hash,
    functions: Object.freeze(functions),
  });
}
