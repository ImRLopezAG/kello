import { expect, test, vi } from "vite-plus/test";
import { createAuthClient } from "@neondatabase/auth/next";
import { neonClientToken } from "../../../apps/kello/src/core/client/neon-token";

test("proxy credentials use the signed token endpoint and reject a different provider session", async () => {
  let tokenRequests = 0;
  let unavailable = false;
  let malformed = false;
  const now = new Date().toISOString();
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (new URL(url, "http://localhost").pathname.endsWith("/token")) {
      tokenRequests++;
      if (url.startsWith("https://kello.example.test")) expect(init?.credentials).toBe("include");
      return Response.json(malformed ? { token: 42 } : { token: "signed-backend-jwt" }, {
        status: unavailable ? 503 : 200,
      });
    }
    return Response.json({
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
    });
  });
  try {
    const auth = createAuthClient();
    const endpoint = { url: "/api/auth/token", credentials: "same-origin" } as const;
    expect(await neonClientToken(auth, "user", "session", endpoint)).toBe("signed-backend-jwt");
    expect(await neonClientToken(auth, "other-user", "session", endpoint)).toBeNull();
    expect(await neonClientToken(auth, "user", "other-session", endpoint)).toBeNull();
    expect(tokenRequests).toBe(1);
    expect(
      await neonClientToken(auth, "user", "session", {
        url: "https://kello.example.test/api/auth/token",
        credentials: "include",
      }),
    ).toBe("signed-backend-jwt");
    expect(fetchSpy.mock.calls.at(-1)?.[0]).toBe("https://kello.example.test/api/auth/token");
    unavailable = true;
    await expect(neonClientToken(auth, "user", "session", endpoint)).rejects.toThrow("Neon token refresh failed");
    unavailable = false;
    malformed = true;
    await expect(neonClientToken(auth, "user", "session", endpoint)).rejects.toThrow("Neon token refresh failed");
  } finally {
    fetchSpy.mockRestore();
  }
});
