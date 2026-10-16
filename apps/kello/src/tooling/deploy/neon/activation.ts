import { createHash } from "node:crypto";
import type pg from "pg";
import type { NeonActivationOptions } from "kello/neon";
import * as v from "valibot";
import { quoteIdentifier } from "../../migrations/connection";
import { ownsProcedureUpgrade, withProcedureUpgrade } from "../../migrations/procedure-upgrade";
import { quarantineDeploymentConnection } from "./quarantine";
import type { PreviewQuarantineReceipt } from "./quarantine";
import type { DeploymentTarget } from "./target";
import { deploymentConnectionContext, withDeploymentConnection } from "./connection";
import type { DeploymentConnectionOptions, DeploymentDatabaseProvider } from "./connection";

export interface DeploymentActivationOptions extends DeploymentConnectionOptions {
  readonly deployment: string;
  readonly version: string;
  /** Generate 32 random bytes outside the receipt; keep the same secret when resuming preparation. */
  readonly activationToken: string;
}
export type DeploymentActivationConnectionOptions = Pick<
  DeploymentActivationOptions,
  "deployment" | "version" | "activationToken" | "signal"
>;
export interface DeploymentActivationReceipt {
  readonly binding: NeonActivationOptions;
  readonly state: "quarantined" | "active";
}

const grantPredicate =
  "deployment = $1 AND version = $2 AND project_id = $3 AND branch_id = $4 AND endpoint_host = $5 AND database_name = $6 AND token_hash = $7";
function grantParameters(binding: NeonActivationOptions, tokenHash: string) {
  return [
    binding.deployment,
    binding.version,
    binding.projectId,
    binding.branchId,
    binding.endpointHost,
    binding.databaseName,
    tokenHash,
  ];
}

function activationIdentity(options: DeploymentActivationConnectionOptions) {
  const { deployment, version, activationToken } = options;
  if (
    !v.is(v.pipe(v.string(), v.minLength(1), v.maxLength(256)), deployment) ||
    !v.is(v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)), version) ||
    !v.is(v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)), activationToken)
  )
    throw new Error("Invalid deployment activation input");
  return { deployment, version, activationToken };
}

async function withActivation<T>(
  client: pg.Client,
  options: DeploymentActivationConnectionOptions,
  operation: (
    client: pg.Client,
    binding: NeonActivationOptions,
    tokenHash: string,
    target: DeploymentTarget,
  ) => Promise<T>,
): Promise<T> {
  const { target, database, metadataNamespace } = deploymentConnectionContext(client);
  const { deployment, version, activationToken } = activationIdentity(options);
  const tokenHash = createHash("sha256").update(activationToken).digest("hex");
  const owner = await client.query<{ owned: boolean }>(
    "SELECT nspowner = (SELECT oid FROM pg_roles WHERE rolname = current_user) AS owned FROM pg_namespace WHERE nspname = $1",
    [metadataNamespace],
  );
  if (owner.rows[0]?.owned !== true) throw new Error("Activation requires the metadata owner");
  const binding = Object.freeze({
    metadataNamespace,
    deployment,
    version,
    projectId: target.projectId,
    branchId: target.branchId,
    branchName: target.branchName,
    endpointHost: database.endpointHost,
    databaseName: database.databaseName,
  });
  return operation(client, binding, tokenHash, target);
}

async function requireQuarantineCompleted(client: pg.Client, binding: NeonActivationOptions): Promise<void> {
  const schema = quoteIdentifier(binding.metadataNamespace);
  const result = await client.query<{ blocked: boolean }>(
    `SELECT
    EXISTS (SELECT 1 FROM ${schema}.deployment_activations WHERE state = 'active' AND (project_id <> $1 OR branch_id <> $2))
    OR (NOT EXISTS (SELECT 1 FROM ${schema}.deployment_activations
      WHERE state = 'active' AND project_id = $1 AND branch_id = $2 AND endpoint_host = $3 AND database_name = $4)
      AND EXISTS (SELECT 1 FROM ${schema}.jobs WHERE state IN ('pending', 'running'))) AS blocked`,
    [binding.projectId, binding.branchId, binding.endpointHost, binding.databaseName],
  );
  if (result.rows[0]?.blocked !== false) throw new Error("Branch requires quarantine");
}

