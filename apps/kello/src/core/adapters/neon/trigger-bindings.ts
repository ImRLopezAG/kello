import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as v from "valibot";
import type { ActivationDatabase } from "../../server/runtime-contracts";
import { createNeonActivationVerifier } from "./activation";
import type { NeonActivationOptions } from "./activation";
import { neonTriggerBindingValidator } from "./triggers";

/** Uses runtime SELECT privileges; never trusts event payloads to establish a binding. */
export async function loadNeonTriggerBindings(
  input: NeonActivationOptions,
  connectionString: string,
  assertActive: (signal: AbortSignal, database?: ActivationDatabase) => Promise<void>,
) {
  const binding = structuredClone(input);
  createNeonActivationVerifier(binding);
  const signal = AbortSignal.timeout(10000);
  await assertActive(signal);
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 5000, query_timeout: 5000 });
  try {
    await client.connect();
    await assertActive(signal, {
      deployment: binding.deployment,
      version: binding.version,
      metadataNamespace: binding.metadataNamespace,
      connectionString,
      db: drizzle({ client }),
    });
    const result = await client.query<{ bindings: unknown }>(
      `SELECT bindings FROM "${binding.metadataNamespace}".deployment_trigger_bindings
        WHERE deployment=$1 AND version=$2 AND project_id=$3 AND branch_id=$4`,
      [binding.deployment, binding.version, binding.projectId, binding.branchId],
    );
    signal.throwIfAborted();
    if (result.rows.length !== 1) throw new Error("Deployment trigger bindings missing");
    return v.parse(
      v.record(v.pipe(v.string(), v.minLength(1), v.maxLength(256)), neonTriggerBindingValidator),
      result.rows[0]?.bindings,
    );
  } catch {
    throw new Error("Deployment trigger bindings unavailable");
  } finally {
    await client.end();
  }
}
