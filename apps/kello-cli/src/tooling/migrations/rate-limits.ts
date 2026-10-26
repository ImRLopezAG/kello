import { Buffer } from "node:buffer";
import { setTimeout } from "node:timers/promises";
import type pg from "pg";
import * as v from "valibot";
import { defineRateLimits, isRateLimitDefinitions, rateLimitPolicyFingerprint } from "kello/internal/tooling";
import type { RateLimitDefinitions } from "kello/server";
import { componentNamespace } from "../project/component-namespace";
import { quoteIdentifier } from "./connection";

export { cleanupRateLimits } from "./rate-limits-cleanup";
export type { CleanupRateLimitsOptions, RateLimitCleanupResult } from "./rate-limits-cleanup";

interface RegistrationInput {
  readonly metadataNamespace: string;
  readonly applicationNamespace: string;
  readonly scopes: readonly { readonly mountPath: string; readonly definitions: RateLimitDefinitions }[];
  readonly signal?: AbortSignal;
}

function dimension(value: string, allowEmpty = false): boolean {
  return v.is(
    v.pipe(
      v.string(),
      v.check(
        (text) =>
          (allowEmpty || text.length > 0) &&
          !text.includes("\0") &&
          !/[\uD800-\uDFFF]/u.test(text) &&
          Buffer.byteLength(text, "utf8") <= 256,
      ),
    ),
    value,
  );
}

/**
 * Requires exclusive use of a connected, idle client with no queued work. Owns
 * one short transaction; never commits or rolls back an existing transaction.
 * Caller-held migration session locks on this same client are reentrant. All
 * locks acquired here are transaction-scoped, including on standalone pools.
 * Cancellation is checked around each bounded query and during lock polling.
 */
export async function registerRateLimitPolicies(
  client: pg.PoolClient | pg.Client,
  input: RegistrationInput,
): Promise<void> {
  // Capture and validate the entire input before BEGIN or any registry writes.
  let schema: string;
  let scopes: { mountPath: string; definitions: RateLimitDefinitions }[];
  let namespaces: string[];
  const applicationNamespace = input.applicationNamespace;
  try {
    if (!dimension(input.metadataNamespace) || !dimension(applicationNamespace) || !Array.isArray(input.scopes))
      throw new Error();
    schema = quoteIdentifier(input.metadataNamespace);
    const paths = new Set<string>();
    scopes = input.scopes.map(({ mountPath, definitions }) => {
      if (!dimension(mountPath, true) || paths.has(mountPath) || !isRateLimitDefinitions(definitions))
        throw new Error();
      paths.add(mountPath);
      if (mountPath !== "") componentNamespace(mountPath);
      return { mountPath, definitions: defineRateLimits(definitions.policies) };
    });
    namespaces = [
      ...new Set([
        applicationNamespace,
        ...scopes.filter((scope) => scope.mountPath !== "").map((scope) => componentNamespace(scope.mountPath)),
      ]),
    ].sort();
  } catch {
    throw new Error("Invalid rate limit registration input");
  }
  if (client.getTransactionStatus() !== "I") throw new Error("Rate limit registration requires an idle connection");
  const signal = input.signal;
  signal?.throwIfAborted();
  await client.query("BEGIN");
  try {
    // PostgreSQL renders timeout settings with units; interval conversion keeps
    // stricter caller settings and treats zero as unlimited. SET LOCAL restores
    // those settings on both commit and rollback.
    await client.query(`SELECT set_config(setting, LEAST(
      COALESCE(NULLIF(extract(epoch FROM current_setting(setting)::interval)*1000,0),5000),5000
      )::text || 'ms', true)
      FROM unnest(ARRAY['lock_timeout','statement_timeout']) AS setting`);
    const deadline = performance.now() + 5000;
    for (const key of ["loom:component-ownership", ...namespaces.map((namespace) => `loom:migrations:${namespace}`)]) {
      for (;;) {
        signal?.throwIfAborted();
        if (performance.now() >= deadline) throw new Error("Timed out waiting for the migration lock");
        const result = await client.query<{ acquired: boolean }>(
          "SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired",
          [key],
        );
        signal?.throwIfAborted();
        if (result.rows[0]?.acquired) break;
        await setTimeout(
          Math.min(25, Math.max(1, deadline - performance.now())),
          undefined,
          signal ? { signal } : undefined,
        );
      }
    }
    for (const { mountPath, definitions } of scopes) {
      for (const [name, policy] of Object.entries(definitions.policies)) {
        signal?.throwIfAborted();
        const fingerprint = rateLimitPolicyFingerprint(policy);
        const identity = [applicationNamespace, mountPath, name, policy.version];
        await client.query(
          `INSERT INTO ${schema}.rate_limit_policies
          (application_namespace,mount_path,policy_name,version,mode,scope,limit_count,window_ms,fingerprint)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
          ON CONFLICT (application_namespace,mount_path,policy_name,version) DO NOTHING`,
          [...identity, policy.mode, policy.scope, policy.limit, policy.windowMs, fingerprint],
        );
        signal?.throwIfAborted();
        const existing = await client.query<{
          fingerprint: string;
          mode: string;
          scope: string;
          limit_count: number;
          window_ms: number;
        }>(
          `SELECT fingerprint,mode,scope,limit_count,window_ms FROM ${schema}.rate_limit_policies
          WHERE application_namespace=$1 AND mount_path=$2 AND policy_name=$3 AND version=$4`,
          identity,
        );
        const row = existing.rows[0];
        if (
          !row ||
          row.fingerprint !== fingerprint ||
          row.mode !== policy.mode ||
          row.scope !== policy.scope ||
          row.limit_count !== policy.limit ||
          row.window_ms !== policy.windowMs
        )
          throw new Error("Rate limit policy configuration conflict");
      }
    }
    signal?.throwIfAborted();
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
