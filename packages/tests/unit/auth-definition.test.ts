import { ORPCError } from "@orpc/server";
import { expect, test, vi } from "vite-plus/test";
import {
  createRpcAuthentication,
  defineRpcAuth,
  isRpcAuthDefinition,
} from "../../../apps/kello/src/core/server/auth/rpc-definition";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

test("auth declarations capture explicit policy and deny when omitted", async () => {
  const options = { allowAnonymous: true, authorize: () => {} };
  const definition = defineRpcAuth(options);
  options.allowAnonymous = false;
  options.authorize = () => {
    throw new Error("changed");
  };
  expect(isRpcAuthDefinition(definition)).toBe(true);
  expect(isRpcAuthDefinition({ ...definition })).toBe(false);
  expect(Object.isFrozen(definition)).toBe(true);
  expect(() => createRpcAuthentication({}, { ...definition })).toThrow("defineRpcAuth");
  const auth = createRpcAuthentication({}, definition);
  expect(auth.allowAnonymous).toBe(true);
  const context = {
    path: ["tasks", "list"],
    input: null,
    requestId: "request",
    signal: new AbortController().signal,
    identity: null,
  };
  await expect(auth.authorize(context)).resolves.toBeUndefined();
  await expect(auth.verify("not-a-token")).rejects.toThrow("Authentication failed");
  const denied = createRpcAuthentication({});
  expect(denied.allowAnonymous).toBe(false);
  await expect(denied.authorize(context)).rejects.toMatchObject({ code: "FORBIDDEN" });
});

test("configured authentication binds JWKS, audience and tenant verification without fetching at construction", async () => {
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid: "auth-definition" }] };
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json(jwks));
  try {
    const config = {
      issuers: [
        {
          issuer: "https://identity.example.test",
          jwksUrl: "https://identity.example.test/jwks",
          tenantClaim: "tenant",
        },
      ],
      audience: "kello",
      origins: ["https://app.example.test"],
    };
    const auth = createRpcAuthentication(
      config,
      defineRpcAuth({
        authorize: ({ identity }) => {
          if (identity?.tenantId !== "one") throw new ORPCError("FORBIDDEN");
        },
      }),
    );
    expect(fetcher).not.toHaveBeenCalled();
    config.issuers.length = 0;
    config.audience = "changed";
    config.origins.length = 0;
    const claims = {
      iss: "https://identity.example.test",
      sub: "alice",
      aud: "kello",
      tenant: "one",
      exp: Math.floor(Date.now() / 1000) + 60,
    };
    const sign = (payload: ConstructorParameters<typeof SignJWT>[0]) =>
      new SignJWT(payload).setProtectedHeader({ alg: "ES256", kid: "auth-definition" }).sign(privateKey);
    const session = await auth.verify(await sign(claims));
    expect(session.identity.tenantId).toBe("one");
    expect(auth.origins).toEqual(["https://app.example.test"]);
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://identity.example.test/jwks");
    await expect(auth.verify(await sign({ ...claims, aud: "other" }))).rejects.toThrow("Authentication failed");
    await expect(auth.verify(await sign({ ...claims, tenant: "" }))).rejects.toThrow("Authentication failed");
    await expect(
      auth.authorize({
        path: ["tasks", "list"],
        input: null,
        requestId: "request",
        signal: new AbortController().signal,
        identity: null,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  } finally {
    fetcher.mockRestore();
  }
});

test("auth.config policy selects per-issuer audiences and algorithms", async () => {
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    Response.json({
      keys: [{ ...(await exportJWK(publicKey)), kid: "policy" }],
    }),
  );
  try {
    const auth = createRpcAuthentication(
      {},
      defineRpcAuth({
        verification: () => ({
          issuers: [
            { issuer: "https://a.test", jwksUrl: "https://a.test/jwks", audience: "a", algorithms: ["ES256"] },
            { issuer: "https://b.test", jwksUrl: "https://b.test/jwks", audience: "b", algorithms: ["RS256"] },
          ],
          origins: ["https://frontend.test"],
        }),
        authorize: () => {},
      }),
    );
    const sign = (issuer: string, audience: string) =>
      new SignJWT({})
        .setIssuer(issuer)
        .setAudience(audience)
        .setSubject("alice")
        .setExpirationTime("1m")
        .setProtectedHeader({ alg: "ES256", kid: "policy" })
        .sign(privateKey);
    expect((await auth.verify(await sign("https://a.test", "a"))).identity.subject).toBe("alice");
    await expect(auth.verify(await sign("https://a.test", "b"))).rejects.toThrow("Authentication failed");
    await expect(auth.verify(await sign("https://b.test", "b"))).rejects.toThrow("Authentication failed");
    expect(auth.origins).toEqual(["https://frontend.test"]);
  } finally {
    fetcher.mockRestore();
  }
});
