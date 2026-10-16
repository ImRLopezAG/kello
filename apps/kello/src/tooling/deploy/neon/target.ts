import { NeonCredentialError } from "../../neon/credentials";
import { createKelloNeonApi } from "../../neon/api";
import type { NeonApi } from "@neon/config-runtime/v1";
import * as v from "valibot";
import { configValidator } from "../../config/define-config";
import type { KelloConfig } from "../../config/define-config";

export type DeploymentEnvironment = "preview" | "production";
export type DeploymentProvider = Pick<NeonApi, "getProject" | "listBranches" | "listEndpoints">;
export interface DeploymentTarget {
  readonly environment: DeploymentEnvironment;
  readonly projectId: string;
  readonly branchId: string;
  readonly branchName: string;
  readonly endpointId: string;
  readonly postgresVersion: 18;
  readonly protected: boolean;
}
const identifier = v.pipe(v.string(), v.minLength(1));
const projectMetadata = v.object({ id: identifier, pgVersion: v.number() });
const branchMetadata = v.array(
  v.object({ id: identifier, name: identifier, protected: v.boolean(), isDefault: v.boolean() }),
);
const endpointMetadata = v.array(
  v.object({ id: identifier, branchId: identifier, type: v.picklist(["read_only", "read_write"]) }),
);

/** Read-only preflight. Resolves current provider identity; copied database metadata cannot satisfy it. */
export async function inspectDeploymentTarget(
  input: KelloConfig,
  environment: DeploymentEnvironment,
  provider?: DeploymentProvider,
): Promise<DeploymentTarget> {
  const config = v.parse(configValidator, input);
  const selectedEnvironment = v.parse(v.picklist(["preview", "production"]), environment);
  const selection =
    config.provider ??
    (config.projectId && config.branchId && selectedEnvironment === "preview"
      ? { projectId: config.projectId, targets: { preview: { branchId: config.branchId, protected: false } } }
      : undefined);
  const target = selection?.targets[selectedEnvironment];
  if (!selection || !target)
    throw new Error("Link a preview branch with kello link, or configure an explicit production target");
  if (
    Object.entries(selection.targets).some(
      ([name, other]) => name !== selectedEnvironment && other?.branchId === target.branchId,
    )
  )
    throw new Error("Deployment environments require separate branches");
  const api = provider ?? createKelloNeonApi();
  const responses = await Promise.all([
    api.getProject(selection.projectId),
    api.listBranches(selection.projectId),
    api.listEndpoints(selection.projectId),
  ]).catch((cause) => {
    if (cause instanceof NeonCredentialError) throw cause;
    throw new Error("Could not inspect deployment target");
  });
  // Parse only identity fields, excluding provider credentials and unneeded response data.
  const parsed = v.safeParse(v.tuple([projectMetadata, branchMetadata, endpointMetadata]), responses);
  if (!parsed.success) throw new Error("Incomplete deployment target metadata");
  const [project, branches, endpoints] = parsed.output;
  if (project.id !== selection.projectId) throw new Error("Provider returned a different project");
  if (project.pgVersion !== 18) throw new Error("Deployment requires PostgreSQL 18");
  const matches = branches.filter((branch) => branch.id === target.branchId);
  const branch = matches[0];
  if (!branch || matches.length !== 1) throw new Error("Deployment branch was not uniquely resolved");
  if (branch.protected !== target.protected) throw new Error("Deployment branch protection differs from configuration");
  if (selectedEnvironment === "preview" && (branch.protected || branch.isDefault))
    throw new Error("Preview deployment refuses protected or default branches");
  const writable = endpoints.filter((endpoint) => endpoint.branchId === branch.id && endpoint.type === "read_write");
  const endpoint = writable[0];
  if (!endpoint || writable.length !== 1) throw new Error("Deployment requires exactly one read-write endpoint");
  return Object.freeze({
    environment: selectedEnvironment,
    projectId: project.id,
    branchId: branch.id,
    branchName: branch.name,
    endpointId: endpoint.id,
    postgresVersion: 18,
    protected: branch.protected,
  });
}
