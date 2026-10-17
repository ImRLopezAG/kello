import { RPCLink } from "@orpc/client/fetch";
import { ORPCError, RPCSerializer } from "@orpc/client";
import { AsyncIteratorClass } from "@orpc/server";
import { createRpcHttpApp } from "kello/neon";
import type { createRpcRuntime, InvocationIdentity, JsonValue, TrustedLoginResolver } from "kello/server";
import { randomBytes } from "node:crypto";
import { jwtDecrypt } from "jose";
import * as v from "valibot";

interface NativeLiveRead {
  readonly database: string;
  readonly query: (sql: string, values: (string | null)[]) => Promise<{ rows: unknown[] }>;
}

/** Exercises native serialization, ingress and runtime authorization without a listening HTTP server. */
export async function callExample(
  runtime: Awaited<ReturnType<typeof createRpcRuntime>>,
  path: readonly string[],
  input: JsonValue | undefined,
  identity: InvocationIdentity | null,
  live?: NativeLiveRead,
) {
  // Only these native SQL tests own this key and session record. Actual SDK
  // subscription/renewal acceptance belongs to the separate Neon cloud suite.
  const key = randomBytes(32);
  const resolveLogin: TrustedLoginResolver = async ({ verified }) => ({
    ...verified.identity,
    id: "native-example-test-login",
    expiresAt: verified.expiresAt,
  });
  const options = {
    router: runtime.router,
    version: runtime.version,
    origins: [],
    allowAnonymous: true,
    verify: async () => {
      if (!identity) throw new Error("Missing identity");
      return { identity, expiresAt: Math.floor(Date.now() / 1000) + 60 };
    },
  };
  const app = createRpcHttpApp(
    live
      ? {
          ...options,
          resolveLogin,
          liveQueries: {
            secret: `nrt_live_1${key.toString("base64url")}`,
            database: live.database,
            deployment: "native-example-test",
          },
        }
      : options,
  );
  const headers = new Headers({
    "x-loom-protocol": "loom-orpc-2",
    "x-loom-version": runtime.version,
    "idempotency-key": crypto.randomUUID(),
  });
  if (identity) headers.set("authorization", "Bearer fixture");
  const link = new RPCLink({
    origin: "https://example.test",
    url: "/api/kello/rpc",
    headers,
    serializer: new RPCSerializer({ omitUndefinedProperties: false }),
    fetch: (url, init) => app.fetch(new Request(url, init)),
  });
  try {
    const value = await link.call([...path], input, { context: {} });
    if (live) {
      const issued = v.parse(
        v.object({
          version: v.literal(1),
          scope: v.object({ database: v.literal(live.database), deployment: v.literal("native-example-test") }),
          query: v.object({ capability: v.string() }),
        }),
        value,
      );
      // Decode the SDK's pinned 0.1.0 Compact JWE with our own fixture key, then
      // execute its exact issued SQL as the restricted runtime role. This tests
      // issuance and real PostgreSQL predicates, not a simulated live engine.
      const { payload } = await jwtDecrypt(issued.query.capability, key, {
        audience: "realtime-proxy",
        keyManagementAlgorithms: ["dir"],
        contentEncryptionAlgorithms: ["A256GCM"],
      });
      const prepared = v.parse(
        v.object({
          database: v.literal(live.database),
          sql: v.pipe(v.string(), v.regex(/^select\b/i)),
          parameters: v.array(
            // This fixture supports only the adapter's context-inferred parameters.
            v.object({ type_oid: v.literal(0), value: v.nullable(v.string()) }),
          ),
        }),
        payload,
      );
      const result = await live.query(
        prepared.sql,
        prepared.parameters.map(({ value }) => (value === null ? null : Buffer.from(value, "base64").toString("utf8"))),
      );
      return { ok: true as const, value: result.rows };
    }
    if (!(value instanceof AsyncIteratorClass)) return { ok: true as const, value };
    try {
      return { ok: true as const, value: (await value.next()).value };
    } finally {
      await value.return();
    }
  } catch (error) {
    if (!(error instanceof ORPCError)) throw error;
    return { ok: false as const, error: { code: error.code } };
  }
}
