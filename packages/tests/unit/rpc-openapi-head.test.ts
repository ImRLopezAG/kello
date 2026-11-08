import { describe, expect, test } from "vite-plus/test";
import { os } from "@orpc/server";
import { openapi } from "@orpc/openapi";
import * as v from "valibot";
import { createRpcOpenApiApp } from "../../../apps/kello/src/core/adapters/neon/rpc-http";
import type { ProcedureContext } from "../../../apps/kello/src/core/server/rpc/procedure";

const version = "a".repeat(64);
const origin = "https://app.example.test";
const procedure = os.$context<ProcedureContext>();

async function fixture(options: { verified?: boolean } = {}) {
  const calls = { read: 0, write: 0 };
  const router = {
    read: procedure
      .meta(openapi.method("GET"), openapi.path("/read"))
      .output(v.object({ ok: v.boolean() }))
      .handler(() => {
        calls.read += 1;
        return { ok: true };
      }),
    write: procedure
      .meta(openapi.method("POST"), openapi.path("/write"))
      .output(v.object({ ok: v.boolean() }))
      .handler(() => {
        calls.write += 1;
        return { ok: true };
      }),
  };
  const app = await createRpcOpenApiApp({
    router,
    version,
    origins: [origin],
    verify: async (token) => {
      if (token !== "valid" || options.verified === false) throw new Error("rejected");
      return {
        identity: { issuer: "https://issuer.test", subject: "alice", tenantId: "tenant-a" },
        expiresAt: Math.floor(Date.now() / 1000) + 600,
      };
    },
  });
  return { app, calls };
}

function request(method: string, path: string, token?: string) {
  const headers = new Headers({ origin, "x-kello-protocol": "kello-orpc-2", "x-kello-version": version });
  if (token) headers.set("authorization", `Bearer ${token}`);
  return new Request(`https://service.test/api/kello/openapi${path}`, { method, headers });
}

describe("OpenAPI HEAD routing", () => {
  test("answers HEAD on a GET route with the GET status and headers but no body", async () => {
    const { app, calls } = await fixture();
    const get = await app.fetch(request("GET", "/read", "valid"));
    const head = await app.fetch(request("HEAD", "/read", "valid"));
    expect(get.status).toBe(200);
    expect(await get.json()).toEqual({ ok: true });
    expect(head.status).toBe(get.status);
    expect(head.headers.get("content-type")).toBe(get.headers.get("content-type"));
    expect(head.headers.get("cache-control")).toBe("no-store");
    expect(head.headers.get("access-control-allow-origin")).toBe(origin);
    expect(await head.text()).toBe("");
    expect(calls.read).toBe(2);
  });

  test("rejects unauthenticated HEAD exactly as GET without running the procedure", async () => {
    const { app, calls } = await fixture();
    const get = await app.fetch(request("GET", "/read"));
    const head = await app.fetch(request("HEAD", "/read"));
    expect(get.status).toBe(401);
    expect(head.status).toBe(401);
    expect(head.headers.get("cache-control")).toBe(get.headers.get("cache-control"));
    expect(await head.text()).toBe("");
    expect(calls.read).toBe(0);
  });

  test("rejects HEAD with an unverifiable token before the procedure runs", async () => {
    const { app, calls } = await fixture();
    const head = await app.fetch(request("HEAD", "/read", "forged"));
    expect(head.status).toBe(401);
    expect(await head.text()).toBe("");
    expect(calls.read).toBe(0);
  });

  test("does not answer HEAD for a route that is not GET", async () => {
    const { app, calls } = await fixture();
    const head = await app.fetch(request("HEAD", "/write", "valid"));
    expect(head.status).toBe(404);
    expect(await head.text()).toBe("");
    expect(calls.write).toBe(0);
  });
});
