import * as v from "valibot";
import { expect, test } from "vite-plus/test";
import { createComponentHttpApp } from "../../../apps/kello/src/core/adapters/neon/component-http";
import { validateComponentHttpMounts } from "../../../apps/kello/src/core/server/components/http";

const anonymous = { kind: "anonymous" as const };
test("external health needs no Kello protocol and rejects reserved or overlapping ownership", async () => {
  const app = createComponentHttpApp({
    mounts: [
      {
        prefix: "/health",
        routes: [{ method: "GET", path: "/", access: anonymous, handle: async () => Response.json({ ok: true }) }],
      },
    ],
  });
  expect((await app.fetch(new Request("https://api.test/health"))).status).toBe(200);
  for (const prefix of [
    "/api",
    "/api/kello",
    "/api/kello/socket",
    "/api/auth",
    "/api/auth/session",
    "/*",
    "/x/../health",
  ]) {
    expect(() => validateComponentHttpMounts([{ prefix, routes: [] }])).toThrow();
  }
  expect(() =>
    validateComponentHttpMounts([
      { prefix: "/x", routes: [] },
      { prefix: "/x", routes: [] },
    ]),
  ).toThrow();
});

test("webhook verification sees exact bytes before acquiring context and rejects changed/expired/oversized bodies", async () => {
  let writes = 0;
  let acquisitions = 0;
  const original = '{ "id": "one" }\n';
  const seen = new Set<string>();
  const app = createComponentHttpApp({
    mounts: [
      {
        prefix: "/hooks",
        invoke: async (_invocation, work) => {
          acquisitions++;
          return work({});
        },
        routes: [
          {
            method: "POST",
            path: "/event",
            maxRequestBytes: 64,
            access: {
              kind: "signed-webhook",
              verify: async ({ body, request }) => {
                if (new TextDecoder().decode(body) !== original || request.headers.get("signature") !== "valid")
                  throw new Error("invalid");
              },
            },
            handle: async ({ request }) => {
              const event = v.parse(v.object({ id: v.string() }), await request.json());
              // Durable deduplication belongs to the component transaction, not ingress.
              if (!seen.has(event.id)) {
                seen.add(event.id);
                writes++;
              }
              return new Response(null, { status: 204 });
            },
          },
        ],
      },
    ],
  });
  const send = (body: string, signature = "valid") =>
    app.fetch(new Request("https://api.test/hooks/event", { method: "POST", headers: { signature }, body }));
  expect((await send(original)).status).toBe(204);
  expect((await send(original)).status).toBe(204);
  expect((await send(original.trim())).status).toBe(401);
  expect((await send(original, "expired")).status).toBe(401);
  expect((await send("x".repeat(65))).status).toBe(413);
  expect(writes).toBe(1);
  expect(acquisitions).toBe(2);
});

test("missing policy and wildcard routes are rejected before serving", () => {
  for (const route of [
    { method: "GET", path: "/", handle: () => new Response() },
    { method: "GET", path: "/*", access: anonymous, handle: () => new Response() },
  ]) {
    // SAFETY: deliberately malformed JavaScript input proves runtime rejection of invalid declarations.
    expect(() => validateComponentHttpMounts([{ prefix: "/hooks", routes: [route as never] }])).toThrow();
  }
});

test("verified-user route authorizes before component acquisition and propagates cancellation", async () => {
  let acquired = 0;
  const app = createComponentHttpApp({
    verify: async () => ({ identity: { issuer: "issuer", subject: "alice" }, expiresAt: Date.now() / 1000 + 60 }),
    mounts: [
      {
        prefix: "/private",
        invoke: async (_invocation, work) => {
          acquired++;
          return work({});
        },
        routes: [
          {
            method: "GET",
            path: "/",
            requestTimeoutMs: 10,
            access: { kind: "verified-user", authorize: (_session, request) => request.headers.get("allow") === "yes" },
            handle: ({ signal }) =>
              new Promise<Response>((resolve) =>
                signal.addEventListener("abort", () => resolve(new Response()), { once: true }),
              ),
          },
        ],
      },
    ],
  });
  expect((await app.fetch(new Request("https://api.test/private"))).status).toBe(401);
  expect(
    (await app.fetch(new Request("https://api.test/private", { headers: { authorization: "Bearer token" } }))).status,
  ).toBe(403);
  expect(acquired).toBe(0);
  expect(
    (
      await app.fetch(
        new Request("https://api.test/private", { headers: { authorization: "Bearer token", allow: "yes" } }),
      )
    ).status,
  ).toBe(504);
  expect(acquired).toBe(1);
});

test("route origins govern preflight and requests without broad middleware", async () => {
  const app = createComponentHttpApp({
    mounts: [
      {
        prefix: "/external",
        routes: [
          {
            method: "POST",
            path: "/",
            access: anonymous,
            origins: ["https://app.test"],
            handle: () => new Response("ok"),
          },
        ],
      },
    ],
  });
  const preflight = (origin: string, method = "POST") =>
    app.fetch(
      new Request("https://api.test/external", {
        method: "OPTIONS",
        headers: {
          origin,
          "access-control-request-method": method,
          "access-control-request-headers": "content-type",
        },
      }),
    );
  expect((await preflight("https://app.test")).status).toBe(204);
  expect((await preflight("https://attacker.test")).status).toBe(403);
  expect((await preflight("https://app.test", "DELETE")).status).toBe(404);
  expect(
    (
      await app.fetch(
        new Request("https://api.test/external", { method: "POST", headers: { origin: "https://attacker.test" } }),
      )
    ).status,
  ).toBe(403);
  expect((await app.fetch(new Request("https://api.test/api/kello/socket"))).status).toBe(404);
});

test("component handlers may return immutable redirect and fetched responses", async () => {
  const app = createComponentHttpApp({
    mounts: [
      {
        prefix: "/immutable",
        routes: [
          {
            method: "GET",
            path: "/redirect",
            access: anonymous,
            handle: () => Response.redirect("https://destination.test", 307),
          },
          { method: "GET", path: "/fetch", access: anonymous, handle: () => fetch("data:text/plain,streamed-body") },
        ],
      },
    ],
  });
  const redirect = await app.fetch(new Request("https://api.test/immutable/redirect"));
  expect(redirect.status).toBe(307);
  expect(redirect.headers.get("location")).toBe("https://destination.test/");
  expect(redirect.headers.get("cache-control")).toBe("no-store");
  const fetched = await app.fetch(new Request("https://api.test/immutable/fetch"));
  expect(fetched.status).toBe(200);
  expect(fetched.headers.get("content-type")).toBe("text/plain");
  expect(await fetched.text()).toBe("streamed-body");
});

test("nested component prefixes compose exact routes and reject full-path collisions", async () => {
  const route = { method: "GET" as const, path: "/health", access: anonymous, handle: () => new Response("healthy") };
  const mounts = [
    { prefix: "/api/components/parent", routes: [route] },
    { prefix: "/api/components/parent/child", routes: [route] },
  ];
  const app = createComponentHttpApp({ mounts });
  for (const mount of mounts)
    expect((await app.fetch(new Request(`https://api.test${mount.prefix}/health`))).status).toBe(200);
  expect(() =>
    validateComponentHttpMounts([
      { prefix: "/api/components/parent", routes: [{ ...route, path: "/child/health" }] },
      mounts[1]!,
    ]),
  ).toThrow("Duplicate component HTTP route");
});
