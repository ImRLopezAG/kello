import { os, ORPCError } from "@orpc/server";
import type { TrustedLogin } from "../../../apps/kello/src/core/server/auth/login";
import type { ProcedureContext } from "../../../apps/kello/src/core/server/rpc/procedure";
import { and, eq, exists } from "drizzle-orm";
import { pgTable, text } from "drizzle-orm/pg-core";
import * as v from "valibot";
import type { AnyRelations } from "drizzle-orm";
import type { DatabaseConnection } from "../../../apps/kello/src/core/server/database/connection";
import type { VerifiedSession } from "../../../apps/kello/src/core/server/auth/verify";
import {
  createNeonLiveQuery,
  createNeonQueryIssuer,
  runNeonMutation,
} from "../../../apps/kello/src/core/server/realtime/neon";

const tasks = pgTable("neon_example_tasks", {
  id: text().primaryKey(),
  tenant: text().notNull(),
  title: text().notNull(),
});
const members = pgTable("neon_example_members", {
  issuer: text().notNull(),
  subject: text().notNull(),
  tenant: text().notNull(),
});
export const taskRows = v.array(v.strictObject({ id: v.string(), title: v.string() }));
const listInput = v.strictObject({ tenant: v.string() });
const updateInput = v.strictObject({
  tenant: v.string(),
  id: v.string(),
  title: v.pipe(v.string(), v.maxLength(200)),
  key: v.string(),
});

/** Trusted server session-store lookup after credential verification. The existing
 * JWT/ticket verifier does not establish this login-generation ID. Absence is an
 * unsupported integration, never a subject/request/client-label fallback. */
export type { TrustedLogin } from "../../../apps/kello/src/core/server/auth/login";
export function exampleAuthority(verified: VerifiedSession, login: TrustedLogin | undefined, signal: AbortSignal) {
  if (
    !login ||
    !login.id ||
    login.issuer !== verified.identity.issuer ||
    login.subject !== verified.identity.subject ||
    login.tenantId !== verified.identity.tenantId
  )
    throw new Error("Trusted login-session adapter required");
  return {
    identity: verified.identity,
    sessionId: login.id,
    expiresAt: Math.min(login.expiresAt, verified.expiresAt),
    signal,
  };
}

/** Mount these methods on ordinary authenticated RPC handlers. Native oRPC infers
 * their envelopes; this fixture injects a trusted adapter, not an end-to-end auth
 * implementation. HMAC keys remain in this server closure. */
export function createTaskRealtimeExample<Relations extends AnyRelations>(options: {
  connection: DatabaseConnection<Relations>;
  secret: string;
  database: string;
  deployment: string;
  metadataNamespace: string;
}) {
  const db = options.connection.db;
  function membership(identity: VerifiedSession["identity"], tenant: string) {
    return exists(
      db
        .select({ subject: members.subject })
        .from(members)
        .where(
          and(eq(members.issuer, identity.issuer), eq(members.subject, identity.subject), eq(members.tenant, tenant)),
        ),
    );
  }
  const declaration = createNeonLiveQuery({
    name: "example.tasks.v1",
    input: listInput,
    rows: taskRows,
    authorize: async ({ identity }, input) => {
      if (identity.tenantId !== input.tenant) throw new Error("Forbidden");
      const allowed = await db
        .select({ subject: members.subject })
        .from(members)
        .where(
          and(
            eq(members.issuer, identity.issuer),
            eq(members.subject, identity.subject),
            eq(members.tenant, input.tenant),
          ),
        )
        .limit(1);
      if (!allowed.length) throw new Error("Forbidden");
    },
    query: ({ identity }, input) =>
      db
        .select({ id: tasks.id, title: tasks.title })
        .from(tasks)
        .where(and(eq(tasks.tenant, input.tenant), membership(identity, input.tenant)))
        .orderBy(tasks.id),
  });
  const issuer = createNeonQueryIssuer({ ...options, queries: [declaration] });
  return {
    issue(
      input: v.InferInput<typeof listInput>,
      verified: VerifiedSession,
      login: TrustedLogin | undefined,
      signal: AbortSignal,
    ) {
      return issuer.issue(declaration, input, exampleAuthority(verified, login, signal));
    },
    update(
      input: v.InferInput<typeof updateInput>,
      verified: VerifiedSession,
      login: TrustedLogin | undefined,
      signal: AbortSignal,
    ) {
      const parsed = v.parse(updateInput, input);
      return runNeonMutation({
        ...options,
        authority: exampleAuthority(verified, login, signal),
        operation: "example.tasks.update.v1",
        idempotencyKey: parsed.key,
        input: parsed,
        output: v.strictObject({ id: v.string(), title: v.string() }),
        authorize: async (tx, { identity }) => {
          if (identity.tenantId !== parsed.tenant) throw new Error("Forbidden");
          const allowed = await tx
            .select({ subject: members.subject })
            .from(members)
            .where(
              and(
                eq(members.issuer, identity.issuer),
                eq(members.subject, identity.subject),
                eq(members.tenant, parsed.tenant),
              ),
            )
            .limit(1);
          if (!allowed.length) throw new Error("Forbidden");
        },
        execute: async (tx, { identity }) => {
          // Membership is checked again by the write predicate; a concurrent
          // revocation cannot bypass authorization through a preflight alone.
          const changed = await tx
            .update(tasks)
            .set({ title: parsed.title })
            .where(and(eq(tasks.id, parsed.id), eq(tasks.tenant, parsed.tenant), membership(identity, parsed.tenant)))
            .returning({ id: tasks.id, title: tasks.title });
          const value = changed[0];
          if (!value) throw new Error("Not found or forbidden");
          return { kind: "write", value };
        },
      });
    },
  };
}

/** Native typed HTTP procedures. Transport verification and configured store
 * resolution supply context; no login or identity is accepted in procedure input. */
export function createTaskRealtimeRouter<Relations extends AnyRelations>(
  options: Parameters<typeof createTaskRealtimeExample<Relations>>[0],
) {
  const example = createTaskRealtimeExample(options);
  const procedure = os.$context<ProcedureContext>();
  function authority(context: ProcedureContext) {
    if (!context.identity || !context.login || context.expiresAt === undefined) throw new ORPCError("UNAUTHORIZED");
    return { identity: context.identity, expiresAt: context.expiresAt };
  }
  return {
    issue: procedure
      .input(listInput)
      .handler(({ input, context }) => example.issue(input, authority(context), context.login, context.signal)),
    update: procedure
      .input(updateInput)
      .handler(({ input, context }) => example.update(input, authority(context), context.login, context.signal)),
  };
}
