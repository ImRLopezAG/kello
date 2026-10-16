import { createSessionStorage } from "./session-storage";
import { verifyClientSession } from "./verified-session";
import type { ClientLink } from "@orpc/client";
import { RPCSerializer } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { OPERATION_CONTEXT_SYMBOL } from "@orpc/tanstack-query";
import * as v from "valibot";
import { abortable } from "../adapters/neon/abortable";
import type { RpcCallContext, RpcTransportOptions } from "./rpc-transport";

/** Request-scoped native HTTP transport for SSR and other non-browser callers.
 * Browser live subscriptions use createRpcTransport's WebSocket connection. */
export function createRpcHttpTransport(options: RpcTransportOptions) {
  const { url, version, getToken } = options;
  if (!/^[a-f0-9]{64}$/.test(version)) throw new Error("Invalid RPC version");
  const base = new URL(url);
  if (!["https:", "http:"].includes(base.protocol) || base.username || base.password || base.search || base.hash)
    throw new Error("Invalid RPC service URL");
  const shutdown = new AbortController();
  const prefix = base.pathname.replace(/^\/|\/$/g, "");
  const native = new RPCLink<RpcCallContext>({
    url: prefix ? `/${prefix}/api/kello/rpc` : "/api/kello/rpc",
    origin: base.origin,
    method: "POST",
    serializer: new RPCSerializer({ omitUndefinedProperties: false }),
    headers: async ({ context, signal }) => {
      shutdown.signal.throwIfAborted();
      const token = await abortable(getToken(), signal ?? shutdown.signal);
      shutdown.signal.throwIfAborted();
      if (!token) throw new Error("Authentication required");
      return {
        authorization: `Bearer ${token}`,
        "x-loom-protocol": "loom-orpc-2",
        "x-loom-version": version,
        "x-loom-operation": context[OPERATION_CONTEXT_SYMBOL]?.type ?? "call",
        "idempotency-key":
          context.idempotencyKey === undefined
            ? crypto.randomUUID()
            : v.parse(v.pipe(v.string(), v.uuid()), context.idempotencyKey),
      };
    },
    fetch: (address, init) => fetch(address, { ...init, credentials: "omit", redirect: "error", cache: "no-store" }),
  });
  const link: ClientLink<RpcCallContext> = {
    async call(path, input, options) {
      shutdown.signal.throwIfAborted();
      const signals = [shutdown.signal, AbortSignal.timeout(30_000)];
      if (options.signal) signals.push(options.signal);
      const signal = AbortSignal.any(signals);
      const result = await native.call(path, input, { ...options, signal });
      signal.throwIfAborted();
      return result;
    },
  };
  return Object.freeze({
    storage: createSessionStorage(options, shutdown.signal),
    link,
    verifySession: () => verifyClientSession({ url, version, getToken }, shutdown.signal),
    dispose: () => shutdown.abort(),
  });
}
