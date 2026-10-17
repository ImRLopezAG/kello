import { createNeonRpcApplication, createStorageHttpApp } from "kello/neon";
import type { createRpcRuntime } from "kello/server";

type Runtime = Awaited<ReturnType<typeof createRpcRuntime>>;
export type HttpFixtureRuntime = Pick<Runtime, "router" | "version" | "stop"> &
  Partial<Pick<Runtime, "storage" | "componentHttp">> & {
    readonly auth: Pick<
      Parameters<typeof createNeonRpcApplication>[0],
      "verify" | "origins" | "allowAnonymous" | "resolveLogin" | "liveQueries"
    >;
    readonly openapi?: boolean;
  };

/** Test-only loopback instrument for the production HTTP adapter. */
export async function startHttpHandlerServer(runtime: HttpFixtureRuntime) {
  const options = {
    ...runtime.auth,
    router: runtime.router,
    version: runtime.version,
    openapi: runtime.openapi ?? false,
    componentHttp: runtime.componentHttp ?? [],
  };
  if (runtime.storage)
    Object.assign(options, { storage: createStorageHttpApp({ ...runtime.auth, storage: runtime.storage.intents }) });
  const app = await createNeonRpcApplication(options);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => app.fetch(request) });
  let stopping: Promise<void> | undefined;
  return {
    url: new URL(server.url),
    stop() {
      return (stopping ??= (async () => {
        try {
          await server.stop(true);
          await app.stop();
        } finally {
          await runtime.stop();
        }
      })());
    },
  };
}
