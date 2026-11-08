import { expect, test } from "vite-plus/test";
import { createCookieSessionHandler, readToken, sessionFingerprint } from "kello/server";
import { createCookieSession, createQueryClient } from "kello/client";

test("cookie session verifies credentials and binds reads to the rendered identity", async () => {
  const session = createCookieSessionHandler({
    async verify(token) {
      if (token !== "accepted") throw new Error("denied");
    },
  });
  const post = (body: string, origin = "https://app.test") =>
    session(new Request("https://app.test/api/session", { method: "POST", headers: { origin }, body }));
  expect((await post("accepted", "https://evil.test")).status).toBe(403);
  expect((await post("rejected")).status).toBe(401);
  expect((await post("x".repeat(3801))).status).toBe(413);
  expect((await post("token; injected=value")).status).toBe(400);
  const response = await post("accepted");
  expect(response.status).toBe(204);
  expect(response.headers.get("set-cookie")).toContain("HttpOnly; SameSite=Lax; Max-Age=3600; Secure");
  expect(response.headers.get("cache-control")).toBe("no-store");
  const get = (id: string) =>
    session(
      new Request("https://app.test/api/session", {
        headers: { cookie: "kello_session=accepted", "x-kello-session": "1", "x-kello-session-id": id },
      }),
    );
  expect((await get(await sessionFingerprint("other"))).status).toBe(401);
  expect(await (await get(await sessionFingerprint("accepted"))).json()).toEqual({ token: "accepted" });
  expect(readToken(new Request("https://app.test", { headers: { cookie: "kello_session=bad value" } }))).toBeNull();
  const deleted = await session(
    new Request("https://app.test/api/session", { method: "DELETE", headers: { origin: "https://app.test" } }),
  );
  expect(deleted.status).toBe(204);
  expect(deleted.headers.get("set-cookie")).toContain("Max-Age=0");
});

test("cookie adapter rejects cross-origin endpoints and query caches remain request scoped", () => {
  for (const endpoint of [
    "https://other.test/session",
    "//other.test/session",
    "/\n/other.test/session",
    "/\\other.test/session",
  ])
    expect(() => createCookieSession(endpoint)).toThrow("same-origin");
  const alice = createQueryClient();
  const bob = createQueryClient();
  alice.setQueryData(["private"], "alice");
  expect(bob.getQueryData(["private"])).toBeUndefined();
  expect(
    createQueryClient({ defaultOptions: { queries: { staleTime: 123 } } }).getDefaultOptions().queries?.staleTime,
  ).toBe(123);
  alice.clear();
  bob.clear();
});
