import * as v from "valibot";
import { AuthenticationError, createJwtVerifier } from "./verify";
import type { VerifiedSession } from "./verify";
import { authConfigValidator } from "./config";
import type { AuthConfigInput } from "./config";

/** Offline construction; remote keys are fetched only when a token is verified. */
export function createAuthenticationConfiguration(input: AuthConfigInput) {
  const config = v.parse(authConfigValidator, input);
  const verify =
    config.issuers.length > 0
      ? createJwtVerifier(
          config.issuers.map((entry) => {
            const claims: Partial<Record<"audience" | "tenantClaim", string>> = {};
            const audience = entry.audience ?? config.audience;
            if (audience !== undefined) claims.audience = audience;
            if (entry.tenantClaim !== undefined) claims.tenantClaim = entry.tenantClaim;
            return {
              issuer: entry.issuer,
              keys: { type: "remote" as const, url: entry.jwksUrl },
              algorithms: entry.algorithms ?? ["RS256", "ES256", "EdDSA"],
              ...claims,
            };
          }),
        )
      : async (): Promise<VerifiedSession> => {
          throw new AuthenticationError();
        };
  return Object.freeze({ verify, origins: Object.freeze([...config.origins]) });
}
