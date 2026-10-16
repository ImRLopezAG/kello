import { createHash, randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as v from "valibot";
import { originPolicy } from "./policy";
import { AuthenticationError } from "./verify";
import type { VerifiedSession } from "./verify";

export interface ConnectionTicketOptions {
  readonly db: NodePgDatabase;
  readonly metadataNamespace: string;
  readonly deployment: string;
  readonly namespace: string;
  readonly version: string;
  /** Recheck authority inside the redemption transaction after acquiring the migration barrier. */
  readonly assertActive?: (database: NodePgDatabase) => Promise<void>;
  /** Defaults to 30 seconds; maximum 60 seconds. */
  readonly lifetimeSeconds?: number;
}
export interface ConnectionTicket {
  readonly ticket: string;
  /** Unix seconds; never later than the verified session's expiration. */
  readonly expiresAt: number;
}
const identifier = v.pipe(v.string(), v.minLength(1), v.maxLength(1024));
const sessionSchema = v.object({
  identity: v.object({
    issuer: identifier,
    subject: identifier,
    tenantId: v.exactOptional(identifier),
  }),
  expiresAt: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
});
function digest(ticket: string): string {
  return createHash("sha256").update(ticket).digest("hex");
}

/** Trusted server capability. Call issue only after authentication and an origin-policy check. */
export function createConnectionTickets(options: ConnectionTicketOptions) {
  const { db, deployment, metadataNamespace, namespace, version, assertActive } = options;
  const lifetime = options.lifetimeSeconds ?? 30;
  if (!deployment || deployment.length > 256) throw new Error("Invalid deployment identity");
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(namespace) || !/^[a-f0-9]{64}$/.test(version))
    throw new Error("Invalid ticket runtime identity");
  if (!/^loom_[a-zA-Z0-9_]{1,58}$/.test(metadataNamespace)) throw new Error("Invalid ticket metadata namespace");
  if (!Number.isInteger(lifetime) || lifetime < 1 || lifetime > 60) throw new Error("Invalid ticket lifetime");
  const table = sql`${sql.identifier(metadataNamespace)}.${sql.identifier("connection_tickets")}`;
  const sessions = sql`${sql.identifier(metadataNamespace)}.${sql.identifier("client_sessions")}`;
  return {
    async issue(session: VerifiedSession, origin: string): Promise<ConnectionTicket> {
      originPolicy([origin]);
      const captured = v.parse(sessionSchema, session);
      const ticket = randomBytes(32).toString("base64url");
      const result = await db.execute<{ expiresAt: number }>(sql`
        INSERT INTO ${table} (deployment, namespace, version, ticket_hash, origin, identity, session_expires_at, expires_at)
        SELECT ${deployment}, ${namespace}, ${version}, ${digest(ticket)}, ${origin}, ${JSON.stringify(captured.identity)}::jsonb,
          to_timestamp(${captured.expiresAt}),
          LEAST(to_timestamp(${captured.expiresAt}), clock_timestamp() + ${lifetime} * interval '1 second')
        WHERE to_timestamp(${captured.expiresAt}) > clock_timestamp()
        RETURNING extract(epoch FROM expires_at)::float8 AS "expiresAt"
      `);
      const saved = result.rows[0];
      if (!saved) throw new AuthenticationError();
      return { ticket, expiresAt: saved.expiresAt };
    },
    async redeem(ticket: string, origin: string): Promise<VerifiedSession> {
      if (!/^[A-Za-z0-9_-]{43}$/.test(ticket)) throw new AuthenticationError();
      const result = await db.transaction(
        async (transaction) => {
          const lock = await transaction.execute<{ acquired: boolean }>(sql`
          SELECT pg_try_advisory_xact_lock_shared(hashtextextended(${`loom:migrations:${namespace}`},0)) AS acquired`);
          if (lock.rows[0]?.acquired !== true) throw new AuthenticationError();
          await assertActive?.(transaction);
          return transaction.execute(sql`
        WITH consumed AS (
          DELETE FROM ${table}
          WHERE deployment = ${deployment} AND ticket_hash = ${digest(ticket)} AND origin = ${origin}
            AND namespace = ${namespace} AND version = ${version}
            AND expires_at > clock_timestamp() AND session_expires_at > clock_timestamp()
          RETURNING ticket_hash, identity, expires_at, session_expires_at
        ), tracked AS (
          INSERT INTO ${sessions}(namespace,deployment,version,ticket_hash,expires_at)
          SELECT ${namespace},${deployment},${version},ticket_hash,session_expires_at FROM consumed
          WHERE expires_at > clock_timestamp() AND session_expires_at > clock_timestamp()
          RETURNING ticket_hash
        )
        SELECT identity, extract(epoch FROM session_expires_at)::float8 AS "expiresAt" FROM consumed JOIN tracked USING(ticket_hash)
        WHERE expires_at > clock_timestamp() AND session_expires_at > clock_timestamp()
      `);
        },
        { isolationLevel: "read committed" },
      );
      const parsed = v.safeParse(sessionSchema, result.rows[0]);
      if (!parsed.success) throw new AuthenticationError();
      return Object.freeze({ identity: Object.freeze(parsed.output.identity), expiresAt: parsed.output.expiresAt });
    },
  };
}
