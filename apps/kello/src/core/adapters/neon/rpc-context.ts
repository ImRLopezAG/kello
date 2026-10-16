import { ORPCError, RPCSerializer } from "@orpc/server";
import { Context } from "effect";
import * as v from "valibot";
import { Invocation } from "../../server/effect/runtime";
import type { ProcedureContext } from "../../server/rpc/procedure";
import { captureTrustedLogin } from "../../server/auth/login";
import type { TrustedLogin } from "../../server/auth/login";
import type { VerifiedSession } from "../../server/auth/verify";

export { rpcErrorStatusMap } from "../../server/rpc/error-status";
export const rpcTransportSerializer = new RPCSerializer({ omitUndefinedProperties: false });

export function rpcFailure(code: string, status: number, headers: Headers = new Headers()): Response {
  return Response.json(rpcTransportSerializer.serialize(new ORPCError(code).toJSON()), { status, headers });
}

export function rpcContext(
  session: VerifiedSession | null,
  signal: AbortSignal,
  idempotencyKey: string | readonly string[] | undefined,
  operation?: string | readonly string[],
  login?: TrustedLogin,
): ProcedureContext {
  signal.throwIfAborted();
  if (session && session.expiresAt <= Date.now() / 1000) throw new ORPCError("UNAUTHORIZED");
  if (login && !session) throw new ORPCError("UNAUTHORIZED");
  let capturedLogin: TrustedLogin | undefined;
  try {
    capturedLogin = login && session ? captureTrustedLogin(session, login, signal) : undefined;
  } catch {
    signal.throwIfAborted();
    throw new ORPCError("UNAUTHORIZED");
  }
  const key = v.safeParse(v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(128))), idempotencyKey);
  if (!key.success) throw new ORPCError("INVALID_IDEMPOTENCY_KEY");
  const intent = v.safeParse(
    v.optional(v.picklist(["query", "infinite", "streamed", "live", "mutation", "call"]), "call"),
    operation,
  );
  if (!intent.success) throw new ORPCError("BAD_REQUEST");
  const invocation = Object.freeze({
    identity: session ? Object.freeze({ ...session.identity }) : null,
    requestId: crypto.randomUUID(),
    signal,
  });
  const context: ProcedureContext = {
    ...invocation,
    operation: intent.output,
    expiresAt: capturedLogin?.expiresAt ?? session?.expiresAt ?? Math.floor(Date.now() / 1000) + 120,
    "effect/context": Context.make(Invocation, invocation),
  };
  const authenticated = capturedLogin ? { ...context, login: capturedLogin } : context;
  return key.output === undefined ? authenticated : { ...authenticated, idempotencyKey: key.output };
}
