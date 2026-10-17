import { expect, test } from "vite-plus/test";
import { createProjectProcedures, defineSchema } from "kello/server";
import { createNeonRpcApplication } from "kello/neon";

const version = "a".repeat(64);
const { procedure } = createProjectProcedures(defineSchema(() => ({})));

test("application shutdown aborts and drains HTTP calls and refuses new work", async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let aborted = false;
  const app = await createNeonRpcApplication({
    version,
    origins: [],
    allowAnonymous: true,
    verify: async () => {
      throw new Error("Anonymous test");
    },
    router: {
      read: procedure.handler(async ({ context: { signal } }) => {
        signal?.addEventListener(
          "abort",
          () => {
            aborted = true;
          },
          { once: true },
        );
        started.resolve();
        await release.promise;
        return null;
      }),
    },
  });
  const request = new Request("https://api.example.test/api/kello/rpc/read", {
    method: "POST",
    headers: { "content-type": "application/json", "x-loom-protocol": "loom-orpc-2", "x-loom-version": version },
    body: JSON.stringify({ json: null }),
  });
  const pending = app.fetch(request);
  await started.promise;
  let drained = false;
  const stopping = app.stop().then(() => {
    drained = true;
  });
  expect(aborted).toBe(true);
  expect((await app.fetch(new Request("https://api.example.test/api/kello/rpc/read"))).status).toBe(503);
  await Promise.resolve();
  expect(drained).toBe(false);
  release.resolve();
  await pending;
  await stopping;
  expect(drained).toBe(true);
  await app.stop();
});

test("application refuses retired socket routes and stops idempotently", async () => {
  const app = await createNeonRpcApplication({
    version,
    origins: ["https://app.example.test"],
    verify: async () => {
      throw new Error("Not used");
    },
    router: {
      read: procedure.handler(() => {
        throw new Error("Socket requests must not dispatch HTTP calls");
      }),
    },
  });
  expect((await app.fetch(new Request("https://api.example.test/api/kello/socket"))).status).toBe(404);
  await app.stop();
  expect(app.stop()).toBe(app.stop());
});
