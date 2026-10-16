import { RPCHandler } from "@orpc/server/websocket";
import * as v from "valibot";
import type { Router } from "@orpc/server";
import type { ProcedureContext } from "../../server/rpc/procedure";
import type { VerifiedSession } from "../../server/auth/verify";
import { rpcContext, rpcErrorStatusMap, rpcTransportSerializer } from "./rpc-context";
import { composeInvocationSignals, constrainInvocationDeadline } from "../../server/invocation-deadline";

export interface RpcSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string | Uint8Array<ArrayBuffer>): void;
  close(code: number, reason: string): void;
}
export interface RpcSocketSessionOptions {
  readonly router: Router<ProcedureContext>;
  readonly socket: RpcSocket;
  readonly session: VerifiedSession;
  readonly maxMessageBytes?: number;
  readonly maxBufferedBytes?: number;
  readonly maxConcurrentCalls?: number;
  readonly maxMessagesPerSecond?: number;
  readonly heartbeatMs?: number;
  readonly onDispose?: () => void;
}

/** Lifecycle and resource limits surround the native peer protocol; client
 * message metadata never supplies identity or invocation ownership. */
export function createRpcSocketSession(options: RpcSocketSessionOptions) {
  const messageLimit = options.maxMessageBytes ?? 1_048_576;
  const bufferLimit = options.maxBufferedBytes ?? 1_048_576;
  const callLimit = options.maxConcurrentCalls ?? 64;
  const rateLimit = options.maxMessagesPerSecond ?? 200;
  const heartbeatMs = options.heartbeatMs ?? 25_000;
  for (const [value, maximum] of [
    [messageLimit, 10_485_760],
    [bufferLimit, 10_485_760],
    [callLimit, 1000],
    [rateLimit, 1000],
    [heartbeatMs, 30_000],
  ] as const) {
    if (!Number.isInteger(value) || value < 1 || value > maximum) throw new Error("Invalid RPC socket limit");
  }
  const session = Object.freeze({
    identity: Object.freeze({ ...options.session.identity }),
    expiresAt: options.session.expiresAt,
  });
  const monotonic = performance.now();
  const wall = Date.now();
  if (!Number.isFinite(session.expiresAt) || session.expiresAt <= wall / 1000)
    throw new Error("Expired RPC socket session");
  const handler = new RPCHandler(options.router, {
    allowMethods: ["POST"],
    errorStatusMap: rpcErrorStatusMap,
    serializer: rpcTransportSerializer,
  });
  const shutdown = new AbortController();
  // Limiter authority only; native expiry/heartbeat still use their original wall clock.
  constrainInvocationDeadline(shutdown.signal, monotonic + (session.expiresAt * 1000 - wall));
  const pending = new Set<Promise<unknown>>();
  const encoder = new TextEncoder();
  let stopped = false;
  let stopping: Promise<void> | undefined;
  let messages = 0;
  let windowStarted = Date.now();
  const peer = {
    send(data: string | Uint8Array<ArrayBuffer>) {
      const size = v.is(v.string(), data) ? encoder.encode(data).byteLength : data.byteLength;
      if (stopped || options.socket.readyState !== 1 || options.socket.bufferedAmount + size > bufferLimit) {
        close(1013, "RESYNC_REQUIRED");
        throw new Error("RPC socket unavailable");
      }
      options.socket.send(data);
    },
  };
  const heartbeat = setInterval(() => {
    if (session.expiresAt <= Date.now() / 1000) close(1008, "SESSION_EXPIRED");
    else {
      try {
        peer.send(" ");
      } catch {
        close(1013, "RESYNC_REQUIRED");
      }
    }
  }, heartbeatMs);
  heartbeat.unref?.();
  let expiry: ReturnType<typeof setTimeout>;
  function expire() {
    const remaining = session.expiresAt * 1000 - Date.now();
    if (remaining <= 0) close(1008, "SESSION_EXPIRED");
    else {
      expiry = setTimeout(expire, Math.min(remaining, 2_147_483_647));
      expiry.unref?.();
    }
  }
  expire();

  function dispose(): Promise<void> {
    if (stopping) return stopping;
    stopped = true;
    clearInterval(heartbeat);
    clearTimeout(expiry);
    shutdown.abort();
    stopping = Promise.resolve().then(async () => {
      try {
        try {
          await handler.close(peer);
        } finally {
          await Promise.allSettled(pending);
        }
      } finally {
        options.onDispose?.();
      }
    });
    return stopping;
  }
  function close(code: number, reason: string) {
    if (stopped) return;
    // Event-driven closure has no awaiting caller; dispose still retains its
    // rejection for callers explicitly draining the session.
    void dispose().catch(() => {});
    options.socket.close(code, reason);
  }
  function message(data: string | ArrayBuffer | Uint8Array<ArrayBuffer>): void {
    if (stopped) return;
    if (session.expiresAt <= Date.now() / 1000) {
      close(1008, "SESSION_EXPIRED");
      return;
    }
    if (Date.now() - windowStarted >= 1000) {
      windowStarted = Date.now();
      messages = 0;
    }
    const size = v.is(v.string(), data) ? encoder.encode(data).byteLength : data.byteLength;
    if (size > messageLimit || ++messages > rateLimit || pending.size >= callLimit) {
      close(1009, "CAPACITY_EXCEEDED");
      return;
    }
    // Call immediately so the native peer observes cancellation and data frames
    // in arrival order. Do not await one procedure before admitting its cancel.
    const work = handler
      .message(peer, data, {
        context: (request) => {
          const monotonic = performance.now();
          const remaining = session.expiresAt * 1000 - Date.now();
          constrainInvocationDeadline(shutdown.signal, monotonic + remaining);
          return rpcContext(
            session,
            composeInvocationSignals(request.signal ? [request.signal, shutdown.signal] : [shutdown.signal]),
            request.headers["idempotency-key"],
            request.headers["x-loom-operation"],
          );
        },
      })
      .then((result) => {
        if (!result.matched) close(1008, "INVALID_MESSAGE");
      })
      .catch(() => close(1008, "INVALID_MESSAGE"))
      .finally(() => pending.delete(work));
    pending.add(work);
  }
  return Object.freeze({ message, dispose, close });
}
