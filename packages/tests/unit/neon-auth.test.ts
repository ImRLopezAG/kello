import { expect, test, vi } from "vite-plus/test";
import { createNeonAuthVerifier, neonAuth } from "kello/neon";
import { createRpcAuthentication, defineRpcAuth } from "../../../apps/kello/src/core/server/auth/rpc-definition";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

test("managed policy reads branch-injected URLs at runtime and captures trusted origins", async () => {
  const origins = ["https://frontend.test"];
  const policy = neonAuth({ origins });
  origins.push("https://untrusted.test");
  vi.stubEnv("NEON_AUTH_BASE_URL", "https://branch.auth.test/auth");
  vi.stubEnv("NEON_AUTH_JWKS_URL", "https://branch.auth.test/auth/jwks");
  try {
    expect(policy()).toEqual({
      origins: ["https://frontend.test"],
      issuers: [
        {
          issuer: "https://branch.auth.test",
          jwksUrl: "https://branch.auth.test/auth/jwks",
          algorithms: ["EdDSA"],
        },
      ],
    });
    const auth = createRpcAuthentication({}, defineRpcAuth({ verification: policy, authorize: () => {} }));
    await expect(auth.verify("opaque-token")).rejects.toThrow("Authentication failed");
    vi.stubEnv("NEON_AUTH_BASE_URL", "");
    expect(() => createRpcAuthentication({}, defineRpcAuth({ verification: policy, authorize: () => {} }))).toThrow(
      "Enable Neon Auth",
    );
  } finally {
    vi.unstubAllEnvs();
  }
});

test("Neon Auth requires explicit safe branch URLs and preserves verifier claim configuration", async () => {
  const config = {
    baseUrl: "https://branch.auth.example.test/neondb/auth",
    jwksUrl: "https://branch.auth.example.test/neondb/auth/.well-known/jwks.json",
    audience: "kello",
    tenantClaim: "organization",
  };
  const verify = createNeonAuthVerifier(config);
  await expect(verify("not-a-token")).rejects.toThrow("Authentication failed");
  for (const baseUrl of [
    "",
    "http://branch.auth.example.test/auth",
    "https://user:password@branch.auth.example.test/auth",
    "https://branch.auth.example.test/auth?override=true",
    "https://branch.auth.example.test/auth#fragment",
  ])
    expect(() => createNeonAuthVerifier({ ...config, baseUrl })).toThrow();
  expect(() => createNeonAuthVerifier({ ...config, jwksUrl: "http://branch.auth.example.test/jwks" })).toThrow();
  expect(() => createNeonAuthVerifier({ ...config, audience: "" })).toThrow();
  expect(() => createNeonAuthVerifier({ ...config, tenantClaim: "" })).toThrow();
});

test("Neon Auth verifies EdDSA tokens against configured JWKS and uses the origin issuer", async () => {
  const { publicKey, privateKey } = await generateKeyPair("EdDSA");
  const jwksUrl = "https://branch.auth.example.test/neondb/auth/.well-known/jwks.json";
  const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid: "neon-key" }] };
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json(jwks));
  try {
    const verify = createNeonAuthVerifier({
      baseUrl: "https://branch.auth.example.test/neondb/auth",
      jwksUrl,
      audience: "kello",
      tenantClaim: "organization",
    });
    const claims = {
      iss: "https://branch.auth.example.test",
      sub: "alice",
      aud: "kello",
      exp: Math.floor(Date.now() / 1000) + 60,
      organization: "one",
    };
    const sign = (payload: ConstructorParameters<typeof SignJWT>[0]) =>
      new SignJWT(payload).setProtectedHeader({ alg: "EdDSA", kid: "neon-key" }).sign(privateKey);
    expect(await verify(await sign(claims))).toEqual({
      identity: { issuer: claims.iss, subject: "alice", tenantId: "one" },
      expiresAt: claims.exp,
    });
    expect(fetcher.mock.calls[0]?.[0]).toBe(jwksUrl);
    for (const payload of [
      { ...claims, iss: "https://branch.auth.example.test/neondb/auth" },
      { ...claims, iss: "https://other-branch.auth.example.test" },
      { ...claims, aud: "other" },
      { ...claims, organization: "" },
    ])
      await expect(verify(await sign(payload))).rejects.toThrow("Authentication failed");
    expect(fetcher).toHaveBeenCalledTimes(1);
  } finally {
    fetcher.mockRestore();
  }
});
