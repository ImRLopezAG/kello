import { expect, test } from "vite-plus/test";
import { QueryClient, dehydrate } from "@tanstack/react-query";
import { withKelloServerSession } from "kello/client";
import { encodeHydration, decodeHydration } from "../../../apps/kello/src/core/client/hydration";
import { createAuthLifecycle } from "../../../apps/kello/src/core/client/auth-lifecycle";

test("SSR requests own disjoint caches and dispose after success or callback failure", async () => {
  const disposed: string[] = [];
  const create = (options: { cachePrefix: string; getToken: () => Promise<string | null> }) => ({
    dispose() {
      disposed.push(options.cachePrefix);
    },
    async verifySession() {
      return { key: (await options.getToken())!, expiresAt: Date.now() / 1000 + 3600 };
    },
  });
  const read = (token: string) =>
    withKelloServerSession(
      create,
      { url: "https://service.test", getToken: async () => token },
      async ({ queryClient, dehydrate }) => {
        const prefix = dehydrate().cachePrefix;
        queryClient.setQueryData([prefix, "notes"], [token]);
        return dehydrate();
      },
    );
  const [a, b] = await Promise.all([read("alice"), read("bob")]);
  expect(a!.cachePrefix).not.toBe(b!.cachePrefix);
  expect(JSON.parse(a!.state).json.queries[0].state.data).toEqual(["alice"]);
  expect(JSON.parse(b!.state).json.queries[0].state.data).toEqual(["bob"]);
  expect(disposed).toHaveLength(2);
  await expect(
    withKelloServerSession(create, { url: "https://service.test", getToken: async () => "alice" }, async () => {
      throw new Error("prefetch failed");
    }),
  ).rejects.toThrow("prefetch failed");
  expect(disposed).toHaveLength(3);
  expect(
    await withKelloServerSession(create, { url: "https://service.test", getToken: async () => null }, async () => {
      throw new Error("unreachable");
    }),
  ).toBeNull();
});

test("SSR abort tears down a blocked request without waiting for its callback", async () => {
  const controller = new AbortController();
  let disposed = false;
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const request = withKelloServerSession(
    () => ({
      dispose() {
        disposed = true;
      },
      async verifySession() {
        return { key: "alice", expiresAt: Date.now() / 1000 + 3600 };
      },
    }),
    { url: "https://service.test", getToken: async () => "token", signal: controller.signal },
    async () => {
      entered();
      return new Promise<void>(() => {});
    },
  );
  await ready;
  controller.abort(new Error("request closed"));
  await expect(request).rejects.toThrow("request closed");
  expect(disposed).toBe(true);
});

test("hydration scope is retained only for the same server-verified identity", async () => {
  for (const identity of ["alice", "bob"]) {
    const cachePrefix = `loom:${crypto.randomUUID()}`;
    const cleared: string[] = [];
    const opened: string[] = [];
    const lifecycle = createAuthLifecycle({
      hydration: {
        session: { key: "alice", expiresAt: Date.now() / 1000 + 3600 },
        cachePrefix,
        state: encodeHydration({ queries: [], mutations: [] }),
      },
      url: "https://service.test",
      auth: { getToken: async () => "token" },
      createClient(options) {
        opened.push(options.cachePrefix);
        return {
          dispose() {},
          async verifySession() {
            return { key: identity, expiresAt: Date.now() / 1000 + 3600 };
          },
        };
      },
      onConnection() {},
      clearCache(prefix) {
        cleared.push(prefix);
      },
    });
    await lifecycle.refresh();
    if (identity === "alice") {
      expect(cleared).toEqual([]);
      expect(opened).toEqual([cachePrefix]);
    } else {
      expect(cleared).toEqual([cachePrefix]);
      expect(opened[1]).not.toBe(cachePrefix);
    }
    lifecycle.dispose();
  }
});

test("hydration rejects forged hashes and foreign cache entries", () => {
  const client = new QueryClient();
  client.setQueryData(["foreign"], 42);
  const state = dehydrate(client);
  expect(() => decodeHydration(JSON.stringify({ json: state }), "loom:owned")).toThrow("outside");
  state.queries[0]!.queryKey = ["loom:owned"];
  expect(() => decodeHydration(JSON.stringify({ json: state }), "loom:owned")).toThrow("outside");
});

test("hydration preserves oRPC dates and bigints through a serializable payload", () => {
  const client = new QueryClient();
  const prefix = "loom:scope";
  const data = { at: new Date("2026-09-26T12:00:00Z"), count: 42n };
  client.setQueryData([prefix, "data"], data);
  const restored = decodeHydration(encodeHydration(dehydrate(client)), prefix);
  expect(restored.queries[0]!.state.data).toEqual(data);
});

test("persisted paused mutations cannot enter a new provider through hydration", () => {
  const client = new QueryClient();
  const prefix = `loom:${crypto.randomUUID()}`;
  client.getMutationCache().build(
    client,
    { mutationKey: [prefix, "update"] },
    {
      context: { previous: "private optimistic data" },
      data: undefined,
      error: null,
      failureCount: 0,
      failureReason: null,
      isPaused: true,
      status: "pending",
      variables: { title: "private update" },
      submittedAt: Date.now(),
    },
  );
  const state = dehydrate(client);
  expect(state.mutations).toHaveLength(1);
  expect(() => decodeHydration(encodeHydration(state), prefix)).toThrow();
  client.clear();
});
