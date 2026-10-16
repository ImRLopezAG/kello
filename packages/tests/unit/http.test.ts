import { expect, test } from "vite-plus/test";
import { createRpcHttpApp } from "kello/neon";
import type { RpcHttpOptions } from "kello/neon";
import { AuthenticationError, createProjectProcedures, defineSchema } from "kello/server";
import * as v from "valibot";
const version = "a".repeat(64);
const { procedure } = createProjectProcedures(defineSchema(() => ({})));
import { originPolicy } from "../../../apps/kello/src/core/server/auth/policy";

test("origin policy matches exact canonical origins and permits originless server calls", () => {
  const allows = originPolicy(["https://app.example.test", "http://localhost:3000"]);
  expect(allows(null)).toBe(true);
  expect(allows("https://app.example.test")).toBe(true);
  for (const origin of [
    "null",
    "https://app.example.test.evil",
    "https://app.example.test/path",
    "http://localhost:3001",
  ])
    expect(allows(origin)).toBe(false);
  for (const origin of ["https://user:secret@app.example.test", "https://app.example.test/", "http://app.example.test"])
    expect(() => originPolicy([origin])).toThrow();
});

test("connection ticket issuance requires authentication even when calls permit anonymous users", async () => {
  let issued = 0;
  const options: RpcHttpOptions = {
    router: { read: procedure.handler(() => null) },
    version,
    verify: async () => ({
      identity: { issuer: "test", subject: "alice" },
      expiresAt: Math.floor(Date.now() / 1000) + 60,
    }),
    allowAnonymous: true,
    origins: ["https://app.example.test"],
    tickets: {
      issue: async () => {
        issued++;
        throw new AuthenticationError();
      },
    },
  };
  const app = createRpcHttpApp(options);
  const request = (path: string, init: RequestInit) => app.fetch(new Request(`https://api.example.test${path}`, init));
  const headers = {
    "content-type": "application/json",
    origin: "https://app.example.test",
    "x-loom-protocol": "loom-orpc-2",
    "x-loom-version": version,
  };
  expect((await request("/api/kello/ticket", { method: "POST", headers, body: "{}" })).status).toBe(401);
  expect(issued).toBe(0);
  expect(
    (
      await request("/api/kello/ticket", {
        method: "POST",
        headers: { ...headers, authorization: "Bearer token" },
        body: "{}",
      })
    ).status,
  ).toBe(500);
  expect(issued).toBe(1);
  const preflight = await request("/api/kello/ticket", {
    method: "OPTIONS",
    headers: {
      origin: headers.origin,
      "access-control-request-method": "POST",
      "access-control-request-headers": "authorization,content-type",
    },
  });
  expect(preflight.status).toBe(204);
  expect(issued).toBe(1);
});

