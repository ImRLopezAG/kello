import { expect, test } from "vite-plus/test";
import { ORPCError, os } from "@orpc/server";
import * as v from "valibot";
import { createRpcHttpApp, createRpcOpenApiApp } from "../../../apps/loom/src/core/adapters/neon/rpc-http";
import type { ProcedureContext } from "../../../apps/loom/src/core/server/rpc/procedure";
import { rpcTransportSerializer } from "../../../apps/loom/src/core/adapters/neon/rpc-context";

const version = "a".repeat(64);
const origin = "https://app.example.test";
const retryData = v.strictObject({
  retryAfterMs: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(86_400_000)),
});
const procedure = os.$context<ProcedureContext>().errors({
  RATE_LIMITED: { data: retryData },
  RATE_LIMIT_UNAVAILABLE: {},
});
const errorPayload = v.object({
  defined: v.boolean(),
  code: v.string(),
  message: v.string(),
  data: v.optional(v.unknown()),
  cause: v.optional(v.unknown()),
});

async function fixture() {
  let entered = 0;
  const allEntered = Promise.withResolvers<void>();
  const router = {
    denied: procedure
      .input(v.number())
      .output(v.null())
      .handler(async ({ input }) => {
        if (++entered === 6) allEntered.resolve();
        await allEntered.promise;
        throw new ORPCError("RATE_LIMITED", {
          message: "secret SQL policy and identity",
          data: { retryAfterMs: input },
          cause: new Error("secret database cause"),
        });
      }),
    unavailable: procedure.output(v.null()).handler(() => {
      throw new ORPCError("RATE_LIMIT_UNAVAILABLE", {
        message: "secret SQL config and key",
        data: { secret: "database credentials" },
        cause: new Error("secret outage cause"),
      });
    }),
    unrelated: procedure.output(v.null()).handler(() => {
      throw new ORPCError("FORBIDDEN");
    }),
    success: procedure.output(v.null()).handler(() => null),
  };
  const options = {
    router,
    version,
    origins: [origin],
    allowAnonymous: true,
    verify: async () => {
      throw new Error("Anonymous fixture must not verify");
    },
  };
  return { rpc: createRpcHttpApp(options), openapi: await createRpcOpenApiApp(options) };
}

function request(prefix: "rpc" | "openapi", path: string, input: number | null | Record<string, number> = null) {
  return new Request(`https://service.test/api/kello/${prefix}/${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
      "x-loom-protocol": "loom-orpc-2",
      "x-loom-version": version,
    },
    body: JSON.stringify(prefix === "rpc" ? { json: input } : input),
  });
}

for (const prefix of ["rpc", "openapi"] as const) {
  test(`${prefix} preserves native rate-limit errors and isolates concurrent retry headers`, async () => {
    const apps = await fixture();
    const app = apps[prefix];
    const durations = [1, 999, 1000, 1001, 60_001, 86_400_000];
    const responses = await Promise.all([
      ...durations.map((duration) => app.fetch(request(prefix, "denied", duration))),
      app.fetch(request(prefix, "unavailable")),
      app.fetch(request(prefix, "unrelated")),
      app.fetch(request(prefix, "success")),
    ]);
    for (const [index, response] of responses.entries()) {
      const payload = await response.json();
      const decoded = prefix === "rpc" ? rpcTransportSerializer.deserialize(payload) : payload;
      expect(response.headers.get("access-control-allow-origin")).toBe(origin);
      if (index < durations.length) {
        const error = v.parse(errorPayload, decoded);
        expect(response.status).toBe(429);
        expect(response.headers.get("retry-after")).toBe(String(Math.max(1, Math.ceil(durations[index]! / 1000))));
        expect(
          response.headers
            .get("access-control-expose-headers")
            ?.toLowerCase()
            .split(/\s*,\s*/),
        ).toContain("retry-after");
        expect(error).toMatchObject({
          defined: true,
          code: "RATE_LIMITED",
          message: "Rate limit exceeded",
          data: { retryAfterMs: durations[index] },
        });
        expect(JSON.stringify(payload)).not.toContain("secret");
      } else {
        expect(response.headers.get("retry-after")).toBeNull();
        expect(response.status).toBe([503, 403, 200][index - durations.length]);
        if (index === durations.length) {
          const error = v.parse(errorPayload, decoded);
          expect(error).toMatchObject({
            defined: true,
            code: "RATE_LIMIT_UNAVAILABLE",
            message: "Rate limit unavailable",
          });
          expect(error.data).toBeUndefined();
          expect(JSON.stringify(payload)).not.toContain("secret");
          expect(JSON.stringify(payload)).not.toContain("credentials");
          expect(error.cause).toBeUndefined();
        }
      }
    }
    const followUp = await app.fetch(request(prefix, "success"));
    expect(followUp.status).toBe(200);
    expect(followUp.headers.get("retry-after")).toBeNull();
    expect(apps.openapi.document.paths?.["/denied"]?.post?.responses?.["429"]).toBeDefined();
    expect(apps.openapi.document.paths?.["/unavailable"]?.post?.responses?.["503"]).toBeDefined();
  });

  test(`${prefix} rejects invalid native retry data without leaking it or adding a header`, async () => {
    const invalid = [
      undefined,
      {},
      { retryAfterMs: 0 },
      { retryAfterMs: -1 },
      { retryAfterMs: 1.5 },
      { retryAfterMs: "1000" },
      { retryAfterMs: 86_400_001 },
      { retryAfterMs: Infinity },
      { retryAfterMs: NaN },
      { retryAfterMs: 1000, secret: "identity" },
    ];
    const router = Object.fromEntries(
      invalid.map((data, index) => [
        String(index),
        os
          .$context<ProcedureContext>()
          .errors({ RATE_LIMITED: { data: v.unknown() } })
          .output(v.null())
          .handler(() => {
            throw new ORPCError("RATE_LIMITED", { data, message: "secret policy" });
          }),
      ]),
    );
    const options = {
      router,
      version,
      origins: [origin],
      allowAnonymous: true,
      verify: async () => {
        throw new Error("Anonymous fixture must not verify");
      },
    };
    const app = prefix === "rpc" ? createRpcHttpApp(options) : await createRpcOpenApiApp(options);
    for (const response of await Promise.all(invalid.map((_, index) => app.fetch(request(prefix, String(index)))))) {
      expect(response.status).toBe(500);
      expect(response.headers.get("retry-after")).toBeNull();
      const payload = await response.json();
      const error = v.parse(errorPayload, prefix === "rpc" ? rpcTransportSerializer.deserialize(payload) : payload);
      expect(error.code).toBe("INTERNAL_SERVER_ERROR");
      expect(error.data).toBeUndefined();
      expect(error.cause).toBeUndefined();
      expect(JSON.stringify(payload)).not.toContain("secret");
    }
  });
}
