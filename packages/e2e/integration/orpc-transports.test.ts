import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { QueryClient, MutationObserver } from "@tanstack/react-query";
import { createRpcHttpTransport } from "kello/client";
import { createClient } from "../fixtures/historical/client";
import type { RouterClient } from "@orpc/server";
import * as v from "valibot";
import { createProjectProcedures, defineSchema } from "kello/server";
import { createRpcHttpApp, createRpcOpenApiApp } from "kello/neon";

const version = "a".repeat(64);
const origin = "https://app.example.test";
const headers = { "x-loom-protocol": "loom-orpc-2", "x-loom-version": version, origin, authorization: "Bearer valid" };
const { procedure } = createProjectProcedures(defineSchema(() => ({})));
const router = {
  values: procedure.handler(() => ({ absent: undefined, date: new Date("2026-09-24T00:00:00Z"), count: 9n })),
  echo: procedure
    .input(v.string())
    .handler(({ input, context }) => ({ input, subject: context.identity?.subject, requestId: context.requestId })),
  missing: procedure.errors({ NOT_FOUND: {} }).handler(({ errors }) => {
    throw errors.NOT_FOUND({ message: "Missing" });
  }),
};

test("removed historical routes refuse calls without authentication or dispatch", async () => {
  const historical = await readFile(new URL("../fixtures/historical/client.js", import.meta.url));
  assert.equal(
    createHash("sha256").update(historical).digest("hex"),
    "8346b176dc200580a90e4d5dc4f4a063891ab7ae336db48ce8fb10a1caf4b241",
  );
  let authenticated = 0;
  const app = createRpcHttpApp({
    router,
    version,
    origins: [origin],
    verify: async () => {
      authenticated++;
      throw new Error("Must not authenticate retired calls");
    },
  });
  let requests = 0;
  const legacy = createClient({
    url: "https://service.test",
    getAuth: async () => ({ token: "historical", identityKey: "alice" }),
    fetch: (url, init) => {
      requests++;
      const request = new Request(url, init);
      request.headers.set("origin", origin);
      return app.fetch(request);
    },
  });
  await assert.rejects(legacy.call({ name: "tasks:list", kind: "query", visibility: "public", version }, {}), {
    code: "INVALID_RESPONSE",
  });
  await assert.rejects(legacy.ticket({ identityKey: "alice" }));
  assert.equal(requests, 2);
  for (const path of ["call", "ticket", "socket"]) {
    assert.equal(
      (
        await app.fetch(
          new Request(`https://service.test/api/kello/${path}`, {
            method: "POST",
            headers,
          }),
        )
      ).status,
      404,
    );
  }
  assert.equal(authenticated, 0);
});

test("native TanStack operations reach individual HTTP calls without altering authenticated identity", async () => {
  const operationRouter = {
    inspect: procedure.handler(({ context }) => ({ operation: context.operation, subject: context.identity?.subject })),
  };
  const app = createRpcHttpApp({
    router: operationRouter,
    version,
    origins: [],
    verify: async () => ({ identity: { issuer: "test", subject: "alice" }, expiresAt: Date.now() / 1000 + 60 }),
  });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => app.fetch(request) });
  const transport = createRpcHttpTransport({ url: server.url.origin, version, getToken: async () => "valid" });
  const client = createORPCClient<RouterClient<typeof operationRouter>>(transport.link);
  const rpc = createTanstackQueryUtils(client);
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  try {
    expect(await cache.query(rpc.inspect.queryOptions())).toEqual({ operation: "query", subject: "alice" });
    expect(await new MutationObserver(cache, rpc.inspect.mutationOptions()).mutate(undefined)).toEqual({
      operation: "mutation",
      subject: "alice",
    });
    expect(await client.inspect()).toEqual({ operation: "call", subject: "alice" });
  } finally {
    cache.clear();
    transport.dispose();
    await server.stop(true);
  }
});

