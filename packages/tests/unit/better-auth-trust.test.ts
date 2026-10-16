import { expect, test } from "vite-plus/test";
import { jwt } from "better-auth/plugins";
import { validateBetterAuthTrust } from "../../../apps/kello/src/core/better-auth/trust";

const issuer = {
  issuer: "https://api.test",
  audience: "kello",
  jwksUrl: "https://api.test/api/auth/jwks",
  algorithms: ["EdDSA" as const],
};
const configuration = (expirationTime = "5m") => ({
  options: {
    baseURL: "https://api.test",
    plugins: [
      jwt({
        jwt: { issuer: issuer.issuer, audience: issuer.audience, expirationTime },
        jwks: { keyPairConfig: { alg: "EdDSA" } },
      }),
    ],
  },
});

test("native JWT issuance must match server trust and a bounded expiration", () => {
  expect(() => validateBetterAuthTrust(configuration(), { issuers: [issuer] })).not.toThrow();
  for (const expiration of ["15m", "0s", "-5s"])
    expect(() => validateBetterAuthTrust(configuration(expiration), { issuers: [issuer] })).toThrow("five minutes");
  for (const changed of [
    { ...issuer, issuer: "https://other.test" },
    { ...issuer, audience: "other" },
    { ...issuer, jwksUrl: "https://other.test/keys" },
    { ...issuer, algorithms: ["RS256" as const] },
  ])
    expect(() => validateBetterAuthTrust(configuration(), { issuers: [changed] })).toThrow();
  expect(() => validateBetterAuthTrust(configuration(), {})).toThrow();
  expect(() => validateBetterAuthTrust({ options: { plugins: [jwt()] } }, { issuers: [issuer] })).toThrow();
});
