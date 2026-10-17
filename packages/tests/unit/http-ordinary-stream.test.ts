import { expect, test } from "vite-plus/test";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { eventIterator } from "kello/contract";
import { createProjectProcedures, defineSchema } from "kello/server";
import { createRpcHttpApp } from "kello/neon";
import * as v from "valibot";

test("ordinary HTTP RPC streams values and finalizes on cancellation without sockets or live issuance", async () => {
  const { procedure } = createProjectProcedures(defineSchema(() => ({})));
  const cleaned = Promise.withResolvers<void>();
  const router = {
    read: procedure.handler(({ context }) => context.identity?.subject),
    stream: procedure.output(eventIterator(v.string())).handler(async function* ({ context }) {
      try {
        yield "ready";
        if (!context.signal.aborted)
          await new Promise<void>((resolve) =>
            context.signal.addEventListener("abort", () => resolve(), { once: true }),
          );
      } finally {
        cleaned.resolve();
      }
    }),
  };
  const version = "a".repeat(64);
  const app = createRpcHttpApp({
    router,
    version,
    origins: ["https://app.test"],
    verify: async () => ({ identity: { issuer: "fixture", subject: "alice" }, expiresAt: Date.now() / 1000 + 60 }),
  });
  const paths: string[] = [];
  const client = createORPCClient<RouterClient<typeof router>>(
    new RPCLink({
      origin: "https://service.test",
      url: "/api/kello/rpc",
      headers: {
        authorization: "Bearer fixture",
        origin: "https://app.test",
        "x-loom-version": version,
        "x-loom-protocol": "loom-orpc-2",
      },
      fetch: async (input, init) => {
        const request = new Request(input, init);
        paths.push(new URL(request.url).pathname);
        return app.fetch(request);
      },
    }),
  );
  expect(await client.read()).toBe("alice");
  const controller = new AbortController();
  const stream = await client.stream(undefined, { signal: controller.signal });
  try {
    expect(await stream.next()).toEqual({ done: false, value: "ready" });
    controller.abort();
    await cleaned.promise;
    expect(paths).toEqual(["/api/kello/rpc/read", "/api/kello/rpc/stream"]);
  } finally {
    controller.abort();
    await stream.return().catch(() => {});
  }
});
