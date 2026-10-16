import { createRpcHttpApp, createNeonRpcApplication, createStorageHttpApp, createRpcSocketSession } from "kello/neon";
import type { VerifiedSession, createRpcRuntime } from "kello/server";
import type { Server, ServerWebSocket } from "bun";
import { originPolicy } from "../../core/server/auth/policy";

type NativeRuntime = Awaited<ReturnType<typeof createRpcRuntime>>;
export interface DevelopmentServerRuntime {
  readonly auth: Pick<
    Parameters<typeof createRpcHttpApp>[0],
    "verify" | "origins" | "allowAnonymous" | "resolveLogin" | "liveQueries"
  >;
  readonly router: NativeRuntime["router"];
  readonly snapshots: NativeRuntime["snapshots"];
  readonly version: string;
  readonly openapi?: boolean;
  readonly tickets: NativeRuntime["tickets"];
  readonly realtime: Pick<NativeRuntime["realtime"], "heartbeatMs" | "maxBufferedBytes">;
  readonly storage?: NativeRuntime["storage"];
  readonly componentHttp?: NativeRuntime["componentHttp"];
  stop(): Promise<void>;
}
type Controller = ReturnType<typeof createRpcSocketSession>;
export interface DevelopmentSocketData {
  readonly session: VerifiedSession;
  readonly release: () => void;
  readonly claim: () => boolean;
  readonly open: (socket: ServerWebSocket<DevelopmentSocketData>) => void;
  controller: Controller | undefined;
}
export function createDevelopmentGeneration(runtime: DevelopmentServerRuntime, maxConnections: number) {
  // Refuse invalid replacement configuration before publishing the generation.
  const allowsOrigin = originPolicy(runtime.auth.origins);
  const storage = runtime.storage
    ? createStorageHttpApp({ ...runtime.auth, storage: runtime.storage.intents })
    : undefined;
  // Reuse production HTTP composition; Bun owns the WebSocket upgrade below.
  // Assemble lazily under an owned request so adapter failures are observed.
  let application: ReturnType<typeof createNeonRpcApplication> | undefined;
  const pending = new Set<Promise<Response>>();
  function http(request: Request): Promise<Response> {
    application ??= createNeonRpcApplication({
      ...runtime.auth,
      router: runtime.router,
      version: runtime.version,
      tickets: runtime.tickets,
      storage,
      openapi: runtime.openapi ?? false,
      openapiRouter: runtime.snapshots,
      componentHttp: runtime.componentHttp ?? [],
    });
    const work = application
      .then((app) => app.fetch(new Request(request, { signal: AbortSignal.any([request.signal, shutdown.signal]) })))
      .finally(() => pending.delete(work));
    pending.add(work);
    return work;
  }
  const reservations = new Set<() => void>();
  const sessions = new Set<Controller>();
  const shutdown = new AbortController();
  let stopped = false;
  let stopping: Promise<void> | undefined;
  const generation = {
    async fetch(request: Request, transport: Server<DevelopmentSocketData>) {
      const refuse = (status: number) =>
        new Response("WebSocket connection refused", {
          status,
          headers: { "cache-control": "no-store" },
        });
      if (stopped) return refuse(503);
      if (new URL(request.url).pathname !== "/api/kello/socket") return http(request);
      if (reservations.size >= maxConnections) return refuse(503);
      if (request.method !== "GET") return refuse(405);
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return refuse(426);
      const origin = request.headers.get("origin");
      if (!origin || !allowsOrigin(origin)) return refuse(403);
      const header = request.headers.get("sec-websocket-protocol") ?? "";
      if (header.length > 256) return refuse(400);
      const offered = header.split(",").map((value) => value.trim());
      const credential = offered.find((value) => /^kello\.ticket\.[A-Za-z0-9_-]{43}$/.test(value));
      const protocol = "kello.orpc.2";
      if (offered.length !== 3 || !offered.includes(protocol) || !credential) return refuse(400);
      if (!offered.includes(`kello.version.${runtime.version}`)) return refuse(409);
      let released = false;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      let controller: Controller | undefined;
      const release = () => {
        if (released) return;
        released = true;
        reservations.delete(release);
        if (deadline) clearTimeout(deadline);
        if (controller) sessions.delete(controller);
      };
      reservations.add(release);
      let cancel = () => {};
      try {
        const timeout = new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(() => reject(new Error("Handshake expired")), 5000);
          cancel = () => reject(new Error("Server stopped"));
          shutdown.signal.addEventListener("abort", cancel, { once: true });
        });
        const session = await Promise.race([
          runtime.tickets.redeem(credential.slice("kello.ticket.".length), origin),
          timeout,
        ]);
        if (deadline) clearTimeout(deadline);
        if (stopped || session.expiresAt <= Date.now() / 1000) {
          release();
          return refuse(401);
        }
        deadline = setTimeout(release, 5000);
        const upgraded = transport.upgrade(request, {
          headers: { "sec-websocket-protocol": protocol },
          data: {
            session,
            release,
            open: generation.open,
            claim() {
              if (released || stopped) return false;
              if (deadline) clearTimeout(deadline);
              return true;
            },
            get controller() {
              return controller;
            },
            set controller(value) {
              controller = value;
            },
          },
        });
        if (upgraded) return;
        release();
        return refuse(400);
      } catch {
        release();
        return refuse(stopped ? 503 : 401);
      } finally {
        shutdown.signal.removeEventListener("abort", cancel);
      }
    },
    open(this: void, socket: ServerWebSocket<DevelopmentSocketData>) {
      if (!socket.data.claim()) {
        socket.close(1013, "RESYNC_REQUIRED");
        socket.data.release();
        return;
      }
      try {
        const common = {
          session: socket.data.session,
          socket: {
            get readyState() {
              return socket.readyState;
            },
            get bufferedAmount() {
              return socket.getBufferedAmount();
            },
            send(message: string | Uint8Array<ArrayBuffer>) {
              socket.send(message);
            },
            close(code: number, reason: string) {
              socket.close(code, reason);
            },
          },
          onDispose: socket.data.release,
        };
        const controller = createRpcSocketSession({
          ...common,
          router: runtime.router,
          heartbeatMs: runtime.realtime.heartbeatMs,
          maxBufferedBytes: runtime.realtime.maxBufferedBytes,
        });
        socket.data.controller = controller;
        if (socket.data.claim()) sessions.add(controller);
      } catch {
        socket.close(1011, "CONNECTION_FAILED");
        socket.data.release();
      }
    },
    stop(): Promise<void> {
      if (stopping) return stopping;
      stopped = true;
      shutdown.abort();
      const closed = [...sessions].map((session) => {
        session.close(1001, "SERVICE_STOPPED");
        return Promise.resolve(session.dispose());
      });
      for (const release of reservations) release();
      stopping = (async () => {
        try {
          await Promise.allSettled(closed);
          while (pending.size) await Promise.allSettled(pending);
          if (application)
            await application.then(
              (app) => app.stop(),
              () => {},
            );
        } finally {
          await runtime.stop();
        }
      })();
      return stopping;
    },
  };
  return generation;
}
