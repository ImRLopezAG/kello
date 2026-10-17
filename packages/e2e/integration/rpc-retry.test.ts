import assert from "node:assert/strict";
import { test } from "bun:test";
import { createORPCClient } from "@orpc/client";
import type { RouterClient } from "@orpc/server";
import { QueryClient, MutationObserver } from "@tanstack/react-query";
import { createRpcHttpTransport } from "kello/client";
import { createProjectProcedures, defineSchema } from "kello/server";
import { createRpcHttpApp } from "kello/neon";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import type { RpcCallContext } from "kello/client";

test("explicit native retries carry one intent through HTTP headers after an uncertain write", async () => {
  const { procedure } = createProjectProcedures(defineSchema(() => ({})));
  const keys: string[] = [];
  const committed = new Map<string, number>();
  const router = {
    write: procedure.handler(({ context }) => {
      const key = context.idempotencyKey;
      assert.ok(key);
      keys.push(key);
      const prior = committed.get(key);
      if (prior !== undefined) return prior;
      committed.set(key, committed.size + 1);
      // Simulates a failure after an external write; the retry must keep its intent.
      throw new Error("Response unavailable after commit");
    }),
  };
  const version = "a".repeat(64);
  const app = createRpcHttpApp({
    router,
    version,
    origins: [],
    verify: async () => ({ identity: { issuer: "test", subject: "alice" }, expiresAt: Date.now() / 1000 + 60 }),
  });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => app.fetch(request) });
  const transport = createRpcHttpTransport({
    url: server.url.href,
    version: "a".repeat(64),
    getToken: async () => "fixture",
  });
  const queryClient = new QueryClient();
  const raw = createORPCClient<RouterClient<typeof router, RpcCallContext>>(transport.link);
  const rpc = createTanstackQueryUtils(raw);
  try {
    const options = () =>
      rpc.write.mutationOptions({ context: { idempotencyKey: crypto.randomUUID() }, retry: 1, retryDelay: 1 });
    const observer = new MutationObserver(queryClient, options());
    assert.equal(await observer.mutate(undefined), 1);
    observer.setOptions(options());
    assert.equal(await observer.mutate(undefined), 2);
    assert.equal(keys.length, 4);
    assert.equal(keys[0], keys[1]);
    assert.equal(keys[2], keys[3]);
    assert.notEqual(keys[0], keys[2]);
    assert.equal(committed.size, 2);
    await assert.rejects(transport.link.call(["write"], undefined, { context: { idempotencyKey: "invalid" } }));
    assert.equal(keys.length, 4);
  } finally {
    queryClient.clear();
    transport.dispose();
    await server.stop(true);
  }
});
