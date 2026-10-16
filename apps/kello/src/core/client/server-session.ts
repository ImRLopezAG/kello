import { abortable } from "../adapters/neon/abortable";
import { dehydrate } from "@tanstack/query-core";
import { encodeHydration } from "./hydration";
import { createQueryClient } from "./query-client";
import type { SessionClientOptions, SessionConnection } from "./auth-lifecycle";
import type { VerifiedClientSession } from "./verified-session";

/** Serialized query cache bound to the verified server session and cache namespace. Hydrate only into the matching authenticated browser session; never cache across users. */
export interface KelloHydration {
  readonly session: VerifiedClientSession;
  readonly cachePrefix: string;
  readonly state: string;
}

/** Call inside a request. The callback owns application prefetch; Kello owns teardown. */
export async function withKelloServerSession<T extends SessionConnection, R>(
  createClient: (options: SessionClientOptions) => T,
  options: { readonly url: string; readonly getToken: () => Promise<string | null>; readonly signal?: AbortSignal },
  run: (session: {
    readonly connection: T;
    readonly queryClient: ReturnType<typeof createQueryClient>;
    readonly dehydrate: () => KelloHydration;
  }) => Promise<R>,
): Promise<R | null> {
  const signal = options.signal ?? AbortSignal.timeout(30_000);
  signal.throwIfAborted();
  const token = await abortable(options.getToken(), signal);
  signal.throwIfAborted();
  if (!token) return null;
  const cachePrefix = `loom:${crypto.randomUUID()}`;
  const connection = createClient({ url: options.url, getToken: async () => token, cachePrefix });
  const queryClient = createQueryClient();
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    connection.dispose();
    queryClient.clear();
  };
  signal.addEventListener("abort", dispose, { once: true });
  try {
    const session = await abortable(connection.verifySession(), signal);
    signal.throwIfAborted();
    const result = await abortable(
      run({
        connection,
        queryClient,
        dehydrate: () => ({
          session,
          cachePrefix,
          state: encodeHydration(dehydrate(queryClient, { shouldDehydrateMutation: () => false })),
        }),
      }),
      signal,
    );
    signal.throwIfAborted();
    return result;
  } finally {
    signal.removeEventListener("abort", dispose);
    dispose();
  }
}
