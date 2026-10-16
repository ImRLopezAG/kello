import { getRequest, setCookie, setResponseHeader } from "@tanstack/react-start/server";
import { createAuthServer, handleAuthProxyRequest, resolveNeonAuthLogging } from "@neondatabase/auth/server";
import type { NeonAuthConfig } from "@neondatabase/auth/server";
import { withKelloServerSession } from "../client/server-session";
import type { SessionClientOptions, SessionConnection } from "../client/auth-lifecycle";
import { neonServerToken } from "../server/auth/neon-token";
import { neonServerEnvironment } from "../server/auth/neon-environment";

/** Neon owns cookie signing and refresh; Start supplies only the current request context. */
export function createKelloNeonStart<T extends SessionConnection>(
  createClient: (options: SessionClientOptions) => T,
  options: { readonly auth?: () => NeonAuthConfig; readonly url?: () => string } = {},
) {
  const configuration = () => options.auth?.() ?? neonServerEnvironment().auth;
  return {
    async handler(this: void, request: Request) {
      const path = new URL(request.url).pathname;
      if (!path.startsWith("/api/auth/")) return new Response(null, { status: 404 });
      const config = configuration();
      return handleAuthProxyRequest({
        request,
        path: path.slice("/api/auth/".length),
        baseUrl: config.baseUrl,
        ...cookieOptions(config),
      });
    },
    withSession<R>(this: void, run: Parameters<typeof withKelloServerSession<T, R>>[2]) {
      const request = getRequest();
      setResponseHeader("Cache-Control", "private, no-store");
      setResponseHeader("Vary", "Cookie");
      const config = configuration();
      const auth = createAuthServer({
        baseUrl: config.baseUrl,
        ...cookieOptions(config),
        context: () => ({
          getCookies: () => request.headers.get("cookie") ?? "",
          getHeader: (name) => request.headers.get(name),
          getOrigin: () => request.headers.get("origin") ?? new URL(request.url).origin,
          getFramework: () => "tanstack-start",
          setCookie,
        }),
      });
      return withKelloServerSession(
        createClient,
        {
          url: options.url?.() ?? neonServerEnvironment().url,
          signal: request.signal,
          getToken: () => neonServerToken(auth),
        },
        run,
      );
    },
  };
}

function cookieOptions(config: NeonAuthConfig) {
  const { secret, ...cookies } = config.cookies;
  return { ...cookies, cookieSecret: secret, log: resolveNeonAuthLogging(config) };
}
