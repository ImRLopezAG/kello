import { Hono } from "hono";
import { createAuthHttpApp } from "./auth-http";
import type { AuthHttpMount } from "./auth-http";
import { createComponentHttpApp } from "./component-http";
import type { ComponentHttpMount } from "../../server/components/http";
import { createRpcHttpApp, createRpcOpenApiApp } from "./rpc-http";
import type { RpcHttpOptions } from "./rpc-http";
import { createNeonRpcSocket } from "./rpc-websocket";
import type { NeonRpcSocketOptions } from "./rpc-websocket";

export interface NeonRpcApplicationOptions extends RpcHttpOptions {
  readonly authHttp?: readonly AuthHttpMount[];
  readonly componentHttp?: readonly ComponentHttpMount[];
  readonly storage?: { fetch(request: Request): Response | Promise<Response> } | undefined;
  readonly openapi?: boolean;
  readonly openapiRouter?: RpcHttpOptions["router"];
  readonly realtime?: Omit<NeonRpcSocketOptions, "router" | "version" | "origins">;
}

/** One public graph, with separate upgrade ingress and an awaited shutdown boundary. */
export async function createNeonRpcApplication(options: NeonRpcApplicationOptions) {
  const http = createRpcHttpApp(options);
  const openapi = options.openapi
    ? await createRpcOpenApiApp({ ...options, router: options.openapiRouter ?? options.router })
    : undefined;
  const realtime = options.realtime
    ? createNeonRpcSocket({
        ...options.realtime,
        router: options.router,
        version: options.version,
        origins: options.origins,
      })
    : undefined;
  const app = new Hono();
  const auth = createAuthHttpApp({ mounts: options.authHttp ?? [], origins: options.origins });
  app.all("/api/auth", (c) => auth.fetch(c.req.raw));
  app.all("/api/auth/*", (c) => auth.fetch(c.req.raw));
  // Reserved adapters are registered before component-owned routes.
  app.all("/api/kello/storage", (c) =>
    options.storage ? options.storage.fetch(c.req.raw) : new Response(null, { status: 404 }),
  );
  app.all("/api/kello/*", (c) => {
    const adapter = c.req.path.startsWith("/api/kello/openapi/") && openapi ? openapi : http;
    return adapter.fetch(c.req.raw);
  });
  const components = createComponentHttpApp({ mounts: options.componentHttp ?? [], verify: options.verify });
  app.all("*", (c) => components.fetch(c.req.raw));
  const pending = new Set<Promise<Response>>();
  const shutdown = new AbortController();
  let stopping: Promise<void> | undefined;
  return {
    fetch(request: Request): Promise<Response> {
      if (shutdown.signal.aborted) return Promise.resolve(new Response("Application stopping", { status: 503 }));
      const path = new URL(request.url).pathname;
      const work = Promise.resolve()
        .then(() => {
          // The provider owns this request and its upgrade response; neither is cloned.
          if (path === "/api/kello/socket" && realtime) return realtime.fetch(request);
          return app.fetch(new Request(request, { signal: AbortSignal.any([request.signal, shutdown.signal]) }));
        })
        .finally(() => pending.delete(work));
      pending.add(work);
      return work;
    },
    stop(): Promise<void> {
      if (stopping) return stopping;
      shutdown.abort();
      stopping = Promise.resolve().then(async () => {
        await realtime?.stop();
        while (pending.size) await Promise.allSettled(pending);
        await auth.drain();
      });
      return stopping;
    },
  };
}
