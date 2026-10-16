import { createSessionStorage } from "./session-storage";
import { verifyClientSession } from "./verified-session";
import type { ClientLink } from "@orpc/client";
import { ORPCError, RPCSerializer } from "@orpc/client";
import { RPCLink } from "@orpc/client/websocket";
import { OPERATION_CONTEXT_SYMBOL } from "@orpc/tanstack-query";
import type { OperationContext } from "@orpc/tanstack-query";
import * as v from "valibot";
import { readResponse } from "./control-plane";

/** Native oRPC per-call context, including optional retry identity for a logical write. Client operation hints are not authorization. */
export interface RpcCallContext extends OperationContext {
  /** Reuse only when explicitly retrying the same logical write. */
  readonly idempotencyKey?: string;
}

/** Authenticated WebSocket transport configuration. Prefer the generated createClient factory, which supplies the contract version. */
export interface RpcTransportOptions {
  readonly url: string;
  readonly version: string;
  /** Native oRPC cache namespace, assigned by the Kello provider for each identity epoch. */
  readonly cachePrefix?: string;
  /** Return credentials only for this session's identity; return null after an identity change. */
  readonly getToken: () => Promise<string | null>;
}

const ticketSchema = v.strictObject({
  ticket: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{43}$/)),
  expiresAt: v.pipe(v.number(), v.finite()),
});

/** Owns the authenticated native peer. Reconnection obtains a fresh single-use
 * ticket; it never retries a procedure that may already have committed. */
export function createRpcTransport(options: RpcTransportOptions) {
  const { version, getToken } = options;
  if (!/^[a-f0-9]{64}$/.test(version)) throw new Error("Invalid RPC version");
  const base = new URL(options.url);
  if (!["https:", "http:"].includes(base.protocol) || base.username || base.password || base.search || base.hash)
    throw new Error("Invalid RPC service URL");
  const endpoint = (path: string) => `${base.href.replace(/\/$/, "")}/api/kello/${path}`;
  const shutdown = new AbortController();
  const sockets = new Set<WebSocket>();
  let refusal: ORPCError<string, undefined> | undefined;
  const native = new RPCLink<RpcCallContext>({
    serializer: new RPCSerializer({ omitUndefinedProperties: false }),
    headers: ({ context }) => ({
      "x-loom-operation": context[OPERATION_CONTEXT_SYMBOL]?.type ?? "call",
      "idempotency-key":
        context.idempotencyKey === undefined
          ? crypto.randomUUID()
          : v.parse(v.pipe(v.string(), v.uuid()), context.idempotencyKey),
    }),
    reconnect: { enabled: true, maxAttempt: 2 },
    connect: async () => {
      shutdown.signal.throwIfAborted();
      if (refusal) throw refusal;
      const token = await getToken();
      shutdown.signal.throwIfAborted();
      if (!token) throw new Error("Authentication required");
      const signal = AbortSignal.any([shutdown.signal, AbortSignal.timeout(10_000)]);
      const response = await fetch(endpoint("ticket"), {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "x-loom-protocol": "loom-orpc-2",
          "x-loom-version": version,
        },
        body: "{}",
        signal,
        credentials: "omit",
        redirect: "error",
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 409 || response.status === 401 || response.status === 403) {
          refusal = new ORPCError(
            response.status === 409 ? "RPC_VERSION_MISMATCH" : response.status === 401 ? "UNAUTHORIZED" : "FORBIDDEN",
          );
          throw refusal;
        }
        throw new Error(`RPC connection refused (${response.status})`);
      }
      const ticket = v.parse(ticketSchema, JSON.parse(await readResponse(response, 1024, signal)));
      shutdown.signal.throwIfAborted();
      if (ticket.expiresAt <= Date.now() / 1000) throw new Error("Expired RPC ticket");
      const socket = new WebSocket(endpoint("socket").replace(/^http/, "ws"), [
        "kello.orpc.2",
        `kello.version.${version}`,
        `kello.ticket.${ticket.ticket}`,
      ]);
      socket.binaryType = "arraybuffer";
      sockets.add(socket);
      const deadline = setTimeout(() => socket.close(), 10_000);
      socket.addEventListener("open", () => clearTimeout(deadline), { once: true });
      socket.addEventListener(
        "close",
        () => {
          clearTimeout(deadline);
          sockets.delete(socket);
        },
        { once: true },
      );
      // Native peer encoding is asynchronous: cancellation can finish encoding
      // after session shutdown closes the socket. Reject that send instead of
      // letting the browser silently discard it (and report a console error).
      return {
        get readyState() {
          return socket.readyState;
        },
        addEventListener: socket.addEventListener.bind(socket),
        removeEventListener: socket.removeEventListener.bind(socket),
        send(data: Parameters<WebSocket["send"]>[0]) {
          if (socket.readyState !== WebSocket.OPEN) throw new DOMException("RPC socket closed", "AbortError");
          socket.send(data);
        },
      };
    },
  });
  const link: ClientLink<RpcCallContext> = {
    async call(path, input, callOptions) {
      shutdown.signal.throwIfAborted();
      if (refusal) throw refusal;
      try {
        const result = await native.call(path, input, {
          ...callOptions,
          signal: callOptions.signal ? AbortSignal.any([shutdown.signal, callOptions.signal]) : shutdown.signal,
        });
        shutdown.signal.throwIfAborted();
        callOptions.signal?.throwIfAborted();
        return result;
      } catch (cause) {
        shutdown.signal.throwIfAborted();
        throw refusal ?? cause;
      }
    },
  };
  return Object.freeze({
    storage: createSessionStorage(options, shutdown.signal),
    link,
    verifySession: () => verifyClientSession(options, shutdown.signal),
    dispose() {
      shutdown.abort();
      for (const socket of sockets) socket.close(1000, "SESSION_ENDED");
      sockets.clear();
    },
  });
}
