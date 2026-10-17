import assert from "node:assert/strict";
import { test } from "bun:test";
import type { ComponentHttpMount } from "kello/server";
import { startHttpHandlerServer } from "../fixtures/http-handler-server";
import type { HttpFixtureRuntime } from "../fixtures/http-handler-server";

test("HTTP adapter serves scoped component HTTP with the production access policies", async () => {
  let handled = 0;
  let stopped = 0;
  const componentHttp: ComponentHttpMount[] = [
    {
      prefix: "/api/components/identity",
      routes: [
        {
          method: "POST",
          path: "/event",
          access: {
            kind: "signed-webhook",
            verify: ({ body, request }) => {
              assert.equal(new TextDecoder().decode(body), "original bytes");
              if (request.headers.get("signature") !== "valid") throw new Error("Invalid signature");
            },
          },
          handle: () => {
            handled++;
            return new Response(null, { status: 204 });
          },
        },
        {
          method: "GET",
          path: "/private",
          access: { kind: "verified-user", authorize: (session) => session.identity.subject === "alice" },
          handle: () => new Response("alice"),
        },
      ],
    },
  ];
  const runtime: HttpFixtureRuntime & { componentHttp: ComponentHttpMount[] } = {
    componentHttp,
    auth: {
      origins: [],
      allowAnonymous: true,
      verify: async (token) => ({
        identity: { issuer: "fixture", subject: token },
        expiresAt: Date.now() / 1000 + 60,
      }),
    },
    router: {},
    version: "a".repeat(64),
    stop: async () => {
      stopped++;
    },
  };
  const server = await startHttpHandlerServer(runtime);
  try {
    const send = (signature: string) =>
      fetch(new URL("/api/components/identity/event", server.url), {
        method: "POST",
        body: "original bytes",
        headers: { signature },
      });
    assert.equal((await send("invalid")).status, 401);
    assert.equal(handled, 0);
    assert.equal((await send("valid")).status, 204);
    assert.equal(handled, 1);
    const privateUrl = new URL("/api/components/identity/private", server.url);
    assert.equal((await fetch(privateUrl)).status, 401);
    assert.equal((await fetch(privateUrl, { headers: { authorization: "Bearer bob" } })).status, 403);
    assert.equal(await (await fetch(privateUrl, { headers: { authorization: "Bearer alice" } })).text(), "alice");
    assert.equal((await fetch(new URL("/api/kello/internal/identity", server.url))).status, 404);
  } finally {
    await server.stop();
  }
  assert.equal(stopped, 1);
});
