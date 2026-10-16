// Research sketch: the smallest server-side wrapper Loom could publish.
// DB-free. Nothing here talks to Neon; `seal()` is local encryption only.
import { createRealtime, rawSql } from "@neon/realtime/server";
import type { RawSqlParameter, RawSqlQuery, RealtimeServer, SealedLiveQuery } from "@neon/realtime/server";

/** Mirrors `InvocationIdentity` in apps/loom/src/core/server/auth/context.ts. */
export interface Identity {
  readonly issuer: string;
  readonly subject: string;
  readonly tenantId?: string;
}

/** A named, server-defined live read. The SQL never comes from the client. */
export interface LiveQueryDefinition<Input, Row> {
  readonly name: string;
  /** Must embed authorization (membership joins, tenant filters) in the SQL. */
  readonly sql: (identity: Identity, input: Input) => RawSqlQuery<Row>;
}

export function defineLiveQuery<Input, Row>(definition: LiveQueryDefinition<Input, Row>) {
  return definition;
}

export interface LiveQueryIssuerOptions {
  /** NEON_REALTIME_SECRET; server-only. */
  readonly secret: string;
  readonly db: string;
}

/** Wraps `RealtimeServer<RawSqlQuery<unknown>>` so callers never touch SQL or the secret. */
export function createLiveQueryIssuer(options: LiveQueryIssuerOptions) {
  const realtime: RealtimeServer<RawSqlQuery<unknown>> = createRealtime({ secret: options.secret, db: options.db });
  return {
    async seal<Input, Row>(
      definition: LiveQueryDefinition<Input, Row>,
      identity: Identity | null,
      input: Input,
    ): Promise<SealedLiveQuery<Row>> {
      if (!identity) throw new Error("UNAUTHORIZED");
      return realtime.seal({ query: definition.sql(identity, input) });
    },
  };
}

/** Mutation result shape proposed for Loom procedures that want confirmation. */
export type MutationReceipt<Result> =
  | { readonly kind: "committed"; readonly txid: string; readonly result: Result }
  | { readonly kind: "unchanged"; readonly result: Result };

/** Minimal executor shape of a Drizzle transaction handle used to read the txid. */
export interface TxidReader {
  execute(sql: string): Promise<{ readonly rows: readonly { readonly txid: string }[] }>;
}

/** Run inside the same write transaction; return the value only after commit. */
export async function currentTxid(tx: TxidReader): Promise<string> {
  const { rows } = await tx.execute("SELECT pg_current_xact_id()::text AS txid");
  const txid = rows[0]?.txid;
  if (!txid) throw new Error("pg_current_xact_id returned no row");
  return txid;
}

// --- example definition -------------------------------------------------------

export interface MessageRow {
  readonly id: string;
  readonly channel_id: string;
  readonly body: string;
  readonly created_at: string;
}

export const channelMessages = defineLiveQuery<{ channelId: string; limit: number }, MessageRow>({
  name: "channelMessages",
  sql: (identity, { channelId, limit }) => {
    const parameters: readonly RawSqlParameter[] = [identity.subject, channelId, limit];
    return rawSql<MessageRow>(
      `SELECT m.id, m.channel_id, m.body, m.created_at::text AS created_at
       FROM messages m
       INNER JOIN channel_members cm ON cm.channel_id = m.channel_id
       WHERE cm.user_id = $1 AND m.channel_id = $2
       ORDER BY m.created_at DESC
       LIMIT $3`,
      parameters,
    );
  },
});