test("HTTP guards bound body reads, reject forged envelopes, and cancel stalled streams", async () => {
  let calls = 0;
  let cancelled = false;
  const options: RpcHttpOptions = {
    router: {
      read: procedure.input(v.null()).handler(() => {
        calls++;
        return null;
      }),
    },
    version,
    verify: async () => ({
      identity: { issuer: "test", subject: "alice" },
      expiresAt: Math.floor(Date.now() / 1000) + 60,
    }),
    origins: ["https://app.example.test"],
    maxRequestBytes: 1024,
  };
  const app = createRpcHttpApp(options);
  const request = (path: string, init: RequestInit) => app.fetch(new Request(`https://api.example.test${path}`, init));
  const payload = { json: null };
  const headers = {
    "content-type": "application/json",
    authorization: "Bearer token",
    "x-loom-protocol": "loom-orpc-2",
    "x-loom-version": version,
    origin: "https://app.example.test",
  };
  const post = (body: string, extra: Readonly<Record<string, string>> = {}) =>
    request("/api/kello/rpc/read", { method: "POST", headers: { ...headers, ...extra }, body });
  expect((await post(JSON.stringify(payload))).status).toBe(200);
  expect((await post(JSON.stringify({ json: { identity: { subject: "other" } } }))).status).toBe(400);
  expect((await post("{")).status).toBe(400);
  expect((await post(JSON.stringify(payload), { "x-loom-protocol": "unknown" })).status).toBe(409);
  expect((await post("x".repeat(1025), { "content-length": "1" })).status).toBe(413);
  expect((await post(JSON.stringify(payload), { authorization: "Basic token" })).status).toBe(401);
  expect(
    (await post(JSON.stringify(payload), { origin: "https://attacker.test" })).headers.has(
      "access-control-allow-origin",
    ),
  ).toBe(false);
  expect(calls).toBe(1);
  const verified = Promise.withResolvers<void>();
  const expiring = createRpcHttpApp({
    ...options,
    verify: async () => {
      verified.resolve();
      return { identity: { issuer: "test", subject: "alice" }, expiresAt: Date.now() / 1000 + 0.02 };
    },
  });
  let expiryCancelled = false;
  const delayed = new ReadableStream<Uint8Array>({
    cancel() {
      expiryCancelled = true;
    },
    async start(controller) {
      await verified.promise;
      await new Promise((resolve) => setTimeout(resolve, 40));
      if (expiryCancelled) return;
      controller.enqueue(new TextEncoder().encode(JSON.stringify(payload)));
      controller.close();
    },
  });
  expect(
    (
      await expiring.fetch(
        new Request("https://api.example.test/api/kello/rpc/read", {
          method: "POST",
          headers,
          body: delayed,
          duplex: "half",
        }),
      )
    ).status,
  ).toBe(401);
  expect(calls).toBe(1);
  expect(expiryCancelled).toBe(true);
  const preflight = await request("/api/kello/rpc/read", {
    method: "OPTIONS",
    headers: {
      origin: headers.origin,
      "access-control-request-method": "POST",
      "access-control-request-headers": "authorization, content-type",
    },
  });
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get("access-control-allow-origin")).toBe(headers.origin);
  expect(preflight.headers.has("access-control-allow-credentials")).toBe(false);
  const timeoutApp = createRpcHttpApp({ ...options, requestTimeoutMs: 20 });
  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
  });
  const stalled = new Request("https://api.example.test/api/kello/rpc/read", {
    method: "POST",
    headers,
    body: stream,
    duplex: "half",
  });
  const response = await timeoutApp.fetch(stalled);
  expect(response.status).toBe(504);
  expect(cancelled).toBe(true);
  expect(calls).toBe(1);
});

test("session introspection derives identity scope from verified claims and refuses stale clients", async () => {
  let subject = "alice";
  let tenantId = "one";
  let calls = 0;
  const app = createRpcHttpApp({
    router: {
      read: procedure.handler(() => {
        calls++;
        return null;
      }),
    },
    version,
    origins: ["https://app.example.test"],
    allowAnonymous: true,
    verify: async () => ({ identity: { issuer: "trusted", subject, tenantId }, expiresAt: Date.now() / 1000 + 60 }),
  });
  const request = (extra: Record<string, string> = {}) =>
    app.fetch(
      new Request("https://api.example.test/api/kello/session", {
        method: "POST",
        headers: {
          authorization: "Bearer token",
          "x-loom-protocol": "loom-orpc-2",
          "x-loom-version": version,
          ...extra,
        },
      }),
    );
  const first = await request();
  expect(first.headers.get("cache-control")).toBe("no-store");
  const schema = v.object({ key: v.string(), expiresAt: v.number() });
  const alice = v.parse(schema, await first.json());
  expect(await (await request()).json()).toMatchObject({ key: alice.key });
  tenantId = "two";
  expect(v.parse(schema, await (await request()).json()).key).not.toBe(alice.key);
  subject = "bob";
  expect(v.parse(schema, await (await request()).json()).key).not.toBe(alice.key);
  expect((await request({ "x-loom-version": "b".repeat(64) })).status).toBe(409);
  expect((await request({ authorization: "" })).status).toBe(401);
  expect((await request({ origin: "https://evil.test" })).status).toBe(403);
  expect(calls).toBe(0);
});
