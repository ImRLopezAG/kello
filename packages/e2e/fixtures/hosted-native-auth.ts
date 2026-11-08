import { betterAuth } from "better-auth";
import { bearer, jwt, organization } from "better-auth/plugins";
import type { resolveBetterAuthSchema } from "kello/better-auth";

import { appPreferences } from "./app-auth-plugin";

// Keep native configuration identical during schema discovery and deployed runtime initialization.
export function nativeAuth(
  database: Parameters<Parameters<typeof resolveBetterAuthSchema>[0]>[0],
  baseURL: string,
  secret: string,
) {
  return betterAuth({
    database,
    baseURL,
    secret,
    emailAndPassword: { enabled: true },
    plugins: [
      appPreferences({ modelName: "customerPreferences", maxLength: 20 }),
      bearer({ requireSignature: true }),
      jwt({
        jwt: { issuer: baseURL, audience: "kello-test", expirationTime: "5m" },
        jwks: { keyPairConfig: { alg: "EdDSA" } },
      }),
      organization({ teams: { enabled: true } }),
    ],
  });
}
