import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { JsonValue } from "../schema/fields";
import { canonical } from "../validation/canonical";

/** Expired records remain as tombstones so old retries never execute as new work. */
export const mutationReplayWindowSeconds = 86_400;
export interface IdempotencyOptions {
  readonly deployment: string;
  readonly metadataNamespace: string;
}
export class IdempotencyError extends Error {
  constructor(readonly code: "INVALID_IDEMPOTENCY_KEY" | "IDEMPOTENCY_CONFLICT" | "IDEMPOTENCY_EXPIRED") {
    super(code);
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function validateIdempotencyOptions(options: IdempotencyOptions): void {
  if (!options.deployment || options.deployment.length > 256) throw new Error("Invalid deployment identity");
  if (!/^loom_[a-zA-Z0-9_]{1,58}$/.test(options.metadataNamespace))
    throw new Error("Invalid idempotency metadata namespace");
}

/** Caller authorizes first and owns the serializable transaction, including result validation. */
export function prepareMutationReplay(
  options: IdempotencyOptions,
  scope: JsonValue,
  key: string | undefined,
  args: JsonValue,
): (db: NodePgDatabase, invoke: () => Promise<JsonValue>) => Promise<JsonValue> {
  if (!key || !/^[a-zA-Z0-9_-]{1,128}$/.test(key)) throw new IdempotencyError("INVALID_IDEMPOTENCY_KEY");
  const table = sql`${sql.identifier(options.metadataNamespace)}.${sql.identifier("mutation_results")}`;
  const scopeHash = digest(canonical([options.deployment, scope]));
  const keyHash = digest(key);
  const fingerprint = digest(canonical(args));
  return async (db, invoke) => {
    const saved = await db.execute<{ fingerprint: string; result: JsonValue; expired: boolean }>(sql`
      SELECT fingerprint, result, expires_at <= clock_timestamp() AS expired
      FROM ${table} WHERE scope_hash = ${scopeHash} AND key_hash = ${keyHash}
    `);
    const previous = saved.rows[0];
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new IdempotencyError("IDEMPOTENCY_CONFLICT");
      if (previous.expired) throw new IdempotencyError("IDEMPOTENCY_EXPIRED");
      return previous.result;
    }
    const value = await invoke();
    const inserted = await db.execute(sql`
      INSERT INTO ${table} (scope_hash, key_hash, fingerprint, result, expires_at)
      VALUES (${scopeHash}, ${keyHash}, ${fingerprint}, ${JSON.stringify(value)}::jsonb,
        clock_timestamp() + ${mutationReplayWindowSeconds} * interval '1 second')
      ON CONFLICT (scope_hash, key_hash) DO NOTHING RETURNING scope_hash
    `);
    // A competing commit requires a fresh snapshot and authorization, never a second domain commit.
    if (!inserted.rows.length) throw Object.assign(new Error("Concurrent mutation replay"), { code: "40001" });
    return value;
  };
}
