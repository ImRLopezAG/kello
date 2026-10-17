import { expect, test, vi } from "vite-plus/test";
import { createNeonAuthMount } from "../../../apps/kello/src/core/adapters/neon/neon-auth-http";
import { neonAuth, neonAuthHosting } from "../../../apps/kello/src/core/adapters/neon/auth";
import { createAuthHttpApp } from "../../../apps/kello/src/core/adapters/neon/auth-http";

test("auth preflight admits the installed Neon SDK client-info header but rejects unknown headers", async () => {
  const handle = vi.fn(async () => new Response(null));
  const app = createAuthHttpApp({ origins: ["https://app.test"], mounts: [{ prefix: "/api/auth", handle }] });
  const preflight = (requested: string, origin = "https://app.test") =>
    app.fetch(
      new Request("https://kello.test/api/auth/sign-up/email", {
        method: "OPTIONS",
        headers: {
          origin,
          "access-control-request-method": "POST",
          "access-control-request-headers": requested,
        },
      }),
    );
  const response = await preflight("content-type,x-neon-client-info");
  expect(response.status).toBe(204);
  expect(response.headers.get("access-control-allow-headers")).toContain("x-neon-client-info");
  expect(response.headers.get("access-control-allow-origin")).toBe("https://app.test");
  expect(response.headers.get("access-control-allow-credentials")).toBe("true");
  expect((await preflight("content-type,x-untrusted-header")).status).toBe(403);
  expect((await preflight("x-neon-client-info", "https://evil.test")).status).toBe(403);
  expect(handle).not.toHaveBeenCalled();
});

test("managed SDK proxy preserves redirect and cancellation while excluding forged forwarding headers", async () => {
  const abort = new AbortController();
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    expect(input instanceof URL ? input.href : input).toBe(
      "https://branch.neonauth.test/neondb/auth/callback/provider?code=example",
    );
    expect(init?.signal?.aborted).toBe(false);
    expect(init?.redirect).toBe("manual");
    const headers = new Headers(init?.headers);
    expect(headers.get("x-forwarded-host")).toBeNull();
    expect(headers.get("origin")).toBe("https://app.test");
    return new Response(null, {
      status: 302,
      headers: {
        location: "https://app.test/complete",
        "set-cookie": "__Secure-neon-auth.session_token=test; HttpOnly; Secure; Path=/",
      },
    });
  });
  try {
    const mount = createNeonAuthMount({
      baseUrl: "https://branch.neonauth.test/neondb/auth",
      cookieSecret: "test-only-proxy-cookie-secret-at-least-32-characters",
      activate: async () => {},
    });
    const response = await mount.handle(
      new Request("https://kello.test/api/auth/callback/provider?code=example", {
        signal: abort.signal,
        headers: { origin: "https://app.test", "x-forwarded-host": "evil.test" },
      }),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://app.test/complete");
    expect(response.headers.getSetCookie()).toHaveLength(1);
    expect(response.headers.getSetCookie()[0]).toContain("SameSite=None");
  } finally {
    fetcher.mockRestore();
  }
});

test("managed hosting uses server-declared branch configuration and requires a signing secret", () => {
  const verification = neonAuth({ origins: [] });
  expect(neonAuthHosting(() => ({}), {})).toBeUndefined();
  expect(() => neonAuthHosting(verification, { NEON_AUTH_BASE_URL: "https://branch.test/auth" })).toThrow(
    "COOKIE_SECRET",
  );
  const environment = { NEON_AUTH_BASE_URL: "https://branch.test/auth", NEON_AUTH_COOKIE_SECRET: "server-secret" };
  expect(neonAuthHosting(verification, environment)).toEqual({
    baseUrl: environment.NEON_AUTH_BASE_URL,
    cookieSecret: environment.NEON_AUTH_COOKIE_SECRET,
  });
  expect(() =>
    neonAuthHosting(neonAuth({ origins: [], baseUrl: "https://production.test/auth" }), environment),
  ).toThrow("own branch");
});

test("managed upstream outage respects the ingress deadline and rejects hostile callers before fetch", async () => {
  let cancelled = false;
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(
    (_input, init) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener(
          "abort",
          () => {
            cancelled = true;
            reject(signal.reason);
          },
          { once: true },
        );
      }),
  );
  try {
    const mount = createNeonAuthMount({
      baseUrl: "https://branch.test/auth",
      cookieSecret: "test-only-proxy-cookie-secret-at-least-32-characters",
      activate: async () => {},
    });
    const app = createAuthHttpApp({ origins: ["https://app.test"], mounts: [mount], requestTimeoutMs: 10 });
    expect(
      (
        await app.fetch(
          new Request("https://kello.test/api/auth/get-session", { headers: { origin: "https://evil.test" } }),
        )
      ).status,
    ).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
    expect(
      (
        await app.fetch(
          new Request("https://kello.test/api/auth/get-session", { headers: { origin: "https://app.test" } }),
        )
      ).status,
    ).toBe(504);
    await app.drain();
    expect(cancelled).toBe(true);
  } finally {
    fetcher.mockRestore();
  }
});
