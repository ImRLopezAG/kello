import { createHmac } from "node:crypto";
import { createRealtime } from "@neon/realtime/server";
import { drizzleAdapter } from "@neon/realtime-drizzle";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { AnyRelations } from "drizzle-orm";
import { sql, SQL, is, noopDecoder } from "drizzle-orm";
import { PgText, PgUUID, PgVarchar, PgBoolean, PgInteger, PgDoublePrecision, PgReal } from "drizzle-orm/pg-core";
import type { InvocationIdentity } from "../auth/context";
import type { DatabaseConnection } from "../database/connection";
import { validateIdempotencyOptions } from "../idempotency";
import { runFunctionTransaction } from "../transactions";
import { prepareRpcReplay } from "../rpc/replay";
import type { RpcValue } from "../rpc/serialization";
import { rpcValue, serializeRpcValue } from "../rpc/serialization";
import * as v from "valibot";
import type { IssuedNeonQuery, NeonMutationResult, NeonScope } from "../../client/realtime";

/** Server-authenticated context. sessionId must come from the verified session,
 * never procedure input. A new login must have a different sessionId. */
export interface NeonAuthority {
  readonly identity: InvocationIdentity | null;
  readonly sessionId: string;
  /** Verified session expiry, Unix seconds. Not supplied by procedure input. */
  readonly expiresAt: number;
  readonly signal: AbortSignal;
}
type Authorized = NeonAuthority & { readonly identity: InvocationIdentity };
interface SelectQuery {
  readonly _: { readonly result: readonly unknown[] };
  toSQL(): { readonly sql: string; readonly params: readonly unknown[] };
}
type Row<Query extends SelectQuery> = Query["_"]["result"][number];
export interface NeonLiveQuery<Input, Result> {
  readonly name: string;
  readonly input: StandardSchemaV1<unknown, Input>;
  /** Runtime projection is required: SDK decoding does not run Drizzle mappers. */
  readonly rows: StandardSchemaV1<unknown, readonly Result[]>;
  readonly authorize: (authority: Authorized, input: Input) => void | Promise<void>;
  /** Authorization, including live membership, must also be expressed in SQL. */
  readonly query: (
    authority: Authorized,
    input: Input,
  ) => SelectQuery & { readonly _: { readonly result: readonly Result[] } };
}
export function createNeonLiveQuery<Input, Query extends SelectQuery>(definition: {
  readonly name: string;
  readonly input: StandardSchemaV1<unknown, Input>;
  readonly rows: StandardSchemaV1<unknown, readonly NoInfer<Row<Query>>[]>;
  readonly authorize: (authority: Authorized, input: Input) => void | Promise<void>;
  readonly query: (authority: Authorized, input: Input) => Query;
}): NeonLiveQuery<Input, Row<Query>> {
  if (!/^[a-zA-Z][\w.-]{0,127}$/.test(definition.name)) throw new Error("Invalid live query name");
  return Object.freeze({ ...definition });
}
async function parse<Input, Output>(schema: StandardSchemaV1<Input, Output>, input: Input): Promise<Output> {
  const result = await schema["~standard"].validate(input);
  if (result.issues) throw new Error("Invalid realtime input or output");
  return result.value;
}
function authorized(authority: NeonAuthority): Authorized {
  authority.signal.throwIfAborted();
  if (
    !authority.identity ||
    !authority.sessionId ||
    authority.sessionId.length > 512 ||
    !Number.isSafeInteger(authority.expiresAt) ||
    authority.expiresAt * 1000 <= Date.now()
  )
    throw new Error("UNAUTHORIZED");
  return { ...authority, identity: Object.freeze({ ...authority.identity }) };
}
interface Target {
  readonly secret: string;
  readonly database: string;
  readonly deployment: string;
}
function targetScope(options: Target): NeonScope {
  if (!options.database || !options.deployment || options.database.length > 256 || options.deployment.length > 256)
    throw new Error("Invalid realtime target");
  return Object.freeze({ database: options.database, deployment: options.deployment });
}
function authorization(options: Target, authority: Authorized): string {
  return createHmac("sha256", options.secret)
    .update(
      JSON.stringify([
        "kello.neon.session.v1",
        options.deployment,
        options.database,
        authority.identity.issuer,
        authority.identity.subject,
        authority.identity.tenantId ?? null,
        authority.sessionId,
      ]),
    )
    .digest("hex");
}
/** Conservative first slice: built-in scalar columns or explicitly aliased SQL
 * with no client mapper. Runtime row validation is still required by the client. */
