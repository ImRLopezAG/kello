import { setTimeout } from "node:timers/promises";
import { sql } from "drizzle-orm";
import type { ActivationDatabase } from "../../server/runtime-contracts";
import { IngressRetiredError } from "../../server/ingress";
import { createNeonActivationVerifier } from "./activation";
import type { NeonActivationOptions } from "./activation";

export function neonIngressLockKey(
  binding: Pick<NeonActivationOptions, "metadataNamespace" | "projectId" | "branchId" | "deployment">,
): string {
  return `loom:ingress:${JSON.stringify([binding.metadataNamespace, binding.projectId, binding.branchId, binding.deployment])}`;
}

/** Call inside a read-committed enqueue transaction; its shared lock lasts through commit or rollback. */
export function createNeonIngressVerifier(options: NeonActivationOptions) {
  const binding = structuredClone(options);
  const active = createNeonActivationVerifier(binding);
  const table = sql`${sql.identifier(binding.metadataNamespace)}.${sql.identifier("release_ingress")}`;
  const key = neonIngressLockKey(binding);
  return async (signal: AbortSignal, database: ActivationDatabase): Promise<void> => {
    signal.throwIfAborted();
    try {
      await active(signal, database);
      const deadline = performance.now() + 5000;
      for (;;) {
        signal.throwIfAborted();
        const lock = await database.db.execute<{ acquired: boolean; isolation_level: string }>(sql`
          SELECT pg_try_advisory_xact_lock_shared(hashtextextended(${key},0)) AS acquired,
            current_setting('transaction_isolation') AS isolation_level`);
        const observed = lock.rows[0];
        if (!observed || observed.isolation_level !== "read committed")
          throw new Error("Unsupported ingress isolation");
        if (observed.acquired) break;
        if (performance.now() >= deadline) throw new Error("Ingress lock timed out");
        await setTimeout(25, undefined, { signal });
      }
      signal.throwIfAborted();
      const observed = await database.db.execute<{ version: string }>(sql`
        SELECT version FROM ${table} WHERE project_id=${binding.projectId} AND branch_id=${binding.branchId}
          AND deployment=${binding.deployment} AND state='current'`);
      if (observed.rows.length !== 1) throw new Error("Ingress is not current");
      if (observed.rows[0]?.version !== binding.version) throw new IngressRetiredError();
    } catch (cause) {
      signal.throwIfAborted();
      if (cause instanceof IngressRetiredError) throw cause;
      throw new Error("Runtime ingress denied");
    }
    signal.throwIfAborted();
  };
}
