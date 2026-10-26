import type pg from "pg";
import { quoteIdentifier } from "../../migrations/connection";
import { deploymentConnectionContext } from "./connection";

interface FunctionOwner {
  readonly deployment: string;
  readonly version: string;
  readonly slugs: Readonly<{ service: string; worker: string }>;
}
export class FunctionOwnershipError extends Error {
  constructor() {
    super("Function names belong to another runtime; choose distinct names for this version");
  }
}

/** Metadata ownership survives checkout loss and keeps releases from replacing another version's endpoints. */
export async function inspectFunctionOwnership(client: pg.Client, owner: FunctionOwner): Promise<void> {
  const { target, metadataNamespace } = deploymentConnectionContext(client);
  const rows = await client.query<{ slug: string; deployment: string; version: string; role: string }>(
    `SELECT slug,deployment,version,role FROM ${quoteIdentifier(metadataNamespace)}.function_ownership
      WHERE project_id=$1 AND branch_id=$2 AND slug=ANY($3::text[])`,
    [target.projectId, target.branchId, [owner.slugs.service, owner.slugs.worker]],
  );
  for (const row of rows.rows)
    if (
      row.deployment !== owner.deployment ||
      row.version !== owner.version ||
      (row.role === "service" ? owner.slugs.service : owner.slugs.worker) !== row.slug
    )
      throw new FunctionOwnershipError();
}

/** Called under the database deployment lock before any function or trigger mutation. Reservations are never recycled. */
export async function reserveFunctionOwnership(client: pg.Client, owner: FunctionOwner): Promise<void> {
  const { target, metadataNamespace } = deploymentConnectionContext(client);
  await inspectFunctionOwnership(client, owner);
  await client.query(
    `INSERT INTO ${quoteIdentifier(metadataNamespace)}.function_ownership(project_id,branch_id,slug,deployment,version,role)
      VALUES ($1,$2,$3,$5,$6,'service'),($1,$2,$4,$5,$6,'worker') ON CONFLICT DO NOTHING`,
    [target.projectId, target.branchId, owner.slugs.service, owner.slugs.worker, owner.deployment, owner.version],
  );
  await inspectFunctionOwnership(client, owner);
}
