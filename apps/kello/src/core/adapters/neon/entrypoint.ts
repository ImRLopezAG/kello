export interface NeonEntrypointApplication {
  /** Version 1 fences framework database handlers and storage against coordinated grant retirement. */
  readonly databaseDrainProtocol?: 1;
  readonly fetch: (request: Request) => Response | Promise<Response>;
  readonly stop: () => Promise<void>;
}

/** Keeps a deployed module loadable while its grant is quarantined. One startup attempt is shared by all requests. */
export function createNeonEntrypoint(start: () => Promise<NeonEntrypointApplication>) {
  let ready: Promise<NeonEntrypointApplication | undefined> | undefined;
  let retryAfter = 0;
  let stopping: Promise<void> | undefined;
  const unavailable = () =>
    new Response("Service unavailable", {
      status: 503,
      headers: { "cache-control": "no-store", "retry-after": "1" },
    });
  return Object.freeze({
    async fetch(this: void, request: Request): Promise<Response> {
      if (stopping || performance.now() < retryAfter) return unavailable();
      ready ??= Promise.resolve()
        .then(start)
        .catch(() => {
          ready = undefined;
          retryAfter = performance.now() + 1000;
          return undefined;
        });
      const application = await ready;
      if (!application || stopping) return unavailable();
      try {
        return await application.fetch(request);
      } catch {
        return unavailable();
      }
    },
    stop(): Promise<void> {
      stopping ??= Promise.resolve().then(async () => {
        const application = await ready;
        await application?.stop();
      });
      return stopping;
    },
  });
}
