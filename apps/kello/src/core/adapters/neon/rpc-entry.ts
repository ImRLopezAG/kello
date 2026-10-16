import type { AnyRelations } from "drizzle-orm";
import { createRpcRuntime } from "../../server/rpc-runtime";
import type { RpcRuntimeOptions } from "../../server/rpc-runtime";
import { createNeonRpcApplication } from "./rpc-application";
import { createNeonTriggers } from "./triggers";
import type { NeonTriggerBinding } from "./triggers";
import { createStorageHttpApp } from "./storage-http";

async function createRpcEntry<Relations extends AnyRelations>(
  options: RpcRuntimeOptions<Relations>,
  assemble: (runtime: Awaited<ReturnType<typeof createRpcRuntime>>) => Promise<{
    fetch(request: Request): Promise<Response>;
    stop(): Promise<void>;
  }>,
) {
  const runtime = await createRpcRuntime(options);
  try {
    const application = await assemble(runtime);
    let stopping: Promise<void> | undefined;
    return Object.freeze({
      databaseDrainProtocol: 1 as const,
      fetch(this: void, request: Request): Promise<Response> {
        if (stopping) return Promise.resolve(new Response("Application stopping", { status: 503 }));
        return application.fetch(request);
      },
      stop(): Promise<void> {
        if (stopping) return stopping;
        stopping = application.stop().finally(() => runtime.stop());
        return stopping;
      },
    });
  } catch (cause) {
    await runtime.stop();
    throw cause;
  }
}

export function createNeonRpcService<Relations extends AnyRelations>(options: RpcRuntimeOptions<Relations>) {
  return createRpcEntry(options, async (runtime) => {
    const rpc = await createNeonRpcApplication({
      ...runtime.auth,
      authHttp: runtime.authHttp,
      componentHttp: runtime.componentHttp,
      storage: runtime.storage
        ? createStorageHttpApp({ ...runtime.auth, storage: runtime.storage.intents })
        : undefined,
      router: runtime.router,
      openapi: runtime.openapi,
      openapiRouter: runtime.snapshots,
      version: options.version,
      tickets: runtime.tickets,
      realtime: {
        tickets: runtime.tickets,
        heartbeatMs: runtime.realtime.heartbeatMs,
        maxBufferedBytes: runtime.realtime.maxBufferedBytes,
        maxConnections: runtime.realtime.maxSubscriptions,
      },
    });
    return rpc;
  });
}

export function createNeonRpcWorker<Relations extends AnyRelations>(
  options: RpcRuntimeOptions<Relations> & {
    readonly bindings: Readonly<Record<string, NeonTriggerBinding>>;
  },
) {
  const bindings = structuredClone(options.bindings);
  return createRpcEntry(options, async (runtime) => {
    const app = createNeonTriggers({
      bindings,
      crons: runtime.crons,
      worker: runtime.worker,
      storage: runtime.storage?.events,
      cleanup: runtime.storage?.cleanup,
    });
    const pending = new Set<Promise<Response>>();
    const shutdown = new AbortController();
    return {
      fetch(request: Request): Promise<Response> {
        if (new URL(request.url).pathname !== "/api/kello/triggers")
          return Promise.resolve(new Response("Not found", { status: 404 }));
        const work = Promise.resolve(
          app.fetch(new Request(request, { signal: AbortSignal.any([request.signal, shutdown.signal]) })),
        ).finally(() => pending.delete(work));
        pending.add(work);
        return work;
      },
      async stop(): Promise<void> {
        shutdown.abort();
        await runtime.worker.stop();
        while (pending.size) await Promise.allSettled(pending);
      },
    };
  });
}
