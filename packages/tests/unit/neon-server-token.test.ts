import { expect, test, vi } from "vite-plus/test";
import { createAuthServer } from "@neondatabase/auth/server";
import { neonServerToken } from "../../../apps/kello/src/core/server/auth/neon-token";

test("SSR obtains the signed SDK token instead of forwarding the opaque session cookie", async () => {
  const now = new Date().toISOString();
  const session = {
    session: {
      id: "session",
      userId: "user",
      token: "opaque-cookie",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      createdAt: now,
      updatedAt: now,
    },
    user: {
      id: "user",
      name: "Example",
      email: "user@example.test",
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    },
  };
  let anonymous = false;
  let rejected = false;
  let tokenRequests = 0;
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.pathname.endsWith("/token")) {
      tokenRequests++;
      return Response.json(rejected ? { message: "Unavailable" } : { token: "signed-jwt" }, {
        status: rejected ? 503 : 200,
      });
    }
    return Response.json(anonymous ? null : session);
  });
  const auth = createAuthServer({
    baseUrl: "https://auth.example.test/auth",
    cookieSecret: "a".repeat(32),
    context: () => ({
      getCookies: () => "__Secure-neon-auth.session_token=test",
      getHeader: () => null,
      getOrigin: () => "https://app.example.test",
      getFramework: () => "test",
      setCookie: () => {},
    }),
  });
  try {
    expect(await neonServerToken(auth)).toBe("signed-jwt");
    anonymous = true;
    expect(await neonServerToken(auth)).toBeNull();
    expect(tokenRequests).toBe(1);
    anonymous = false;
    rejected = true;
    await expect(neonServerToken(auth)).rejects.toThrow("Neon server token unavailable");
  } finally {
    fetchSpy.mockRestore();
  }
});
