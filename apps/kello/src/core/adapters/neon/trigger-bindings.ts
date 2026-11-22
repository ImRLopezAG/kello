import { drizzle } from "drizzle-orm/postgres";
import * as v from "valibot";
import type { ActivationDatabase } from "../../server/runtime-contracts";
import { createRuntimePool } from "../../server/database/pool";
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
  const pool = createRuntimePool({ address: new URL(connectionString), max: 1 });
  try {
    // The activation query takes no signal, so the deadline is enforced here; the finally block then
    // ends the pool and with it any statement still waiting on a stalled database.
    await Promise.race([
      assertActive(signal, {
        deployment: binding.deployment,
        version: binding.version,
        metadataNamespace: binding.metadataNamespace,
        connectionString,
        db: drizzle({ client: pool }),
      }),
      new Promise<never>((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    ]);
    const result = await pool.execute(
      `SELECT bindings FROM "${binding.metadataNamespace}".deployment_trigger_bindings
        WHERE deployment=$1 AND version=$2 AND project_id=$3 AND branch_id=$4`,
      [binding.deployment, binding.version, binding.projectId, binding.branchId],
      { mode: "object", timeout: 5000 },
    );
    signal.throwIfAborted();
    if (result.rows.length !== 1) throw new Error("Deployment trigger bindings missing");
    return v.parse(
      v.record(v.pipe(v.string(), v.minLength(1), v.maxLength(256)), neonTriggerBindingValidator),
      v.parse(v.object({ bindings: v.unknown() }), result.rows[0]).bindings,
    );
  } catch {
    throw new Error("Deployment trigger bindings unavailable");
  } finally {
    await pool.end();
  }
}
