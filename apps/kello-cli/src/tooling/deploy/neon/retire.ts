import { createKelloNeonApi } from "../../neon/api";
import { createHash } from "node:crypto";
import * as v from "valibot";
import { acquireMigrationLock, quoteIdentifier } from "../../migrations/connection";
import { deploymentConnectionContext, withDeploymentConnection } from "./connection";
import type { DeploymentConnectionOptions, DeploymentDatabaseProvider } from "./connection";
import { inspectNeonFunctionHealth } from "./health";
import type { DeploymentHealthProvider } from "./health";
import { readNeonReleaseReceipt } from "./release-receipt";

export interface NeonReleaseRetirementOptions extends DeploymentConnectionOptions {
  readonly releaseKey: string;
  readonly activationToken: string;
}

/** Retires database authority after draining supported handlers. Retains provider functions, triggers and receipts. */
export async function retireNeonReleaseDatabase(
  root: string,
  input: NeonReleaseRetirementOptions,
  provider?: DeploymentDatabaseProvider & DeploymentHealthProvider,
) {
  const { signal = new AbortController().signal, ...values } = input;
  const options = structuredClone(values);
  const token = v.parse(v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)), options.activationToken);
  signal.throwIfAborted();
  const receipt = await readNeonReleaseReceipt(root, options.releaseKey);
  const functions = receipt?.completed.find((stage) => stage.stage === "functions");
  if (!receipt?.completed.some((stage) => stage.stage === "complete") || !functions)
    throw new Error("Retirement requires a completed release receipt");
  const api = provider ?? createKelloNeonApi();
  return withDeploymentConnection(
    { ...options, signal },
    async (client, target, database) => {
      const { namespace, metadataNamespace } = deploymentConnectionContext(client);
      const identity = receipt.identity;
      if (
        JSON.stringify(target) !== JSON.stringify(identity.target) ||
        JSON.stringify({ ...database, namespace, metadataNamespace }) !== JSON.stringify(identity.database)
      )
        throw new Error("Retirement target differs from the release receipt");
      const ownership = await client.query<{ owned: boolean }>(
        "SELECT nspowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AS owned FROM pg_namespace WHERE nspname=$1",
        [metadataNamespace],
      );
      if (ownership.rows[0]?.owned !== true) throw new Error("Retirement requires the metadata owner");
      const meta = quoteIdentifier(metadataNamespace);
      const parameters = [
        identity.deployment,
        identity.version,
        target.projectId,
        target.branchId,
        database.endpointHost,
        database.databaseName,
        createHash("sha256").update(token).digest("hex"),
      ];
      const predicate =
        "deployment=$1 AND version=$2 AND project_id=$3 AND branch_id=$4 AND endpoint_host=$5 AND database_name=$6 AND token_hash=$7";
      async function readGrantState() {
        const result = await client.query<{ state: string }>(
          `SELECT state FROM ${meta}.deployment_activations WHERE ${predicate}`,
          parameters,
        );
        const observed = result.rows[0]?.state;
        if (result.rows.length !== 1 || (observed !== "active" && observed !== "retired"))
          throw new Error("Retirement grant is missing, inactive or changed");
        return observed;
      }
      await acquireMigrationLock(client, `loom:migrations:${namespace}`, false, signal);
      if ((await readGrantState()) === "active") {
        const health = await inspectNeonFunctionHealth(
          root,
          {
            config: options.config,
            environment: options.environment,
            artifactHash: functions.artifactHash,
            activationToken: token,
            signal,
          },
          api,
        );
        if (
          health.version !== identity.version ||
          JSON.stringify(health.target) !== JSON.stringify(target) ||
          health.functions.some(
            (fn, index) =>
              fn.databaseDrainProtocol !== 1 ||
              fn.functionId !== functions.functions[index]?.functionId ||
              fn.deploymentId !== functions.functions[index]?.deploymentId ||
              fn.role !== functions.functions[index]?.role,
          )
        )
          throw new Error("Retirement requires matching database-drain support from both runtimes");
      }
      signal.throwIfAborted();
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      try {
        // Take the barrier before observing authority or dependencies; no stale transaction snapshot may precede it.
        await client.query(`LOCK TABLE ${meta}.deployment_activations IN ACCESS EXCLUSIVE MODE NOWAIT`).catch(() => {
          throw new Error("Runtime database work has not drained; retry retirement");
        });
        const observed = await readGrantState();
        const dependencies = await client.query<{ ingress: boolean; jobs: boolean; sessions: boolean }>(
          `SELECT
          (NOT EXISTS (SELECT 1 FROM ${meta}.release_ingress WHERE deployment=$1 AND version=$2
            AND project_id=$3 AND branch_id=$4 AND state='retired') OR
          EXISTS (SELECT 1 FROM ${meta}.release_ingress WHERE deployment=$1 AND version=$2
            AND project_id=$3 AND branch_id=$4 AND state<>'retired')) AS ingress,
          EXISTS (SELECT 1 FROM ${meta}.jobs WHERE deployment=$1 AND state IN ('pending','running')
            AND (COALESCE(claim_version,call->>'version')=$2 OR COALESCE(claim_version,call->>'version') IS NULL)) AS jobs,
          EXISTS (SELECT 1 FROM ${meta}.client_sessions WHERE deployment=$1 AND version=$2
            AND expires_at>clock_timestamp()) AS sessions`,
          parameters.slice(0, 4),
        );
        const blocked = dependencies.rows[0];
        if (!blocked) throw new Error("Retirement dependency observation failed");
        if (blocked.ingress) throw new Error("Release ingress is not retired");
        if (blocked.jobs) throw new Error("Queued or running jobs require this runtime");
        if (blocked.sessions) throw new Error("Unexpired client sessions require this runtime");
        if (observed === "active") {
          const result = await client.query(
            `UPDATE ${meta}.deployment_activations SET state='retired',updated_at=clock_timestamp()
            WHERE ${predicate} AND state='active'`,
            parameters,
          );
          if (result.rowCount !== 1) throw new Error("Retirement grant changed");
        }
        signal.throwIfAborted();
        await client.query("COMMIT");
      } catch (cause) {
        await client.query("ROLLBACK").catch(() => {});
        throw cause;
      }
      return Object.freeze({
        releaseKey: options.releaseKey,
        deployment: identity.deployment,
        version: identity.version,
        state: "retired" as const,
      });
    },
    api,
  );
}
