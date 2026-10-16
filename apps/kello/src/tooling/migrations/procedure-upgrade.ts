import type pg from "pg";
import * as v from "valibot";
import { compileJobMigrations, isLegacyJobCall } from "kello/server";
import type { JobMigration, RuntimeProcedureEntry, JsonValue } from "kello/server";
import { databaseIdentifier, quoteIdentifier } from "./connection";

export interface ProcedureUpgradeOptions {
  readonly metadataNamespace: string;
  readonly deployment: string;
  readonly version: string;
  readonly protocol: "loom-legacy-1" | "loom-orpc-2";
  readonly procedures: readonly RuntimeProcedureEntry[];
  readonly migrations: readonly JobMigration[];
  readonly dryRun?: boolean;
}
export interface ProcedureUpgradeBlocker {
  readonly id: string;
  readonly version: string | null;
  readonly reason:
    | "unknown-envelope"
    | "missing-mapping"
    | "drain-required"
    | "replay-receipt"
    | "rollback-incompatible";
}
export class ProcedureUpgradeError extends Error {
  readonly inventory: readonly ProcedureUpgradeBlocker[];
  constructor(inventory: readonly ProcedureUpgradeBlocker[]) {
    super(
      `Durable work blocks activation: ${inventory.length} incompatible jobs; drain the retained release or declare validated migrations`,
    );
    this.inventory = Object.freeze(
      v
        .parse(
          v.pipe(
            v.array(
              v.strictObject({
                id: v.pipe(v.string(), v.uuid()),
                version: v.nullable(v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/))),
                reason: v.picklist([
                  "unknown-envelope",
                  "missing-mapping",
                  "drain-required",
                  "replay-receipt",
                  "rollback-incompatible",
                ]),
              }),
            ),
            v.maxLength(10000),
          ),
          inventory,
        )
        .map((entry) => Object.freeze(entry)),
    );
    Object.freeze(this);
  }
}
const hash = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/));
const upgrades = new WeakMap<pg.Client, { metadataNamespace: string; deployment: string; version: string }>();

/** Only the activation callback inside the verified transaction owns this scope. */
export function ownsProcedureUpgrade(
  client: pg.Client,
  binding: { readonly metadataNamespace: string; readonly deployment: string; readonly version: string },
): boolean {
  const active = upgrades.get(client);
  return (
    active?.metadataNamespace === binding.metadataNamespace &&
    active.deployment === binding.deployment &&
    active.version === binding.version
  );
}

/** The owner transaction fences claims and database work before reading durable
 * state. Conversion validates inputs but never rewrites original call envelopes.
 * Previously attempted work must drain on its retained release: a new mapping
 * cannot prove that an external effect or old-format receipt is replay-compatible. */
