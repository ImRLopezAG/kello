import { expect, test } from "vite-plus/test";
import { createAuthHttpApp } from "../../../apps/kello/src/core/adapters/neon/auth-http";

test("native auth preserves bytes, redirects and multiple cookies without exposing sibling paths", async () => {
  const body = '{ "signed": true }\n';
  const app = createAuthHttpApp({
    origins: ["https://app.test"],
    mounts: [
      {
        prefix: "/api/auth",
        handle: async (request) => {
          expect(await request.text()).toBe(body);
          const headers = new Headers({
            location: "https://app.test/complete",
            vary: "Cookie",
            "access-control-expose-headers": "plugin-result",
          });
          headers.append("set-cookie", "session=one; HttpOnly; Secure");
          headers.append("set-cookie", "state=two; HttpOnly; Secure");
          return new Response(null, { status: 302, headers });
        },
      },
    ],
  });
  const response = await app.fetch(
    new Request("https://api.test/api/auth/callback", {
      method: "POST",
      body,
      headers: { origin: "https://app.test" },
    }),
  );
  expect(response.status).toBe(302);
  expect(response.headers.getSetCookie()).toHaveLength(2);
  expect(response.headers.get("location")).toBe("https://app.test/complete");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("vary")).toContain("Cookie");
  expect(response.headers.get("access-control-expose-headers")).toContain("plugin-result");
  expect(response.headers.get("access-control-expose-headers")).toContain("set-auth-jwt");
  expect(response.headers.get("access-control-expose-headers")).toContain("set-auth-token");
  expect((await app.fetch(new Request("https://api.test/api/authentication"))).status).toBe(404);
});

test("auth admission rejects hostile origins, encoded paths, oversized bodies and overlapping mounts", async () => {
  let calls = 0;
  const mount = {
    prefix: "/api/auth",
    handle: async () => {
      calls++;
      return new Response("ok");
    },
  };
  expect(() => createAuthHttpApp({ origins: [], mounts: [mount, mount] })).toThrow();
  const app = createAuthHttpApp({ origins: ["https://app.test"], mounts: [mount], maxRequestBytes: 4 });
  expect(
    (await app.fetch(new Request("https://api.test/api/auth/sign-in", { headers: { origin: "https://evil.test" } })))
      .status,
  ).toBe(403);
  expect((await app.fetch(new Request("https://api.test/api/auth/%2fsecret"))).status).toBe(400);
  expect(
    (await app.fetch(new Request("https://api.test/api/auth/sign-in", { method: "POST", body: "12345" }))).status,
  ).toBe(413);
  expect(calls).toBe(0);
});

test("timed out native operations remain owned until drain completes", async () => {
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const app = createAuthHttpApp({
    origins: [],
    requestTimeoutMs: 10,
    mounts: [
      {
        prefix: "/api/auth",
        handle: async () => {
          await pending;
          return new Response("finished");
        },
      },
    ],
  });
  expect((await app.fetch(new Request("https://api.test/api/auth/session"))).status).toBe(504);
  let drained = false;
  const drain = app.drain().then(() => {
    drained = true;
  });
  await Promise.resolve();
  expect(drained).toBe(false);
  finish();
  await drain;
  expect(drained).toBe(true);
});
