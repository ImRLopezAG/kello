import type pg from "pg";
import { neonTriggerBindingValidator } from "kello/neon";
import type { NeonTriggerBinding, NeonActivationOptions } from "kello/neon";
import * as v from "valibot";
import { quoteIdentifier } from "../../migrations/connection";

/** The migration identity publishes immutable bindings before release activation. */
export async function publishNeonTriggerBindings(
  client: pg.Client,
  binding: NeonActivationOptions,
  input: Readonly<Record<string, NeonTriggerBinding>>,
): Promise<void> {
  const bindings = v.parse(v.record(v.string(), neonTriggerBindingValidator), input);
  const table = `${quoteIdentifier(binding.metadataNamespace)}.deployment_trigger_bindings`;
  const values = [binding.deployment, binding.version, binding.projectId, binding.branchId, JSON.stringify(bindings)];
  await client.query(
    `INSERT INTO ${table}(deployment,version,project_id,branch_id,bindings)
      VALUES ($1,$2,$3,$4,$5::jsonb) ON CONFLICT DO NOTHING`,
    values,
  );
  const verified = await client.query(
    `SELECT 1 FROM ${table} WHERE deployment=$1 AND version=$2 AND project_id=$3 AND branch_id=$4 AND bindings=$5::jsonb`,
    values,
  );
  if (verified.rows.length !== 1) throw new Error("Deployment trigger bindings changed");
}
