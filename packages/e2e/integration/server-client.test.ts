import assert from "node:assert/strict";
import { expect, spyOn, test } from "bun:test";
import { createORPCClient, createRpcHttpTransport } from "kello/client";
import { createRpcHttpApp } from "kello/neon";
import type { RouterClient } from "@orpc/server";
import { os } from "@orpc/server";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { QueryClient } from "@tanstack/react-query";
import type { ProcedureContext } from "kello/server";
import type { RpcCallContext } from "kello/client";
import { z } from "zod";

test("SSR fetch transport preserves native options and per-request identity without browser Origin", async () => {
  const router = {
    read: os
      .$context<ProcedureContext>()
      .input(z.string())
      .handler(({ context, input }) => ({
        owner: context.identity?.subject,
        operation: context.operation,
        input,
        at: new Date("2026-01-01"),
      })),
  };
  const app = createRpcHttpApp({
    router,
    version: "a".repeat(64),
    origins: [],
    verify: async (token) => ({ identity: { subject: token, issuer: "test" }, expiresAt: Date.now() / 1000 + 60 }),
  });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => app.fetch(request) });
  const first = createRpcHttpTransport({
    url: server.url.origin,
    version: "a".repeat(64),
    getToken: async () => "alice",
  });
  const second = createRpcHttpTransport({
    url: server.url.origin,
    version: "a".repeat(64),
    getToken: async () => "bob",
  });
  const cache = new QueryClient();
  try {
    const alice = createORPCClient<RouterClient<typeof router, RpcCallContext>>(first.link);
    const bob = createORPCClient<RouterClient<typeof router, RpcCallContext>>(second.link);
    const rpc = createTanstackQueryUtils(alice);
    const [a, b] = await Promise.all([cache.query(rpc.read.queryOptions({ input: "hello" })), bob.read("hello")]);
    expect(a.owner).toBe("alice");
    expect(a.operation).toBe("query");
    expect(a.at).toBeInstanceOf(Date);
    expect(b.owner).toBe("bob");
    expect(b.operation).toBe("call");
    first.dispose();
    await assert.rejects(alice.read("closed"));
  } finally {
    first.dispose();
    second.dispose();
    cache.clear();
    await server.stop(true);
  }
});

test("SSR cancellation interrupts pending credentials without sending a request", async () => {
  for (const cancellation of ["caller", "dispose"] as const) {
    const token = Promise.withResolvers<string | null>();
    const transport = createRpcHttpTransport({
      url: "http://127.0.0.1:1",
      version: "a".repeat(64),
      getToken: () => token.promise,
    });
    const abort = new AbortController();
    const pending = transport.link.call(["read"], undefined, { context: {}, signal: abort.signal });
    if (cancellation === "caller") abort.abort(new Error("Stop request"));
    else transport.dispose();
    try {
      expect(
        await Promise.race([
          pending.then(
            () => "completed",
            () => "cancelled",
          ),
          Bun.sleep(100).then(() => "pending"),
        ]),
      ).toBe("cancelled");
    } finally {
      token.resolve(null);
      transport.dispose();
      await pending.catch(() => undefined);
    }
  }
});

test("ordinary async-iterator procedures stream over HTTP and finalize on cancellation", async () => {
  const finalized = Promise.withResolvers<void>();
  const router = {
    count: os.$context<ProcedureContext>().handler(async function* () {
      try {
        for (let index = 0; ; index++) {
          yield index;
          await Bun.sleep(5);
        }
      } finally {
        finalized.resolve();
      }
    }),
  };
  const app = createRpcHttpApp({
    router,
    version: "a".repeat(64),
    origins: [],
    verify: async (token) => ({ identity: { subject: token, issuer: "test" }, expiresAt: Date.now() / 1000 + 60 }),
  });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => app.fetch(request) });
  const transport = createRpcHttpTransport({
    url: server.url.origin,
    version: "a".repeat(64),
    getToken: async () => "alice",
  });
  try {
    const client = createORPCClient<RouterClient<typeof router, RpcCallContext>>(transport.link);
    const received: number[] = [];
    for await (const value of await client.count()) {
      received.push(value);
      if (received.length === 3) break;
    }
    expect(received).toEqual([0, 1, 2]);
    expect(await Promise.race([finalized.promise.then(() => "finalized"), Bun.sleep(1_000).then(() => "open")])).toBe(
      "finalized",
    );
  } finally {
    transport.dispose();
    await server.stop(true);
  }
});

// Characterize the inherited total stream deadline without waiting thirty seconds.
test("ordinary HTTP iterators retain the client 30-second deadline and finalize on expiry", async () => {
  const deadline = new AbortController();
  const timeout = spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
    expect(milliseconds).toBe(30_000);
    return deadline.signal;
  });
  const finalized = Promise.withResolvers<void>();
  const router = {
    count: os.$context<ProcedureContext>().handler(async function* () {
      try {
        for (let index = 0; ; index++) {
          yield index;
          await Bun.sleep(5);
        }
      } finally {
        finalized.resolve();
      }
    }),
  };
  const app = createRpcHttpApp({
    router,
    version: "a".repeat(64),
    origins: [],
    verify: async () => ({ identity: { subject: "alice", issuer: "test" }, expiresAt: Date.now() / 1000 + 60 }),
  });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => app.fetch(request) });
  const transport = createRpcHttpTransport({
    url: server.url.origin,
    version: "a".repeat(64),
    getToken: async () => "alice",
  });
  try {
    const client = createORPCClient<RouterClient<typeof router, RpcCallContext>>(transport.link);
    const iterator = await client.count();
    expect((await iterator.next()).value).toBe(0);
    expect(timeout).toHaveBeenCalledWith(30_000);
    deadline.abort(new DOMException("Deadline exceeded", "TimeoutError"));
    await assert.rejects(iterator.next());
    expect(await Promise.race([finalized.promise.then(() => "finalized"), Bun.sleep(1_000).then(() => "open")])).toBe(
      "finalized",
    );
  } finally {
    timeout.mockRestore();
    transport.dispose();
    await server.stop(true);
  }
});