test("native HTTP authenticates before dispatch and protects protocol, origin and internal paths", async () => {
  let calls = 0;
  const app = createRpcHttpApp({
    router,
    version,
    origins: [origin],
    verify: async (token) => {
      calls++;
      if (token !== "valid") throw new Error("secret verifier detail");
      return { identity: { issuer: "test", subject: "alice" }, expiresAt: Math.floor(Date.now() / 1000) + 60 };
    },
  });
  const client = createORPCClient<RouterClient<typeof router>>(
    new RPCLink({
      origin: "https://service.example.test",
      url: "/api/kello/rpc",
      headers,
      fetch: (request, init) => app.fetch(new Request(request, init)),
    }),
  );
  const first = await client.echo("hello");
  expect(await client.values()).toStrictEqual({ absent: undefined, date: new Date("2026-09-24T00:00:00Z"), count: 9n });
  expect(first.subject).toBe("alice");
  expect((await client.echo("again")).requestId).not.toBe(first.requestId);
  await assert.rejects(client.missing(), { code: "NOT_FOUND", message: "Missing" });
  for (const [patch, status] of [
    [{ origin: "https://evil.example.test" }, 403],
    [{ authorization: "Bearer forged" }, 401],
    [{ "x-loom-version": "b".repeat(64) }, 409],
    [{ "x-loom-protocol": "loom-legacy-1" }, 409],
  ] as const) {
    const response = await app.fetch(
      new Request("https://service.example.test/api/kello/rpc/echo", {
        method: "POST",
        headers: { ...headers, ...patch, "content-type": "application/json" },
        body: JSON.stringify({ json: "hello" }),
      }),
    );
    expect(response.status).toBe(status);
    expect(await response.text()).not.toContain("secret verifier detail");
  }
  expect(
    (
      await app.fetch(
        new Request("https://service.example.test/api/kello/rpc/internal/admin", { method: "POST", headers }),
      )
    ).status,
  ).toBe(404);
  expect(calls).toBe(6);
});

test("native HTTP accepts no input with an empty provider body stream", async () => {
  // Node infers text/plain for an empty string Request body; Bun does not.
  const child = Bun.spawn(["node", fileURLToPath(new URL("../fixtures/rpc-empty-body.ts", import.meta.url))], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  assert.equal(code, 0, stderr);
});

test("HTTP operation intent is validated per call and cannot replace authentication", async () => {
  let dispatched = 0;
  const operationRouter = {
    inspect: procedure.handler(({ context }) => {
      dispatched++;
      return { operation: context.operation, subject: context.identity?.subject };
    }),
  };
  const app = createRpcHttpApp({
    router: operationRouter,
    version,
    origins: [origin],
    verify: async (token) => {
      if (token !== "valid") throw new Error("Invalid token");
      return { identity: { issuer: "test", subject: "alice" }, expiresAt: Date.now() / 1000 + 60 };
    },
  });
  for (const operation of ["query", "mutation", "live", "streamed", "infinite", "call"] as const) {
    const client = createORPCClient<RouterClient<typeof operationRouter>>(
      new RPCLink({
        origin: "https://service.example.test",
        url: "/api/kello/rpc",
        headers: { ...headers, "x-loom-operation": operation },
        fetch: (request, init) => app.fetch(new Request(request, init)),
      }),
    );
    expect(await client.inspect()).toEqual({ operation, subject: "alice" });
  }
  for (const operation of ["admin", "query, mutation", "", "QUERY"]) {
    const response = await app.fetch(
      new Request("https://service.example.test/api/kello/rpc/inspect", {
        method: "POST",
        headers: { ...headers, "x-loom-operation": operation },
      }),
    );
    expect(response.status).toBe(400);
  }
  const forged = await app.fetch(
    new Request("https://service.example.test/api/kello/rpc/inspect", {
      method: "POST",
      headers: { ...headers, authorization: "Bearer forged", "x-loom-operation": "mutation" },
    }),
  );
  expect(forged.status).toBe(401);
  expect(dispatched).toBe(6);
});

test("HTTP bounds authentication waits", async () => {
  const stalled = createRpcHttpApp({
    router,
    version,
    origins: [origin],
    requestTimeoutMs: 5,
    verify: () => new Promise(() => {}),
  });
  expect(
    (await stalled.fetch(new Request("https://service.test/api/kello/rpc/echo", { method: "POST", headers }))).status,
  ).toBe(504);
});

test("OpenAPI uses the same authenticated procedure and rejects incomplete output contracts", async () => {
  const options = {
    version,
    origins: [origin],
    verify: async () => ({ identity: { issuer: "test", subject: "alice" }, expiresAt: Date.now() / 1000 + 60 }),
  };
  await assert.rejects(createRpcOpenApiApp({ ...options, router }), /explicit output schema required/);
  const rest = createProjectProcedures(defineSchema(() => ({}))).procedure;
  const app = await createRpcOpenApiApp({
    ...options,
    router: {
      who: rest
        .output(v.object({ subject: v.string() }))
        .handler(({ context }) => ({ subject: context.identity?.subject ?? "anonymous" })),
    },
  });
  const response = await app.fetch(
    new Request("https://service.test/api/kello/openapi/who", { method: "POST", headers }),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ subject: "alice" });
  expect(app.document.paths?.["/who"]).toBeDefined();
  expect(
    (
      await app.fetch(
        new Request("https://service.test/api/kello/openapi/who", {
          method: "POST",
          headers: { ...headers, authorization: "invalid" },
        }),
      )
    ).status,
  ).toBe(401);
});
