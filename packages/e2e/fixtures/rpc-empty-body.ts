import assert from "node:assert/strict";
import { createRpcHttpApp } from "kello/neon";
import { createProjectProcedures, defineSchema } from "kello/server";

const version = "a".repeat(64);
const { procedure } = createProjectProcedures(defineSchema(() => ({})));
const app = createRpcHttpApp({
  router: {
    empty: procedure.handler(({ input }) => {
      assert.equal(input, undefined);
      return "no input";
    }),
  },
  version,
  origins: [],
  verify: async () => ({
    identity: { issuer: "test", subject: "alice" },
    expiresAt: Date.now() / 1000 + 60,
  }),
});

for (const length of [undefined, "0"]) {
  const headers = new Headers({
    authorization: "Bearer test",
    "x-kello-protocol": "kello-orpc-2",
    "x-kello-version": version,
  });
  if (length !== undefined) headers.set("content-length", length);
  const init: RequestInit & { duplex: "half" } = {
    method: "POST",
    headers,
    body: new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }),
    duplex: "half",
  };
  const response = await app.fetch(new Request("https://service.test/api/kello/rpc/empty", init));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { json: "no input" });
}