export async function withProcedureUpgrade<T>(
  client: pg.Client,
  options: ProcedureUpgradeOptions,
  activate: () => Promise<T>,
): Promise<T> {
  const namespace = v.parse(v.pipe(databaseIdentifier, v.regex(/^loom_/)), options.metadataNamespace);
  const version = v.parse(hash, options.version);
  const deployment = v.parse(v.pipe(v.string(), v.minLength(1), v.maxLength(256)), options.deployment);
  const protocol = v.parse(v.picklist(["loom-legacy-1", "loom-orpc-2"]), options.protocol);
  const dryRun = options.dryRun === true;
  const meta = quoteIdentifier(namespace);
  const mappings = compileJobMigrations({
    version,
    internal: options.procedures.filter((entry) => entry.visibility === "internal"),
    migrations: options.migrations,
  });
  await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
  try {
    await client.query(`LOCK TABLE ${meta}.deployment_activations IN ACCESS EXCLUSIVE MODE NOWAIT`);
    await client.query(`LOCK TABLE ${meta}.jobs IN SHARE ROW EXCLUSIVE MODE NOWAIT`);
    const manifest = JSON.stringify(mappings.declarations);
    const saved = await client.query<{ protocol: string; matches: boolean }>(
      `SELECT protocol,migrations=$3::jsonb AS matches FROM ${meta}.procedure_releases WHERE deployment=$1 AND version=$2`,
      [deployment, version, manifest],
    );
    if (saved.rows[0] && (saved.rows[0].protocol !== protocol || !saved.rows[0].matches))
      throw new Error("Procedure release declaration changed");
    const jobs = await client.query<{
      id: string;
      call: JsonValue;
      version: string | null;
      claim_version: string | null;
      state: string;
      attempts: number;
      receipt: boolean;
      replayed: boolean;
    }>(
      `SELECT j.id,j.call,j.call->>'version' AS version,j.claim_version,j.state,j.attempts,
      EXISTS (SELECT 1 FROM ${meta}.mutation_results r WHERE r.key_hash=encode(sha256(convert_to(j.id::text,'UTF8')),'hex')) AS receipt,
      EXISTS (SELECT 1 FROM ${meta}.job_replays r WHERE r.job_id=j.id) AS replayed
      FROM ${meta}.jobs j WHERE j.deployment=$1 AND j.state IN ('pending','running')
      ORDER BY j.id LIMIT 10001`,
      [deployment],
    );
    if (jobs.rows.length > 10000)
      throw new Error("Upgrade inventory exceeds 10000 jobs; drain retained work before activation");
    const blockers: ProcedureUpgradeBlocker[] = [];
    const transfers: string[] = [];
    for (const job of jobs.rows) {
      const observedVersion = v.is(hash, job.version) ? job.version : null;
      const assigned = job.claim_version ?? job.version;
      if (assigned === version) {
        if (protocol === "loom-orpc-2") {
          try {
            await mappings.resolve(job.call);
          } catch {
            blockers.push({ id: job.id, version: observedVersion, reason: "missing-mapping" });
          }
        } else if (job.claim_version !== null || !isLegacyJobCall(job.call)) {
          blockers.push({ id: job.id, version: observedVersion, reason: "rollback-incompatible" });
        }
        continue;
      }
      let reason: ProcedureUpgradeBlocker["reason"] | undefined;
      if (protocol !== "loom-orpc-2") {
        // Retained legacy workers continue their own envelopes. A transferred or
        // native envelope cannot be handed back to an old runtime by rollback.
        if (job.claim_version === null && isLegacyJobCall(job.call)) continue;
        reason = "rollback-incompatible";
      } else if (job.receipt) reason = "replay-receipt";
      else if (job.attempts > 0 || job.state === "running" || job.replayed) reason = "drain-required";
      else if (!job.version || !v.is(hash, job.version)) reason = "unknown-envelope";
      else {
        try {
          await mappings.resolve(job.call);
        } catch {
          reason = "missing-mapping";
        }
      }
      if (reason) blockers.push({ id: job.id, version: observedVersion, reason });
      else transfers.push(job.id);
    }
    if (blockers.length) throw new ProcedureUpgradeError(Object.freeze(blockers));
    if (dryRun) {
      const result = await activate();
      await client.query("ROLLBACK");
      return result;
    }
    if (transfers.length)
      await client.query(
        `UPDATE ${meta}.jobs
      SET claim_version=$1, fencing_token=fencing_token+1
      WHERE deployment=$2 AND id=ANY($3::uuid[])`,
        [version, deployment, transfers],
      );
    await client.query(
      `INSERT INTO ${meta}.procedure_releases(deployment,version,protocol,migrations)
      VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING`,
      [deployment, version, protocol, manifest],
    );
    upgrades.set(client, { metadataNamespace: namespace, deployment, version });
    let result: T;
    try {
      result = await activate();
    } finally {
      upgrades.delete(client);
    }
    // Ingress handoff stops new calls; explicit retirement owns old authority.
    // Keeping retained grants supports legacy draining and rollback. Transferred
    // jobs are fenced separately by claim_version and the database claim trigger.
    await client.query("COMMIT");
    return result;
  } catch (cause) {
    await client.query("ROLLBACK").catch(() => {});
    throw cause;
  }
}
