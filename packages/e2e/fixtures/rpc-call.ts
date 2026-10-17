import { RPCLink } from "@orpc/client/fetch";
import { ORPCError, RPCSerializer } from "@orpc/client";
import { AsyncIteratorClass } from "@orpc/server";
import { createRpcHttpApp } from "kello/neon";
import type { createRpcRuntime, InvocationIdentity, JsonValue } from "kello/server";

/** Exercises native serialization, ingress and runtime authorization without a listening HTTP server. */
export async function callExample(
  runtime: Awaited<ReturnType<typeof createRpcRuntime>>,
  path: readonly string[],
  input: JsonValue | undefined,
  identity: InvocationIdentity | null,
) {
  const app = createRpcHttpApp({
    router: runtime.router,
    version: runtime.version,
    origins: [],
    allowAnonymous: true,
    verify: async () => {
      if (!identity) throw new Error("Missing identity");
      return { identity, expiresAt: Math.floor(Date.now() / 1000) + 60 };
    },
  });
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
