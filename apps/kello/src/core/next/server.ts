import { forwardNeonRpcRequest } from "../server/auth/neon-rpc";
import { headers } from "next/headers";
import { extractNeonAuthCookies } from "@neondatabase/auth/server";
import { createNeonAuth } from "@neondatabase/auth/next/server";
import type { NeonAuthConfig } from "@neondatabase/auth/server";
import { withKelloServerSession } from "../client/server-session";
import type { SessionClientOptions, SessionConnection } from "../client/auth-lifecycle";
import { neonServerToken } from "../server/auth/neon-token";
import { neonServerEnvironment } from "../server/auth/neon-environment";

/** Request-scoped prefetch and the official Neon cookie handler for Next.js. */
export function createKelloNeonNext<T extends SessionConnection>(
  createClient: (options: SessionClientOptions) => T,
  options: { readonly auth?: () => NeonAuthConfig; readonly url?: () => string } = {},
) {
  const auth = () => createNeonAuth(options.auth?.() ?? neonServerEnvironment().auth);
  return {
    rpc(this: void, request: Request) {
      return forwardNeonRpcRequest(request, options.url?.() ?? neonServerEnvironment().url);
    },
    handler(this: void) {
      const handle: ReturnType<ReturnType<typeof createNeonAuth>["handler"]>["GET"] = (request, context) =>
        auth().handler().GET(request, context);
      // The SDK's methods all delegate to the same request-aware proxy.
      return { GET: handle, POST: handle, PUT: handle, PATCH: handle, DELETE: handle };
    },
    async withSession<R>(this: void, run: Parameters<typeof withKelloServerSession<T, R>>[2]) {
      return withKelloServerSession(
        createClient,
        {
          url: options.url?.() ?? neonServerEnvironment().url,
          getToken: () => neonServerToken(auth()),
          sessionCookie: extractNeonAuthCookies(await headers()),
        },
        run,
      );
    },
  };
}
