import { expect, test } from "bun:test";
import { os } from "@orpc/server";
import type { RouterClient } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { RPCLink } from "@orpc/client/fetch";
import { createORPCClient, RPCSerializer } from "@orpc/client";
import { dehydrate, hydrate, QueryClient, QueryObserver } from "@tanstack/react-query";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";

test("SSR consumes one finite native snapshot and hydration attaches one live stream", async () => {
  let calls = 0;
  let closed = 0;
  const snapshot = () => ({ at: new Date("2026-09-24"), count: 1n });
  const router = {
    snapshot: os.handler(snapshot),
    read: os.handler(async function* ({ signal }) {
      calls++;
      try {
        yield snapshot();
        await new Promise<void>((resolve) => {
          if (signal?.aborted) resolve();
          else signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      } finally {
        closed++;
      }
    }),
  };
  const serializer = new RPCSerializer({ omitUndefinedProperties: false });
  const handler = new RPCHandler(router, { serializer });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const result = await handler.handle(request);
      return result.response ?? new Response(null, { status: 404 });
    },
  });
  function session() {
    const queryClient = new QueryClient();
    const raw = createORPCClient<RouterClient<typeof router>>(new RPCLink({ origin: server.url.origin, serializer }));
    return { queryClient, rpc: createTanstackQueryUtils(raw) };
  }
  const ssr = session();
  const browser = session();
  try {
    const value = await ssr.queryClient.query(
      ssr.rpc.snapshot.queryOptions({ queryKey: ssr.rpc.read.liveOptions().queryKey }),
    );
    expect(value).toEqual({ at: new Date("2026-09-24"), count: 1n });
    // Use the native serializer for hydration too; plain JSON loses bigint/Date.
    const serialized = JSON.stringify(serializer.serializeJson(dehydrate(ssr.queryClient)));
    // SAFETY: this fixture round-trips the state just produced by dehydrate above.
    const state = serializer.deserializeJson(JSON.parse(serialized)) as ReturnType<typeof dehydrate>;
    hydrate(browser.queryClient, state);
    ssr.queryClient.clear();
    expect(closed).toBe(0);
    expect(calls).toBe(0);
    const first = new QueryObserver(browser.queryClient, browser.rpc.read.liveOptions({ retry: false }));
    const second = new QueryObserver(browser.queryClient, browser.rpc.read.liveOptions({ retry: false }));
    expect(first.getCurrentResult().data).toEqual(value);
    const stopOne = first.subscribe(() => {});
    const stopTwo = second.subscribe(() => {});
    for (let attempt = 0; attempt < 20 && calls !== 1; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls).toBe(1);
    expect(second.getCurrentResult().data).toEqual(value);
    stopOne();
    stopTwo();
  } finally {
    ssr.queryClient.clear();
    browser.queryClient.clear();
    await server.stop(true);
  }
}, 5000);
