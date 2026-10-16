import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as v from "valibot";
import type { InvocationIdentity } from "../auth/context";
import { lockRuntimeActivation } from "../activation";
import { rpcJobCall } from "../jobs/rpc-contracts";
import { validateIdempotencyOptions } from "../idempotency";
import {
  storageIntentValidator,
  storageUploadValidator,
  storageOwnerValidator,
  StorageVerificationError,
  StorageIntentError,
} from "./contracts";
import type { ObjectStorageBackend, StorageUpload } from "./contracts";

export interface StorageAuthorization {
  readonly identity: InvocationIdentity;
  readonly operation: "upload" | "read";
  readonly upload: StorageUpload;
  readonly signal: AbortSignal;
}
export interface StorageIntentsOptions {
  readonly db: NodePgDatabase;
  readonly metadataNamespace: string;
  readonly deployment: string;
  readonly projectId: string;
  readonly branchId: string;
  /** Stable root schema namespace. Direct low-level callers default to their metadata namespace. */
  readonly applicationNamespace?: string;
  /** Stable application-relative component path; empty for the application root. */
  readonly ownerScope?: string;
  readonly buckets: readonly string[];
  readonly storage: ObjectStorageBackend;
  /** Use the supplied database for activation reads while an intent transaction owns a connection. */
  readonly assertActive: (signal: AbortSignal, db?: NodePgDatabase) => Promise<void>;
  /** Required application policy, in addition to owner and tenant isolation. Throw to deny. */
  readonly authorize: (context: StorageAuthorization) => void | Promise<void>;
}
const identifier = v.pipe(v.string(), v.minLength(1), v.maxLength(1024));
const uuid = storageIntentValidator.entries.id;
const rowValidator = v.object({
  id: uuid,
  upload: storageUploadValidator,
  state: v.picklist(["pending", "ready", "failed"]),
  error_code: v.nullable(v.picklist(["VERIFICATION_FAILED", "EXPIRED"])),
  fingerprint: v.string(),
  branch_id: v.string(),
  remaining: v.number(),
});
function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Trusted server capability: identity must come from the request verifier, never request arguments. */
export function createStorageIntents(options: StorageIntentsOptions) {
  validateIdempotencyOptions(options);
  const { db, deployment, storage, assertActive, authorize, metadataNamespace } = options;
  const projectId = v.parse(identifier, options.projectId);
  const branchId = v.parse(identifier, options.branchId);
  const componentPath = v.parse(v.union([v.literal(""), rpcJobCall.entries.scope.wrapped]), options.ownerScope ?? "");
  const applicationNamespace = v.parse(identifier, options.applicationNamespace ?? metadataNamespace);
  const ownerScope = JSON.stringify([applicationNamespace, componentPath]);
  if (storage.target.projectId !== projectId || storage.target.branchId !== branchId)
    throw new Error("Storage provider target mismatch");
  const buckets = new Set(v.parse(v.array(storageUploadValidator.entries.bucket), [...options.buckets]));
  const table = sql`${sql.identifier(options.metadataNamespace)}.${sql.identifier("storage_intents")}`;
  const scope = sql`deployment = ${deployment} AND project_id = ${projectId} AND branch_id = ${branchId}
    AND (owner_scope = ${ownerScope} OR owner_scope IS NULL)`;
  const readScope = sql`project_id = ${projectId} AND ((owner_scope = ${ownerScope} AND state = 'ready')
    OR (${scope}))`;
  const columns = sql`id, upload, state, error_code, fingerprint, branch_id,
    floor(extract(epoch FROM upload_expires_at - clock_timestamp()))::float8 AS remaining`;
  function principal(input: InvocationIdentity) {
    const identity = Object.freeze(v.parse(storageOwnerValidator, input));
    return { identity, hash: digest(JSON.stringify([identity.issuer, identity.subject, identity.tenantId ?? null])) };
  }
  async function active(signal: AbortSignal, database = db) {
    signal.throwIfAborted();
    await assertActive(signal, database);
    signal.throwIfAborted();
  }
  async function transaction<Result>(
    signal: AbortSignal,
    operation: (database: NodePgDatabase) => Promise<Result>,
  ): Promise<Result> {
    return db.transaction(
      async (tx) => {
        await lockRuntimeActivation(tx, metadataNamespace);
        await active(signal, tx);
        return operation(tx);
      },
      { isolationLevel: "read committed" },
    );
  }
  async function permit(
    owner: ReturnType<typeof principal>,
    upload: StorageUpload,
    operation: "upload" | "read",
    signal: AbortSignal,
    database = db,
  ) {
    if (!buckets.has(upload.bucket)) throw new StorageIntentError("FORBIDDEN");
    try {
      await authorize(
        Object.freeze({ identity: owner.identity, operation, upload: Object.freeze({ ...upload }), signal }),
      );
    } catch {
      signal.throwIfAborted();
      throw new StorageIntentError("FORBIDDEN");
    }
    await active(signal, database);
  }
  function view(row: v.InferOutput<typeof rowValidator>) {
    return Object.freeze({ id: row.id, state: row.state, errorCode: row.error_code });
  }
  async function load(
    owner: ReturnType<typeof principal>,
    id: string,
    database = db,
    operation: "upload" | "read" = "upload",
  ) {
    const result = await database.execute(
      sql`SELECT ${columns} FROM ${table} WHERE ${operation === "read" ? readScope : scope} AND owner_hash = ${owner.hash} AND id = ${id}::uuid`,
    );
    const parsed = v.safeParse(rowValidator, result.rows[0]);
    if (!parsed.success) throw new StorageIntentError("FORBIDDEN");
    return parsed.output;
  }
  async function access(
    owner: ReturnType<typeof principal>,
    id: string,
    operation: "upload" | "read",
    signal: AbortSignal,
    database = db,
  ) {
    await active(signal, database);
    const row = await load(owner, id, database, operation);
    await permit(owner, row.upload, operation, signal, database);
    return row;
  }
  return Object.freeze({
    async create(
      identity: InvocationIdentity,
      input: StorageUpload,
      requestKey: string,
      signal: AbortSignal = new AbortController().signal,
    ) {
      const owner = principal(identity);
      const upload = v.parse(storageUploadValidator, input);
      const key = v.parse(v.pipe(v.string(), v.regex(/^[a-zA-Z0-9_-]{1,128}$/)), requestKey);
      const fingerprint = digest(JSON.stringify(upload));
      const requestHash = digest(key);
      await active(signal);
      await permit(owner, upload, "upload", signal);
      return transaction(signal, async (tx) => {
        await tx.execute(sql`INSERT INTO ${table} (deployment, project_id, branch_id, owner_scope, owner_hash, owner_identity, request_hash, fingerprint, upload)
        VALUES (${deployment}, ${projectId}, ${branchId}, ${ownerScope}, ${owner.hash}, ${JSON.stringify(owner.identity)}::jsonb, ${requestHash}, ${fingerprint}, ${JSON.stringify(upload)}::jsonb)
        ON CONFLICT (deployment, project_id, branch_id, owner_hash, request_hash) DO NOTHING`);
        // Separate read observes the winner after a concurrent INSERT conflict wait.
        const result = await tx.execute(
          sql`SELECT ${columns} FROM ${table} WHERE ${scope} AND owner_hash = ${owner.hash} AND request_hash = ${requestHash}`,
        );
        const row = v.parse(rowValidator, result.rows[0]);
        if (row.fingerprint !== fingerprint) throw new StorageIntentError("IDEMPOTENCY_CONFLICT");
        return view(row);
      });
    },
    async status(identity: InvocationIdentity, input: string, signal: AbortSignal = new AbortController().signal) {
      const owner = principal(identity);
      const id = v.parse(uuid, input);
      return transaction(signal, async (tx) => view(await access(owner, id, "read", signal, tx)));
    },
    async signUpload(identity: InvocationIdentity, input: string, signal: AbortSignal = new AbortController().signal) {
      const owner = principal(identity);
      const id = v.parse(uuid, input);
      return transaction(signal, async (tx) => {
        await access(owner, id, "upload", signal, tx);
        const row = await load(owner, id, tx);
        if (row.state !== "pending" || row.remaining < 1) throw new StorageIntentError("STORAGE_UNAVAILABLE");
        signal.throwIfAborted();
        return storage.signUpload({ id, ...row.upload }, Math.min(300, row.remaining));
      });
    },
    async finalize(identity: InvocationIdentity, input: string, signal: AbortSignal = new AbortController().signal) {
      const owner = principal(identity);
      const id = v.parse(uuid, input);
      const completed = await transaction(signal, async (tx) => {
        await access(owner, id, "upload", signal, tx);
        // Cleanup takes this same row lock before deleting any object for the intent.
        const result = await tx.execute(sql`SELECT ${columns} FROM ${table}
          WHERE ${scope} AND owner_hash = ${owner.hash} AND id = ${id}::uuid FOR UPDATE`);
        const row = v.parse(rowValidator, result.rows[0]);
        await active(signal, tx);
        if (row.state === "ready") return view(row);
        if (row.state !== "pending") throw new StorageIntentError("STORAGE_UNAVAILABLE");
        try {
          await storage.sealUpload({ id, ...row.upload }, signal);
        } catch (cause) {
          if (!(cause instanceof StorageVerificationError)) throw cause;
          await active(signal, tx);
          await tx.execute(sql`UPDATE ${table} SET state = 'failed', error_code = 'VERIFICATION_FAILED', updated_at = clock_timestamp()
            WHERE ${scope} AND id = ${id}::uuid`);
          // Commit the failed state before propagating the verification error.
          return cause;
        }
        await active(signal, tx);
        const updated =
          await tx.execute(sql`UPDATE ${table} SET state = 'ready', error_code = NULL, updated_at = clock_timestamp()
          WHERE ${scope} AND id = ${id}::uuid RETURNING ${columns}`);
        return view(v.parse(rowValidator, updated.rows[0]));
      });
      if (completed instanceof StorageVerificationError) throw completed;
      return completed;
    },
    async signDownload(
      identity: InvocationIdentity,
      input: string,
      signal: AbortSignal = new AbortController().signal,
    ) {
      const owner = principal(identity);
      const id = v.parse(uuid, input);
      return transaction(signal, async (tx) => {
        const row = await access(owner, id, "read", signal, tx);
        if (row.state !== "ready") throw new StorageIntentError("STORAGE_UNAVAILABLE");
        return storage.signDownload({ id, ...row.upload }, 60, signal, { branchId: row.branch_id });
      });
    },
  });
}
