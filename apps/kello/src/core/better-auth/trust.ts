import * as v from "valibot";
import { toExpJWT } from "better-auth/plugins/jwt";
import type { NativeAuth } from "./definition";
import type { AuthConfigInput } from "../server/auth/config";

const jwtOptions = v.object({
  jwt: v.object({
    issuer: v.string(),
    audience: v.union([v.string(), v.array(v.string())]),
    expirationTime: v.string(),
  }),
  jwks: v.object({
    keyPairConfig: v.object({ alg: v.picklist(["RS256", "ES256", "EdDSA"]) }),
    jwksPath: v.optional(v.string(), "/jwks"),
  }),
});

/** Native session tokens never become RPC credentials. Only configured JWT trust is admitted. */
export function validateBetterAuthTrust(auth: Pick<NativeAuth, "options">, trust: AuthConfigInput): void {
  const plugin = auth.options.plugins?.find((entry) => entry.id === "jwt");
  if (!plugin) return;
  const options = v.parse(jwtOptions, plugin.options);
  const issued = Math.floor(Date.now() / 1000);
  const duration = toExpJWT(options.jwt.expirationTime, issued) - issued;
  if (!Number.isFinite(duration) || duration <= 0 || duration > 300)
    throw new Error("Kello access tokens must expire within five minutes");
  const issuer = trust.issuers?.find((entry) => entry.issuer === options.jwt.issuer);
  const audience = issuer?.audience ?? trust.audience;
  const audiences = [options.jwt.audience].flat();
  if (
    !issuer ||
    !audience ||
    !audiences.includes(audience) ||
    !issuer.algorithms?.includes(options.jwks.keyPairConfig.alg)
  )
    throw new Error("Better Auth JWT issuer, audience and algorithm must match explicit RPC trust");
  const url = new URL(v.parse(v.string("Hosted Better Auth requires a fixed server baseURL"), auth.options.baseURL));
  url.pathname = (auth.options.basePath ?? "/api/auth") + options.jwks.jwksPath;
  url.search = "";
  url.hash = "";
  if (issuer.jwksUrl !== url.href) throw new Error("Better Auth JWKS trust must name its hosted key endpoint");
}