/** Internal stage shared by verified deployment and development connection owners. */
export async function prepareGrant(
  client: pg.Client,
  binding: NeonActivationOptions,
  tokenHash: string,
  signal?: AbortSignal,
): Promise<DeploymentActivationReceipt> {
  const table = `${quoteIdentifier(binding.metadataNamespace)}.deployment_activations`;
  await client.query("BEGIN");
  try {
    await requireQuarantineCompleted(client, binding);
    await client.query(
      `INSERT INTO ${table} (deployment, version, project_id, branch_id, endpoint_host, database_name, token_hash)
        VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (deployment, version) DO NOTHING`,
      grantParameters(binding, tokenHash),
    );
    const receipt = await inspectGrant(client, binding, tokenHash);
    signal?.throwIfAborted();
    await client.query("COMMIT");
    return receipt;
  } catch {
    await client.query("ROLLBACK").catch(() => {});
    throw new Error("Activation grant preparation failed");
  }
}

async function inspectGrant(
  client: pg.Client,
  binding: NeonActivationOptions,
  tokenHash: string,
): Promise<DeploymentActivationReceipt> {
  const result = await client.query<{ state: "quarantined" | "active" | "retired" }>(
    `SELECT state FROM ${quoteIdentifier(binding.metadataNamespace)}.deployment_activations WHERE ${grantPredicate}`,
    grantParameters(binding, tokenHash),
  );
  const row = result.rows[0];
  if (!row || result.rows.length !== 1) throw new Error("Deployment grant is missing or changed");
  if (row.state === "retired") throw new Error("Deployment grant is retired");
  return Object.freeze({ binding, state: row.state });
}

export async function activateGrant(
  client: pg.Client,
  binding: NeonActivationOptions,
  tokenHash: string,
  signal?: AbortSignal,
): Promise<DeploymentActivationReceipt> {
  if (!ownsProcedureUpgrade(client, binding))
    return withProcedureUpgrade(
      client,
      {
        metadataNamespace: binding.metadataNamespace,
        deployment: binding.deployment,
        version: binding.version,
        protocol: "loom-legacy-1",
        procedures: [],
        migrations: [],
      },
      () => activateGrant(client, binding, tokenHash, signal),
    );
  const table = `${quoteIdentifier(binding.metadataNamespace)}.deployment_activations`;
  try {
    await requireQuarantineCompleted(client, binding);
    signal?.throwIfAborted();
    const result = await client.query(
      `UPDATE ${table} SET state = 'active', updated_at = clock_timestamp()
        WHERE ${grantPredicate} AND state IN ('quarantined', 'active')`,
      grantParameters(binding, tokenHash),
    );
    if (result.rowCount !== 1) throw new Error("Grant missing or changed");
    return Object.freeze({ binding, state: "active" });
  } catch {
    throw new Error("Deployment database activation failed");
  }
}

export interface DeploymentActivationSession {
  readonly binding: NeonActivationOptions;
  quarantinePreview(): Promise<PreviewQuarantineReceipt>;
  prepare(): Promise<DeploymentActivationReceipt>;
  inspect(): Promise<DeploymentActivationReceipt>;
  activate(): Promise<DeploymentActivationReceipt>;
  assertActive(signal?: AbortSignal): Promise<void>;
}

