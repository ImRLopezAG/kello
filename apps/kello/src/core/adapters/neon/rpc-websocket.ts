import { upgradeWebSocket } from "@neon/functions";
import * as v from "valibot";
import { originPolicy } from "../../server/auth/policy";
import type { createConnectionTickets } from "../../server/auth/tickets";
import type { VerifiedSession } from "../../server/auth/verify";
import { abortable } from "./abortable";
import { createRpcSocketSession } from "./rpc-session";
import type { RpcSocketSessionOptions } from "./rpc-session";

export interface NeonRpcSocketOptions extends Omit<RpcSocketSessionOptions, "socket" | "session" | "onDispose"> {
  readonly version: string;
  readonly origins: readonly string[];
  readonly tickets: Pick<ReturnType<typeof createConnectionTickets>, "redeem">;
  readonly maxConnections?: number;
}

/** Authenticate before exposing the native oRPC peer. Return provider upgrades untouched. */
export function createNeonRpcSocket(options: NeonRpcSocketOptions) {
  const allowed = originPolicy(options.origins);
  const maximum = options.maxConnections ?? 100;
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > 1000) throw new Error("Invalid connection limit");
  if (!/^[a-f0-9]{64}$/.test(options.version)) throw new Error("Invalid RPC deployment version");
  const shutdown = new AbortController();
  const connections = new Set<() => Promise<void>>();
  const handshakes = new Set<Promise<Response>>();
  const redemptions = new Set<Promise<VerifiedSession>>();
  let stopping: Promise<void> | undefined;

  async function upgrade(request: Request): Promise<Response> {
    const refuse = (status: number) =>
      new Response("WebSocket connection refused", { status, headers: { "cache-control": "no-store" } });
    if (new URL(request.url).pathname !== "/api/kello/socket") return refuse(404);
    if (request.method !== "GET" || request.headers.get("upgrade")?.toLowerCase() !== "websocket") return refuse(426);
    if (shutdown.signal.aborted || connections.size >= maximum || redemptions.size >= maximum) return refuse(503);
    const origin = request.headers.get("origin");
    if (!origin || !allowed(origin)) return refuse(403);
    const header = request.headers.get("sec-websocket-protocol") ?? "";
    if (header.length > 256) return refuse(400);
    const offered = header.split(",").map((value) => value.trim());
    const credential = offered.find((value) => /^kello\.ticket\.[A-Za-z0-9_-]{43}$/.test(value));
    if (offered.length !== 3 || !offered.includes("kello.orpc.2") || !credential) return refuse(400);
    if (!offered.includes(`kello.version.${options.version}`)) return refuse(409);
    let socket: WebSocket | undefined;
    let session: ReturnType<typeof createRpcSocketSession> | undefined;
    let released = false;
    let disposing: Promise<void> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    function release() {
      released = true;
      if (deadline) clearTimeout(deadline);
      connections.delete(dispose);
    }
    function dispose(): Promise<void> {
      if (disposing) return disposing;
      disposing = Promise.resolve().then(async () => {
        try {
          socket?.close(4001, "SERVICE_STOPPED");
        } finally {
          try {
            await session?.dispose();
          } finally {
            release();
          }
        }
      });
      return disposing;
    }
    connections.add(dispose);
    try {
      const signal = AbortSignal.any([request.signal, shutdown.signal, AbortSignal.timeout(5000)]);
      const redemption = options.tickets
        .redeem(credential.slice("kello.ticket.".length), origin)
        .finally(() => redemptions.delete(redemption));
      redemptions.add(redemption);
      const verified = await abortable(redemption, signal);
      signal.throwIfAborted();
      if (!Number.isFinite(verified.expiresAt) || verified.expiresAt <= Date.now() / 1000) {
        release();
        return refuse(401);
      }
      const result = upgradeWebSocket(request, { protocol: "kello.orpc.2" });
      socket = result.socket;
      socket.binaryType = "arraybuffer";
      const fail = () => {
        void dispose().catch(release);
      };
      deadline = setTimeout(fail, 5000);
      deadline.unref?.();
      socket.addEventListener(
        "open",
        () => {
          if (released || shutdown.signal.aborted) {
            fail();
            return;
          }
          if (deadline) clearTimeout(deadline);
          try {
            session = createRpcSocketSession({
              ...options,
              socket: {
                get readyState() {
                  return result.socket.readyState;
                },
                get bufferedAmount() {
                  return result.socket.bufferedAmount;
                },
                send: (data) => result.socket.send(data),
                // Neon exposes WHATWG close(): reserved protocol codes throw.
                // Keep the semantic reason, using the application-code range.
                close: (code, reason) => result.socket.close(code < 3000 && code !== 1000 ? code + 3000 : code, reason),
              },
              session: verified,
              onDispose: release,
            });
          } catch {
            fail();
          }
        },
        { once: true },
      );
      socket.addEventListener("message", (event) => {
        const data: unknown = event.data;
        if (v.is(v.union([v.string(), v.instance(ArrayBuffer)]), data)) session?.message(data);
        else fail();
      });
      socket.addEventListener("close", fail, { once: true });
      socket.addEventListener("error", fail, { once: true });
      return result.response;
    } catch {
      await dispose();
      return refuse(401);
    }
  }
  return {
    fetch(request: Request) {
      const work = upgrade(request).finally(() => handshakes.delete(work));
      handshakes.add(work);
      return work;
    },
    stop(): Promise<void> {
      if (stopping) return stopping;
      shutdown.abort();
      stopping = Promise.resolve().then(async () => {
        await Promise.allSettled(handshakes);
        await Promise.allSettled([...connections].map((dispose) => dispose()));
        // A deadline cancels admission, not an already-running PG transaction.
        await Promise.allSettled(redemptions);
      });
      return stopping;
    },
  };
}
