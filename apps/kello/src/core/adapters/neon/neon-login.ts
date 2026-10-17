import { extractNeonAuthCookies, NEON_AUTH_SESSION_COOKIE_NAME, parseCookieValue } from "@neondatabase/auth/server";
import * as v from "valibot";
import { AuthenticationError, httpsAddress } from "../../server/auth/verify";
import { captureTrustedLogin } from "../../server/auth/login";
import type { TrustedLoginResolver } from "../../server/auth/login";

const identifier = v.pipe(v.string(), v.minLength(1), v.maxLength(512));
const sessionResponse = v.object({
  session: v.object({ id: identifier, userId: identifier, expiresAt: v.pipe(v.string(), v.isoTimestamp()) }),
  user: v.object({ id: identifier }),
});

/** Resolve the actual provider session on every issuance/renewal. The pinned SDK's
 * getSession helper ignores AbortSignal; use its supported get-session endpoint
 * with the SDK cookie parser and the invocation deadline, as the auth proxy does. */
export function createNeonLoginResolver(options: { readonly baseUrl?: string } = {}): TrustedLoginResolver {
  const base = httpsAddress(options.baseUrl ?? process.env.NEON_AUTH_BASE_URL ?? "");
  if (base.search) throw new Error("Neon Auth upstream must not contain query parameters");
  const endpoint = new URL(`${base.href.replace(/\/$/, "")}/get-session`);
  endpoint.searchParams.set("disableCookieCache", "true");
  endpoint.searchParams.set("disableRefresh", "true");
  return async ({ verified, signal, headers }) => {
    signal.throwIfAborted();
    if (!headers) return undefined;
    const cookies = extractNeonAuthCookies(headers);
    const sessionToken = parseCookieValue(cookies, NEON_AUTH_SESSION_COOKIE_NAME);
    if (!sessionToken) return undefined;
    // A branch's cookie authority cannot authenticate another issuer or an
    // unconfigured tenant. Examples use Neon Auth without tenant claims.
    if (verified.identity.issuer !== base.origin || verified.identity.tenantId !== undefined)
      throw new AuthenticationError();
    const response = await fetch(endpoint, {
      headers: {
        cookie: `${NEON_AUTH_SESSION_COOKIE_NAME}=${sessionToken}`,
        origin: headers.get("origin") ?? base.origin,
      },
      signal,
      redirect: "error",
      cache: "no-store",
    });
    if (!response.ok) throw new AuthenticationError();
    const parsed = v.safeParse(sessionResponse, await response.json());
    if (!parsed.success || parsed.output.user.id !== parsed.output.session.userId) return undefined;
    const { session, user } = parsed.output;
    return captureTrustedLogin(
      verified,
      {
        id: session.id,
        issuer: base.origin,
        subject: user.id,
        expiresAt: Math.floor(Date.parse(session.expiresAt) / 1000),
      },
      signal,
    );
  };
}