function assertProjection(query: SelectQuery): void {
  if (!v.is(v.object({ getSelectedFields: v.function() }), query))
    throw new Error("A concrete Drizzle SELECT is required");
  const fields = v.parse(v.record(v.string(), v.unknown()), query.getSelectedFields());
  for (const [name, field] of Object.entries(fields)) {
    if (is(field, SQL.Aliased)) {
      if (field.fieldAlias !== name) throw new Error("Live SQL aliases must match their output keys");
      if (!("decoder" in field.sql) || field.sql.decoder !== noopDecoder)
        throw new Error("Drizzle mapWith is not supported");
    } else if (
      !(
        is(field, PgText) ||
        is(field, PgUUID) ||
        is(field, PgVarchar) ||
        is(field, PgBoolean) ||
        is(field, PgInteger) ||
        is(field, PgDoublePrecision) ||
        is(field, PgReal)
      )
    ) {
      throw new Error("Unsupported live projection; use an explicitly validated SQL alias");
    } else if (field.name !== name) {
      throw new Error("Live column names must match their output keys; use an explicit SQL alias");
    }
  }
}

/** Allowlisted, typed issuance. SQL, target, and identity are server-owned. */
export function createNeonQueryIssuer(options: Target & { readonly queries: readonly { readonly name: string }[] }) {
  const scope = targetScope(options);
  const realtime = createRealtime({ secret: options.secret, db: options.database, adapter: drizzleAdapter() });
  const queries = new Set(options.queries);
  if (new Set(options.queries.map((query) => query.name)).size !== queries.size)
    throw new Error("Duplicate live query name");
  return {
    async issue<Input, Result>(
      definition: NeonLiveQuery<Input, Result>,
      input: Input,
      context: NeonAuthority,
    ): Promise<IssuedNeonQuery<Result>> {
      if (!queries.has(definition)) throw new Error("Unknown live query");
      const identity = authorized(context);
      const parsed = await parse(definition.input, input);
      await definition.authorize(identity, parsed);
      identity.signal.throwIfAborted();
      const selected = definition.query(identity, parsed);
      assertProjection(selected);
      const query = await realtime.seal({ query: selected });
      identity.signal.throwIfAborted();
      // SDK 0.1.0 seals a fixed 60-second capability. Metadata cannot shorten
      // its signed expiry: refuse issuance if the verified session ends first.
      authorized(identity);
      if (query.expiresAt > identity.expiresAt * 1000) throw new Error("Session expires before realtime capability");
      return {
        version: 1,
        scope,
        authorization: authorization(options, identity),
        sessionExpiresAt: identity.expiresAt * 1000,
        query,
      };
    },
  };
}

/** Opt-in transaction+replay path. Ordinary RPC mutation behavior is unchanged.
 * Invoke from a normal authorized RPC handler, not from an existing transaction.
 * The versioned operation identity separates legacy replay records. */
