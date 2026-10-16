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
    handler(this: void) {
      const handle: ReturnType<ReturnType<typeof createNeonAuth>["handler"]>["GET"] = (request, context) =>
        auth().handler().GET(request, context);
      // The SDK's methods all delegate to the same request-aware proxy.
      return { GET: handle, POST: handle, PUT: handle, PATCH: handle, DELETE: handle };
    },
    withSession<R>(this: void, run: Parameters<typeof withKelloServerSession<T, R>>[2]) {
      return withKelloServerSession(
        createClient,
        {
          url: options.url?.() ?? neonServerEnvironment().url,
          getToken: () => neonServerToken(auth()),
        },
        run,
      );
    },
  };
}
