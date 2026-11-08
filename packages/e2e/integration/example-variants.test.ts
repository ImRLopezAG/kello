import assert from "node:assert/strict";
import { expect, test } from "bun:test";
import { createRpcHttpTransport } from "kello/client";
import { startIntegrationBackend } from "../fixtures/integration-examples";
const connectionString = process.env.KELLO_TEST_DATABASE_URL;
test.skipIf(!connectionString)(
  "generated examples execute Zod, Valibot and Effect contracts through authenticated RPC",
  async () => {
    if (!connectionString) throw new Error("Test database required");
    const backend = await startIntegrationBackend(connectionString, []);
    const alice = await backend.token("alice");
    const transport = createRpcHttpTransport({
      url: backend.url,
      version: backend.version,
      getToken: async () => alice,
    });
    try {
      for (const variant of ["zod", "mixed", "effect", "effectSchema"]) {
        expect(await transport.link.call(["examples", variant], { name: "Kello" }, { context: {} })).toEqual({
          message: "Hello, Kello!",
          owner: "alice",
        });
        await assert.rejects(transport.link.call(["examples", variant], { name: 123 }, { context: {} }), {
          code: "BAD_REQUEST",
        });
      }
      expect(await transport.link.call(["examples", "zod"], { name: "  Kello  " }, { context: {} })).toEqual({
        message: "Hello, Kello!",
        owner: "alice",
      });
      await assert.rejects(transport.link.call(["examples", "effect"], { name: "reject" }, { context: {} }), {
        code: "REJECTED",
      });
      expect(await transport.link.call(["examples", "notes"], undefined, { context: {} })).toEqual([]);
      for (let index = 0; index < 51; index++) {
        await transport.link.call(["examples", "add"], { text: `Note ${index}` }, { context: {} });
      }
      const notes = await transport.link.call(["examples", "notes"], undefined, { context: {} });
      expect(notes).toHaveLength(50);
      expect(notes).toContainEqual(expect.objectContaining({ text: "Note 50" }));
      expect(notes).not.toContainEqual(expect.objectContaining({ text: "Note 0" }));
    } finally {
      transport.dispose();
      await backend.stop();
    }
  },
  30_000,
);

test.skipIf(!connectionString)(
  "Next and Start own independent validated backends and databases",
  async () => {
    assert(connectionString);
    const backends: Awaited<ReturnType<typeof startIntegrationBackend>>[] = [];
    const clients: ReturnType<typeof createRpcHttpTransport>[] = [];
    try {
      for (const example of ["next", "start"] as const) {
        const backend = await startIntegrationBackend(connectionString, [], example);
        backends.push(backend);
        const token = await backend.token("same-owner");
        const client = createRpcHttpTransport({
          url: backend.url,
          version: backend.version,
          getToken: async () => token,
        });
        clients.push(client);
        expect(await client.link.call(["examples", "greeting"], { name: "  Kello  " }, { context: {} })).toEqual({
          message: "Hello, Kello!",
          owner: "same-owner",
        });
        await assert.rejects(client.link.call(["examples", "add"], { text: "   " }, { context: {} }), {
          code: "BAD_REQUEST",
        });
        expect(await client.link.call(["examples", "notes"], undefined, { context: {} })).toEqual([]);
      }
      expect(backends[0]!.version).not.toBe(backends[1]!.version);
      await clients[0]!.link.call(["examples", "add"], { text: "Next only" }, { context: {} });
      await clients[1]!.link.call(["examples", "add"], { text: "Start only" }, { context: {} });
      for (const [index, text] of ["Next only", "Start only"].entries()) {
        expect(await clients[index]!.link.call(["examples", "notes"], undefined, { context: {} })).toEqual([
          expect.objectContaining({ text }),
        ]);
      }
    } finally {
      for (const client of clients) client.dispose();
      await Promise.all(backends.map((backend) => backend.stop()));
    }
  },
  30_000,
);
