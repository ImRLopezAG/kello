import * as v from "valibot";
import { originPolicy } from "./policy";
import { httpsAddress } from "./verify";

const identifier = v.pipe(v.string(), v.minLength(1), v.maxLength(1024));
export const jwtAlgorithms = v.pipe(v.array(v.picklist(["RS256", "ES256", "EdDSA"])), v.minLength(1), v.maxLength(3));
const httpsUrl = v.pipe(
  v.string(),
  v.check((value) => {
    try {
      httpsAddress(value);
      return true;
    } catch {
      return false;
    }
  }, "Authentication URLs must use HTTPS without credentials or fragments"),
);

export const authConfigValidator = v.strictObject({
  issuers: v.optional(
    v.pipe(
      v.array(
        v.strictObject({
          issuer: httpsUrl,
          jwksUrl: httpsUrl,
          tenantClaim: v.exactOptional(identifier),
          audience: v.exactOptional(identifier),
          algorithms: v.exactOptional(jwtAlgorithms),
        }),
      ),
      v.maxLength(16),
      v.check(
        (issuers) => new Set(issuers.map((entry) => entry.issuer)).size === issuers.length,
        "Duplicate trusted issuer",
      ),
    ),
    [],
  ),
  audience: v.exactOptional(identifier),
  origins: v.optional(
    v.pipe(
      v.array(v.string()),
      v.check((origins) => {
        try {
          originPolicy(origins);
          return true;
        } catch {
          return false;
        }
      }, "Expected canonical HTTPS origins or local development origins"),
    ),
    [],
  ),
});
export type AuthConfigInput = v.InferInput<typeof authConfigValidator>;