export async function runNeonMutation<Relations extends AnyRelations, Result extends RpcValue>(
  options: Target & {
    readonly connection: DatabaseConnection<Relations>;
    readonly metadataNamespace: string;
    readonly operation: string;
    readonly idempotencyKey: string;
    readonly input: RpcValue;
    readonly authority: NeonAuthority;
    readonly output: StandardSchemaV1<unknown, Result>;
    readonly authorize: (
      db: Parameters<Parameters<DatabaseConnection<Relations>["transaction"]>[0]>[0],
      authority: Authorized,
    ) => Promise<void>;
    readonly execute: (
      db: Parameters<Parameters<DatabaseConnection<Relations>["transaction"]>[0]>[0],
      authority: Authorized,
    ) => Promise<{ readonly kind: "write" | "no-write"; readonly value: Result }>;
  },
): Promise<NeonMutationResult<Result>> {
  const scope = targetScope(options);
  validateIdempotencyOptions(options);
  if (!/^[a-zA-Z][\w.-]{0,127}\.v[1-9][0-9]*$/.test(options.operation)) throw new Error("Versioned operation required");
  const verified = authorized(options.authority);
  const expiry = new AbortController();
  const identity = { ...verified, signal: AbortSignal.any([verified.signal, expiry.signal]) };
  const binding = authorization(options, identity);
  const replay = prepareRpcReplay(
    options,
    [
      "neon-receipt.v1",
      scope.database,
      options.operation,
      identity.identity.issuer,
      identity.identity.subject,
      identity.identity.tenantId ?? null,
      identity.sessionId,
    ],
    options.idempotencyKey,
    options.input,
  );
  // Replay storage is already scoped to the full trusted login identity. A
  // saved binding is an opaque historical marker, not a fresh authorization
  // token: preserve it verbatim across signing-key rotation.
  const envelopeSchema = v.strictObject({
    version: v.literal(1),
    scope: v.strictObject({ database: v.literal(scope.database), deployment: v.literal(scope.deployment) }),
    authorization: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
    transaction: v.variant("kind", [
      v.strictObject({ kind: v.literal("committed"), txid: v.pipe(v.string(), v.regex(/^[1-9][0-9]{0,19}$/)) }),
      v.strictObject({ kind: v.literal("no-write") }),
    ]),
    value: rpcValue,
  });
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  function armExpiry() {
    const remaining = identity.expiresAt * 1000 - Date.now();
    if (remaining <= 0) {
      expiry.abort(new Error("Verified session expired"));
      return;
    }
    expiryTimer = setTimeout(armExpiry, Math.min(remaining, 2_147_483_647));
  }
  armExpiry();
  try {
    return await runFunctionTransaction(
      options.connection,
      "mutation",
      async (db) => {
        authorized(identity);
        await options.authorize(db, identity);
        let fresh: { value: Result } | undefined;
        const saved = await replay(db, async () => {
          const executed = await options.execute(db, identity);
          const value = v.parse(rpcValue, executed.value);
          const decoded = await parse(options.output, value);
          if (JSON.stringify(serializeRpcValue(value)) !== JSON.stringify(serializeRpcValue(decoded)))
            throw new Error("Realtime mutation output schema must validate without transforming");
          fresh = { value: decoded };
          const transaction =
            executed.kind === "no-write"
              ? { kind: "no-write" as const }
              : {
                  kind: "committed" as const,
                  txid: (await db.execute<{ txid: string }>(sql`SELECT pg_current_xact_id()::text AS txid`)).rows[0]
                    ?.txid,
                };
          return v.parse(
            rpcValue,
            v.parse(envelopeSchema, { version: 1, scope, authorization: binding, transaction, value }),
          );
        });
        const envelope = v.parse(envelopeSchema, saved);
        // Decode inside the transaction: a bad result rolls back even a fresh replay
        // INSERT. Replayed raw output is validated/projected exactly once per call.
        const value = fresh ? fresh.value : await parse(options.output, envelope.value);
        if (JSON.stringify(serializeRpcValue(value)) !== JSON.stringify(serializeRpcValue(envelope.value)))
          throw new Error("Realtime replay output schema changed the saved result");
        authorized(identity);
        return { ...envelope, value };
      },
      { signal: identity.signal },
    );
  } finally {
    clearTimeout(expiryTimer);
  }
}
