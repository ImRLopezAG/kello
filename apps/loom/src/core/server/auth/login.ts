import * as v from "valibot";
import { AuthenticationError } from "./verify";
import type { VerifiedSession } from "./verify";

/** A server session-store record. Its generation identifies a login, not a user,
 * request, token hash or client label; refresh must preserve the generation. */
export interface TrustedLogin {
  readonly id: string;
  readonly issuer: string;
  readonly subject: string;
  readonly tenantId?: string | undefined;
  /** Unix seconds, bounded by the verified credential's expiration. */
  readonly expiresAt: number;
}
export type TrustedLoginResolver = (input: {
  readonly verified: VerifiedSession;
  /** Server-only input for the configured store. Never retain or return it. */
  readonly credential: string;
  readonly signal: AbortSignal;
}) => Promise<TrustedLogin | undefined>;

const identifier = v.pipe(v.string(), v.minLength(1), v.maxLength(1024));
const loginSchema = v.strictObject({
  id: v.pipe(v.string(), v.minLength(1), v.maxLength(512)),
  issuer: identifier,
  subject: identifier,
  tenantId: v.optional(identifier),
  expiresAt: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
});

/** Recheck at context construction too: asynchronous resolution may cross expiry. */
export function captureTrustedLogin(verified: VerifiedSession, login: TrustedLogin, signal: AbortSignal): TrustedLogin {
  signal.throwIfAborted();
  const parsed = v.safeParse(loginSchema, login);
  if (!parsed.success) throw new AuthenticationError();
  const value = parsed.output;
  const expiresAt = Math.min(value.expiresAt, verified.expiresAt);
  if (
    value.issuer !== verified.identity.issuer ||
    value.subject !== verified.identity.subject ||
    value.tenantId !== verified.identity.tenantId ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt * 1000 <= Date.now()
  )
    throw new AuthenticationError();
  return Object.freeze({ ...value, expiresAt });
}

export async function resolveTrustedLogin(
  resolver: TrustedLoginResolver | undefined,
  credential: string,
  verified: VerifiedSession,
  signal: AbortSignal,
): Promise<TrustedLogin | undefined> {
  signal.throwIfAborted();
  if (!resolver) return undefined;
  const captured = Object.freeze({ identity: Object.freeze({ ...verified.identity }), expiresAt: verified.expiresAt });
  const login = await resolver({ verified: captured, credential, signal });
  signal.throwIfAborted();
  return login === undefined ? undefined : captureTrustedLogin(captured, login, signal);
}
