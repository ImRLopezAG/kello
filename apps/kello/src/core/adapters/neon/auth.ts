import { createJwtVerifier } from "../../server/auth/verify";
import type { VerifiedSession } from "../../server/auth/verify";
import type { AuthConfigInput } from "../../server/auth/config";

const managedHosting = new WeakMap<() => AuthConfigInput, { readonly baseUrl?: string }>();

/** Only server-declared Neon verification opts into the managed backend mount. */
export function neonAuthHosting(
  verification: (() => AuthConfigInput) | undefined,
  environment: Readonly<Record<string, string | undefined>>,
) {
  const settings = verification && managedHosting.get(verification);
  if (!settings) return undefined;
  const baseUrl = settings.baseUrl ?? environment.NEON_AUTH_BASE_URL;
  const cookieSecret = environment.NEON_AUTH_COOKIE_SECRET;
  if (
    settings.baseUrl &&
    environment.NEON_AUTH_BASE_URL &&
    new URL(settings.baseUrl).href !== new URL(environment.NEON_AUTH_BASE_URL).href
  )
    throw new Error("Hosted Neon Auth must use the Function's own branch auth endpoint");
  if (!baseUrl || !cookieSecret)
    throw new Error("Hosted Neon Auth requires NEON_AUTH_BASE_URL and NEON_AUTH_COOKIE_SECRET on the Kello server");
  return { baseUrl, cookieSecret };
}

export interface NeonAuthOptions {
  /** NEON_AUTH_BASE_URL injected by Neon Functions on the selected branch. */
  readonly baseUrl: string;
  /** NEON_AUTH_JWKS_URL injected by Neon Functions on the selected branch. */
  readonly jwksUrl: string;
  readonly audience?: string;
  readonly tenantClaim?: string;
}

/** Resolve managed trust from the function's own branch, not browser input or token claims. */
export function neonAuth(options: {
  readonly origins: readonly string[];
  readonly baseUrl?: string;
  readonly jwksUrl?: string;
  readonly audience?: string;
  readonly tenantClaim?: string;
}): () => AuthConfigInput {
  const settings = structuredClone(options);
  const verification = () => {
    const baseUrl = settings.baseUrl ?? process.env.NEON_AUTH_BASE_URL;
    const jwksUrl = settings.jwksUrl ?? process.env.NEON_AUTH_JWKS_URL;
    if (!baseUrl || !jwksUrl) throw new Error("Enable Neon Auth on this branch or provide explicit trusted auth URLs");
    const base = new URL(baseUrl);
    if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash)
      throw new Error("Invalid Neon Auth base URL");
    const claims: Partial<Record<"audience" | "tenantClaim", string>> = {};
    if (settings.audience !== undefined) claims.audience = settings.audience;
    if (settings.tenantClaim !== undefined) claims.tenantClaim = settings.tenantClaim;
    return {
      origins: [...settings.origins],
      issuers: [{ issuer: base.origin, jwksUrl, algorithms: ["EdDSA" as const], ...claims }],
    };
  };
  managedHosting.set(verification, settings);
  return verification;
}

/** Neon Auth uses the auth base URL's origin as its JWT issuer. */
export function createNeonAuthVerifier(options: NeonAuthOptions): (token: string) => Promise<VerifiedSession> {
  const base = new URL(options.baseUrl);
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash)
    throw new Error("Neon Auth base URL must use HTTPS without credentials, query or fragment");
  const claims: Partial<Record<"audience" | "tenantClaim", string>> = {};
  if (options.audience !== undefined) claims.audience = options.audience;
  if (options.tenantClaim !== undefined) claims.tenantClaim = options.tenantClaim;
  return createJwtVerifier([
    {
      issuer: base.origin,
      keys: { type: "remote", url: options.jwksUrl },
      ...claims,
    },
  ]);
}
