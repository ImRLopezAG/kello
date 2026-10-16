import { randomBytes } from "node:crypto";
import * as v from "valibot";
import type { KelloConfig } from "../../config/define-config";
import { bootstrapSession } from "../../migrations/bootstrap";
import { quoteIdentifier } from "../../migrations/connection";
import { createKelloNeonApi } from "../../neon/api";
import { withDeploymentConnection } from "./connection";
import type { DeploymentConnectionOptions, DeploymentDatabaseProvider } from "./connection";
import { releaseDatabaseOptionsValidator } from "./release-database";

const managedOptions = v.pick(releaseDatabaseOptionsValidator, [
  "environment",
  "databaseName",
  "migrationRole",
  "runtimeRole",
  "deployment",
  "version",
]);

/** Secrets remain in owner-only Postgres metadata and Neon, never in link files or receipts. */
export async function resolveManagedDeploymentCredentials(
  config: KelloConfig,
  input: v.InferInput<typeof managedOptions>,
  provider?: DeploymentDatabaseProvider,
  signal?: AbortSignal,
) {
  const options = v.parse(managedOptions, input);
  const api = provider ?? createKelloNeonApi();
  const connection: DeploymentConnectionOptions = signal ? { config, ...options, signal } : { config, ...options };
  return withDeploymentConnection(
    connection,
    async (client, target) => {
      const { metadataNamespace } = config.database;
      await bootstrapSession(client, metadataNamespace, options.runtimeRole, { requireManagedRole: true });
      const schema = quoteIdentifier(metadataNamespace);
      signal?.throwIfAborted();
      await client.query("BEGIN");
      let activationToken: string;
      try {
        await client.query(`ALTER ROLE ${quoteIdentifier(options.runtimeRole)} LOGIN`);
        const result = await client.query<{ token: string; runtime_role: string }>(
          `INSERT INTO ${schema}.deployment_secrets(project_id,branch_id,deployment,version,runtime_role,token)
         VALUES($1,$2,$3,$4,$5,$6)
         ON CONFLICT(project_id,branch_id,deployment,version) DO UPDATE SET token=deployment_secrets.token
         RETURNING token,runtime_role`,
          [
            target.projectId,
            target.branchId,
            options.deployment,
            options.version,
            options.runtimeRole,
            randomBytes(32).toString("hex"),
          ],
        );
        const secret = result.rows[0];
        if (!secret || secret.runtime_role !== options.runtimeRole) throw new Error("Managed release role changed");
        activationToken = secret.token;
        signal?.throwIfAborted();
        await client.query("COMMIT");
      } catch (cause) {
        await client.query("ROLLBACK");
        throw cause;
      }
      const { uri } = await api.getConnectionUri(target.projectId, {
        branchId: target.branchId,
        endpointId: target.endpointId,
        databaseName: options.databaseName,
        roleName: options.runtimeRole,
        pooled: false,
      });
      // Full credential/authority inspection still runs before any Function deployment.
      signal?.throwIfAborted();
      return { runtimeUrl: uri, activationToken };
    },
    api,
  );
}
