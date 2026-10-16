import type pg from "pg";
import type { DeploymentEnvironment, DeploymentTarget } from "./target";
import * as v from "valibot";
import { configValidator } from "../../config/define-config";
import { quoteIdentifier } from "../../migrations/connection";
import { withDeploymentConnection } from "./connection";
import type { DeploymentConnectionOptions, DeploymentDatabaseProvider } from "./connection";

/** Database stage only. Provider triggers must be disabled separately before branch activation. */
export async function quarantinePreviewDatabase(
  options: DeploymentConnectionOptions & { readonly environment: "preview" },
  provider?: DeploymentDatabaseProvider,
) {
  if (options.environment !== "preview") throw new Error("Quarantine requires an explicit preview target");
  const config = v.parse(configValidator, options.config);
  const namespace = config.database.metadataNamespace;
  return withDeploymentConnection(
    { ...options, config },
    async (client, target) => {
      return quarantineDeploymentConnection(client, namespace, target, "preview", options.signal);
    },
    provider,
  );
}

export interface BranchQuarantineReceipt {
  readonly projectId: string;
  readonly branchId: string;
  readonly endpointId: string;
  readonly revokedGrants: number;
  readonly cancelledJobs: number;
}
export type PreviewQuarantineReceipt = BranchQuarantineReceipt;

/** Internal stage: the caller owns the verified deployment connection and lock. */
export async function quarantineDeploymentConnection(
  client: pg.Client,
  namespace: string,
  target: DeploymentTarget,
  environment: DeploymentEnvironment,
  signal?: AbortSignal,
): Promise<PreviewQuarantineReceipt> {
  if (environment !== "preview") throw new Error("Quarantine requires an explicit preview target");
  return quarantineBranchConnection(client, namespace, target, signal);
}

/** Internal transaction; callers own a verified nonproduction target and its deployment lock. */
export async function quarantineBranchConnection(
  client: pg.Client,
  namespace: string,
  target: Pick<DeploymentTarget, "projectId" | "branchId" | "endpointId">,
  signal?: AbortSignal,
): Promise<BranchQuarantineReceipt> {
  signal?.throwIfAborted();
  const schema = quoteIdentifier(namespace);
  const owner = await client.query<{ owned: boolean }>(
    "SELECT nspowner = (SELECT oid FROM pg_roles WHERE rolname = current_user) AS owned FROM pg_namespace WHERE nspname = $1",
    [namespace],
  );
  if (owner.rows[0]?.owned !== true) throw new Error("Quarantine requires the metadata owner");
  await client.query("BEGIN");
  try {
    const grants = await client.query(
      `UPDATE ${schema}.deployment_activations SET state = 'quarantined', updated_at = clock_timestamp() WHERE state = 'active'`,
    );
    const jobs = await client.query(`UPDATE ${schema}.jobs
        SET state = 'cancelled', cancel_requested = TRUE, lease_owner = NULL, lease_expires_at = NULL,
          fencing_token = fencing_token + 1, error_code = 'CANCELLED'
        WHERE state IN ('pending', 'running')`);
    signal?.throwIfAborted();
    await client.query("COMMIT");
    return Object.freeze({
      projectId: target.projectId,
      branchId: target.branchId,
      endpointId: target.endpointId,
      revokedGrants: grants.rowCount ?? 0,
      cancelledJobs: jobs.rowCount ?? 0,
    });
  } catch {
    await client.query("ROLLBACK").catch(() => {});
    throw new Error("Branch quarantine transaction failed");
  }
}