/** Holds one deployment lock across ordered stages. Use session methods sequentially; do not nest connection-owning helpers. */
export async function withDeploymentActivationSession<T>(
  options: DeploymentActivationOptions,
  operation: (session: DeploymentActivationSession, client: pg.Client) => Promise<T>,
  provider?: DeploymentDatabaseProvider,
): Promise<T> {
  const activation = activationIdentity(options);
  return withDeploymentConnection(
    options,
    (client) => withDeploymentActivationSessionOnConnection(client, activation, operation),
    provider,
  );
}

/** Borrows an existing verified deployment connection after migrations; never opens or releases its lock. */
export async function withDeploymentActivationSessionOnConnection<T>(
  client: pg.Client,
  options: DeploymentActivationConnectionOptions,
  operation: (session: DeploymentActivationSession, client: pg.Client) => Promise<T>,
): Promise<T> {
  const context = deploymentConnectionContext(client);
  const signals = [context.signal, options.signal].filter((value): value is AbortSignal => value !== undefined);
  const signal = AbortSignal.any(signals);
  signal.throwIfAborted();
  const environment = context.target.environment;
  return withActivation(client, options, async (client, binding, tokenHash, target) => {
    signal.throwIfAborted();
    let closed = false;
    let busy = false;
    let pending: Promise<void> | undefined;
    async function run<R>(action: () => Promise<R>, stageSignal?: AbortSignal): Promise<R> {
      if (closed) throw new Error("Deployment activation session is closed");
      if (busy) throw new Error("Deployment activation stages must run sequentially");
      deploymentConnectionContext(client);
      signal?.throwIfAborted();
      stageSignal?.throwIfAborted();
      busy = true;
      try {
        const result = action();
        pending = result.then(
          () => {},
          () => {},
        );
        const value = await result;
        signal?.throwIfAborted();
        stageSignal?.throwIfAborted();
        return value;
      } finally {
        busy = false;
      }
    }
    const session: DeploymentActivationSession = Object.freeze({
      binding,
      quarantinePreview: () =>
        run(() => quarantineDeploymentConnection(client, binding.metadataNamespace, target, environment, signal)),
      prepare: () => run(() => prepareGrant(client, binding, tokenHash, signal)),
      inspect: () => run(() => inspectGrant(client, binding, tokenHash)),
      activate: () => run(() => activateGrant(client, binding, tokenHash, signal)),
      assertActive: (stageSignal?: AbortSignal) =>
        run(async () => {
          try {
            const result = await client.query(
              `SELECT 1 FROM ${quoteIdentifier(binding.metadataNamespace)}.deployment_activations WHERE ${grantPredicate} AND state = 'active'`,
              grantParameters(binding, tokenHash),
            );
            if (result.rowCount !== 1) throw new Error("Grant missing or changed");
          } catch {
            throw new Error("Deployment grant is not active");
          }
        }, stageSignal),
    });
    try {
      return await operation(session, client);
    } finally {
      closed = true;
      await pending;
    }
  });
}

/** Stages a hash-only, quarantined grant. A retry must use the same token and target. */
export async function prepareDeploymentActivation(
  options: DeploymentActivationOptions,
  provider?: DeploymentDatabaseProvider,
): Promise<DeploymentActivationReceipt> {
  return withDeploymentActivationSession(options, (session) => session.prepare(), provider);
}

/** Final database stage only: first verify compatible code, secrets and disabled copied triggers. */
export async function activateDeploymentDatabase(
  options: DeploymentActivationOptions & { readonly binding: NeonActivationOptions },
  provider?: DeploymentDatabaseProvider,
): Promise<DeploymentActivationReceipt> {
  const expected = structuredClone(options.binding);
  return withDeploymentActivationSession(
    options,
    async (session) => {
      if (
        (
          [
            "metadataNamespace",
            "deployment",
            "version",
            "projectId",
            "branchId",
            "branchName",
            "endpointHost",
            "databaseName",
          ] as const
        ).some((key) => session.binding[key] !== expected[key])
      )
        throw new Error("Deployment activation binding changed");
      return session.activate();
    },
    provider,
  );
}
