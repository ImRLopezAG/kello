import { createLocalJWKSet, createRemoteJWKSet, decodeJwt, jwtVerify } from "jose";
import type { JSONWebKeySet, JWTVerifyOptions } from "jose";
import * as v from "valibot";
import type { InvocationIdentity } from "./context";

export interface JwtIssuer {
  readonly issuer: string;
  readonly audience?: string;
  readonly algorithms?: readonly ("RS256" | "ES256" | "EdDSA")[];
  /** When configured, a nonempty tenant claim is required in every accepted token. */
  readonly tenantClaim?: string;
  readonly keys:
    | { readonly type: "remote"; readonly url: string }
    | { readonly type: "local"; readonly jwks: JSONWebKeySet };
}
export interface VerifiedSession {
  readonly identity: InvocationIdentity;
  /** JWT expiration as Unix seconds; long-lived transports must enforce this deadline. */
  readonly expiresAt: number;
}
export class AuthenticationError extends Error {
  constructor() {
    super("Authentication failed");
  }
}
const identifier = v.pipe(v.string(), v.minLength(1), v.maxLength(1024));
const claimsSchema = v.object({
  iss: identifier,
  sub: identifier,
  exp: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
});
export function httpsAddress(value: string): URL {
  const address = new URL(value);
  if (address.protocol !== "https:" || address.username || address.password || address.hash)
    throw new Error("Authentication URLs must use HTTPS without credentials or fragments");
  return address;
}

/** Unverified issuer claims select only preconfigured keys; they never choose a network destination. */
export function createJwtVerifier(issuers: readonly JwtIssuer[]): (token: string) => Promise<VerifiedSession> {
  if (!issuers.length || issuers.length > 16) throw new Error("Configure between one and sixteen trusted issuers");
  const trusted = new Map<string, (token: string) => Promise<VerifiedSession>>();
  for (const input of issuers) {
    const config = structuredClone(input);
    httpsAddress(config.issuer);
    if (trusted.has(config.issuer)) throw new Error("Duplicate trusted issuer");
    if (config.audience !== undefined) v.parse(identifier, config.audience);
    if (config.tenantClaim !== undefined) v.parse(identifier, config.tenantClaim);
    const algorithms = v.parse(
      v.pipe(v.array(v.picklist(["RS256", "ES256", "EdDSA"])), v.minLength(1), v.maxLength(3)),
      config.algorithms ?? ["RS256", "ES256", "EdDSA"],
    );
    const keys =
      config.keys.type === "remote"
        ? createRemoteJWKSet(httpsAddress(config.keys.url), {
            timeoutDuration: 5000,
            cooldownDuration: 30000,
            cacheMaxAge: 600000,
          })
        : createLocalJWKSet(config.keys.jwks);
    const options: JWTVerifyOptions = {
      issuer: config.issuer,
      algorithms,
      requiredClaims: ["iss", "sub", "exp"],
      clockTolerance: 0,
    };
    if (config.audience !== undefined) options.audience = config.audience;
    trusted.set(config.issuer, async (token) => {
      const { payload } = await jwtVerify(token, keys, options);
      const claims = v.parse(claimsSchema, payload);
      const principal = {
        issuer: claims.iss,
        subject: claims.sub,
      };
      const identity =
        config.tenantClaim === undefined
          ? principal
          : { ...principal, tenantId: v.parse(identifier, payload[config.tenantClaim]) };
      return Object.freeze({ identity: Object.freeze(identity), expiresAt: claims.exp });
    });
  }
  return async (token) => {
    try {
      if (!token || token.length > 16384) throw new AuthenticationError();
      const decoded = v.parse(v.object({ iss: identifier }), decodeJwt(token));
      const issuer = trusted.get(decoded.iss);
      if (!issuer) throw new AuthenticationError();
      return await issuer(token);
    } catch {
      throw new AuthenticationError();
    }
  };
}
