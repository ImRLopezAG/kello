import type pg from "pg";
import { neonIngressLockKey } from "kello/neon";
import type { NeonApi } from "@neon/config-runtime/v1";
import type { KelloConfig } from "../../config/define-config";
import { quoteIdentifier } from "../../migrations/connection";
import { deploymentConnectionContext } from "./connection";
import { disableNeonTriggers } from "./triggers";
import type { DeploymentEnvironment } from "./target";

interface ReleaseIngress {
  readonly deployment: string;
  readonly releaseKey: string;
  readonly version: string;
}
export class SupersededReleaseError extends Error {
  constructor() {
    super("Release ingress was superseded; use a new release declaration for an explicit rollback");
  }
}
export async function assertReleaseIngress(client: pg.Client, options: ReleaseIngress): Promise<void> {
  const { target, metadataNamespace } = deploymentConnectionContext(client);
  const result = await client.query<{ version: string; state: string }>(
    `SELECT version,state FROM ${quoteIdentifier(metadataNamespace)}.release_ingress
      WHERE project_id=$1 AND branch_id=$2 AND deployment=$3 AND release_key=$4`,
    [target.projectId, target.branchId, options.deployment, options.releaseKey],
  );
  const row = result.rows[0];
  if (row && (row.state === "retired" || row.version !== options.version)) throw new SupersededReleaseError();
}
export async function prepareReleaseIngress(client: pg.Client, options: ReleaseIngress): Promise<void> {
  await assertReleaseIngress(client, options);
  const { target, metadataNamespace } = deploymentConnectionContext(client);
  await client.query(
    `INSERT INTO ${quoteIdentifier(metadataNamespace)}.release_ingress(project_id,branch_id,deployment,release_key,version,state)
      VALUES ($1,$2,$3,$4,$5,'candidate') ON CONFLICT DO NOTHING`,
    [target.projectId, target.branchId, options.deployment, options.releaseKey, options.version],
  );
}

export async function retainedWorkerSlugs(
  client: pg.Client,
  options: { readonly deployment: string; readonly workerSlug: string },
): Promise<string[]> {
  const { target, metadataNamespace } = deploymentConnectionContext(client);
  const meta = quoteIdentifier(metadataNamespace);
  const workers = await client.query<{ slug: string }>(
    `SELECT f.slug FROM ${meta}.function_ownership f JOIN ${meta}.deployment_activations a
      ON a.deployment=f.deployment AND a.version=f.version AND a.project_id=f.project_id AND a.branch_id=f.branch_id
      WHERE f.project_id=$1 AND f.branch_id=$2 AND f.deployment=$3 AND f.role='worker' AND f.slug<>$4 AND a.state='active'`,
    [target.projectId, target.branchId, options.deployment, options.workerSlug],
  );
  return workers.rows.map((row) => row.slug);
}

/** Holds deployment ownership across the durable claim and provider disablement; retries preserve old job wakeups. */
export async function handoffNeonIngress(
  client: pg.Client,
  options: ReleaseIngress & {
    readonly config: KelloConfig;
    readonly environment: DeploymentEnvironment;
    readonly workerSlug: string;
  },
  provider: NeonApi,
): Promise<void> {
  await assertReleaseIngress(client, options);
  const { target, metadataNamespace, signal } = deploymentConnectionContext(client);
  const meta = quoteIdentifier(metadataNamespace);
  signal?.throwIfAborted();
  await client.query("BEGIN");
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      neonIngressLockKey({
        metadataNamespace,
        projectId: target.projectId,
        branchId: target.branchId,
        deployment: options.deployment,
      }),
    ]);
    signal?.throwIfAborted();
    await client.query(
      `UPDATE ${meta}.release_ingress SET state='retired' WHERE project_id=$1 AND branch_id=$2 AND deployment=$3 AND release_key<>$4`,
      [target.projectId, target.branchId, options.deployment, options.releaseKey],
    );
    await client.query(
      `INSERT INTO ${meta}.release_ingress(project_id,branch_id,deployment,release_key,version,state)
        VALUES ($1,$2,$3,$4,$5,'current') ON CONFLICT(project_id,branch_id,deployment,release_key) DO UPDATE SET state='current'`,
      [target.projectId, target.branchId, options.deployment, options.releaseKey, options.version],
    );
    await client.query("COMMIT");
  } catch (cause) {
    await client.query("ROLLBACK");
    throw cause;
  }
  const workers = await retainedWorkerSlugs(client, options);
  signal?.throwIfAborted();
  if (workers.length)
    await disableNeonTriggers(
      {
        config: options.config,
        environment: options.environment,
        workerSlugs: workers,
        preserveJobWake: true,
      },
      provider,
    );
  signal?.throwIfAborted();
}
