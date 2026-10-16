import * as v from "valibot";
import { onlineManager } from "@tanstack/query-core";
import type { KelloHydration } from "./server-session";
import type { KelloAuth } from "./cookie-session";
import type { VerifiedClientSession } from "./verified-session";

/** Connection lifecycle required by providers and SSR helpers. Verification establishes server-trusted identity; disposal releases owned transport resources. */
export interface SessionConnection {
  dispose(): void;
  verifySession(): Promise<VerifiedClientSession>;
}
/** Options supplied by a provider or SSR scope to the generated client factory. cachePrefix isolates native query keys for that identity epoch. */
export interface SessionClientOptions {
  readonly url: string;
  readonly cachePrefix: string;
  readonly getToken: () => Promise<string | null>;
}

/** One owner per mounted provider/request. No procedure is retried by this lifecycle. */
export function createAuthLifecycle<T extends SessionConnection>(options: {
  readonly hydration?: KelloHydration | undefined;
  readonly url: string;
  readonly auth: KelloAuth;
  readonly createClient: (options: SessionClientOptions) => T;
  readonly onConnection: (connection: T | null) => void;
  readonly clearCache: (prefix: string) => void;
  readonly onError?: (error: Error) => void;
}) {
  let disposed = false;
  let revision = 0;
  let active: T | undefined;
  let key: string | undefined = options.hydration?.session.key;
  let prefix = options.hydration
    ? v.parse(v.pipe(v.string(), v.regex(/^loom:[a-f0-9-]{36}$/)), options.hydration.cachePrefix)
    : `loom:${crypto.randomUUID()}`;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void> | undefined;
  const stop = () => {
    clearTimeout(timer);
    active?.dispose();
    active = undefined;
    options.onConnection(null);
  };
  async function connect(generation: number, forceRefresh: boolean) {
    try {
      const token = await options.auth.getToken({ forceRefresh });
      if (disposed || generation !== revision) return;
      if (!token) {
        options.clearCache(prefix);
        key = undefined;
        prefix = `loom:${crypto.randomUUID()}`;
        return;
      }
      // Pin the verified credential. A mutable SDK token getter must not switch
      // the identity of an already-created peer before its change event arrives.
      const getToken = async () => token;
      let connection = options.createClient({ url: options.url, getToken, cachePrefix: prefix });
      active = connection;
      const session = await connection.verifySession();
      if (disposed || generation !== revision) {
        connection.dispose();
        return;
      }
      if (key !== undefined && key !== session.key) {
        options.clearCache(prefix);
        prefix = `loom:${crypto.randomUUID()}`;
        connection.dispose();
        connection = options.createClient({ url: options.url, getToken, cachePrefix: prefix });
        active = connection;
      }
      key = session.key;
      options.onConnection(connection);
      timer = setTimeout(
        () => {
          void refresh();
        },
        Math.max(1000, Math.min(2_147_483_647, session.expiresAt * 1000 - Date.now() - 30_000)),
      );
    } catch (error) {
      if (disposed || generation !== revision) return;
      stop();
      options.clearCache(prefix);
      key = undefined;
      prefix = `loom:${crypto.randomUUID()}`;
      options.onError?.(error instanceof Error ? error : new Error("Authentication failed"));
    }
  }
  function refresh(forceRefresh = true): Promise<void> {
    if (disposed) return Promise.resolve();
    if (pending) return pending;
    stop();
    const generation = ++revision;
    const attempt = connect(generation, forceRefresh);
    pending = attempt;
    void attempt.finally(() => {
      if (pending === attempt) pending = undefined;
    });
    return attempt;
  }
  const unsubscribe = options.auth.subscribe?.(() => {
    // Invalidate pending verification immediately, including A -> B -> A races.
    revision++;
    pending = undefined;
    stop();
    options.clearCache(prefix);
    key = undefined;
    prefix = `loom:${crypto.randomUUID()}`;
    void refresh(false);
  });
  const unsubscribeOnline = onlineManager.subscribe((online) => {
    if (online) void refresh();
  });
  return {
    refresh,
    dispose() {
      if (disposed) return;
      disposed = true;
      revision++;
      unsubscribe?.();
      unsubscribeOnline();
      stop();
      options.clearCache(prefix);
    },
  };
}
