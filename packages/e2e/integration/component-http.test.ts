import assert from "node:assert/strict";
import { test } from "bun:test";
import { openapi } from "@orpc/openapi";
import { os } from "@orpc/server";
import * as v from "valibot";
import { createNeonRpcApplication } from "../../../apps/kello/src/core/adapters/neon/rpc-application";

test("Hono serves native contract HTTP without protocol headers and retains reserved storage/RPC", async () => {
  let calls = 0;
  const external = os
    .meta(openapi({ method: "POST", path: "/echo" }))
    .input(v.object({ message: v.string() }))
    .output(v.object({ message: v.string() }))
    .handler(({ input }) => {
      calls++;
      return input;
    });
  const invalid = os
    .meta(openapi({ method: "GET", path: "/invalid" }))
    .output(v.string())
    .handler(() => {
      // SAFETY: intentionally violate the declared output to prove runtime validation.
      return 42 as never;
    });
  const app = await createNeonRpcApplication({
    router: {},
    version: "a".repeat(64),
    origins: [],
    verify: async () => {
      throw new Error("invalid");
    },
    storage: { fetch: async () => new Response("storage") },
    componentHttp: [
      {
        prefix: "/api/components/example",
        routes: [
          { method: "POST", path: "/echo", access: { kind: "anonymous" }, router: { echo: external } },
          { method: "GET", path: "/invalid", access: { kind: "anonymous" }, router: { invalid } },
        ],
      },
    ],
  });
  try {
    const send = (message: string | number) =>
      app.fetch(
        new Request("https://api.test/api/components/example/echo", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message }),
        }),
      );
    assert.equal((await send("hello")).status, 200);
    assert.equal((await send(42)).status, 400);
    assert.equal(calls, 1);
    assert.equal((await app.fetch(new Request("https://api.test/api/components/example/invalid"))).status, 500);
    assert.equal(await (await app.fetch(new Request("https://api.test/api/kello/storage"))).text(), "storage");
    assert.equal((await app.fetch(new Request("https://api.test/api/kello/rpc/echo", { method: "POST" }))).status, 409);
  } finally {
    await app.stop();
  }
});

test("signed webhook fixture rejects altered and expired signatures before writes; retries deduplicate", async () => {
  const { createHmac, timingSafeEqual } = await import("node:crypto");
  const { createComponentHttpApp } = await import("../../../apps/kello/src/core/adapters/neon/component-http");
  const secret = "local-fixture-only";
  const timestamp = Math.floor(Date.now() / 1000);
  const body = new TextEncoder().encode('{ "id": "event-1" }\n');
  const signature = (time: number) => createHmac("sha256", secret).update(`${time}.`).update(body).digest("hex");
  const events = new Set<string>();
  let writes = 0;
  const app = createComponentHttpApp({
    mounts: [
      {
        prefix: "/api/components/webhook",
        routes: [
          {
            method: "POST",
            path: "/event",
            maxRequestBytes: 64,
            access: {
              kind: "signed-webhook",
              verify: ({ request, body }) => {
                const time = Number(request.headers.get("timestamp"));
                const received = Buffer.from(request.headers.get("signature") ?? "", "hex");
                const expected = createHmac("sha256", secret).update(`${time}.`).update(body).digest();
                if (
                  !Number.isSafeInteger(time) ||
                  Math.abs(Date.now() / 1000 - time) > 60 ||
                  received.length !== expected.length ||
                  !timingSafeEqual(received, expected)
                )
                  throw new Error("Invalid signature");
              },
            },
            handle: async ({ request }) => {
              const event = v.parse(v.object({ id: v.string() }), await request.json());
              // Fixture only: production components deduplicate inside their database transaction.
              if (!events.has(event.id)) {
                events.add(event.id);
                writes++;
              }
              return new Response(null, { status: 204 });
            },
          },
        ],
      },
    ],
  });
  const send = (bytes: Uint8Array<ArrayBuffer>, time = timestamp) =>
    app.fetch(
      new Request("https://api.test/api/components/webhook/event", {
        method: "POST",
        headers: { timestamp: String(time), signature: signature(time) },
        body: bytes,
      }),
    );
  assert.equal((await send(body)).status, 204);
  assert.equal((await send(body)).status, 204);
  assert.equal((await send(new TextEncoder().encode('{"id":"event-1"}'))).status, 401);
  assert.equal((await send(body, timestamp - 120)).status, 401);
  assert.equal((await send(new Uint8Array(65))).status, 413);
  assert.equal(writes, 1);
});
