import {
  handleAuthResponse,
  extractNeonAuthCookies,
  NEON_AUTH_HEADER_MIDDLEWARE_NAME,
  validateCookieConfig,
} from "@neondatabase/auth/server";
import { httpsAddress } from "../../server/auth/verify";
import type { AuthHttpMount } from "./auth-http";

/** The SDK owns Neon session cookies; no local auth schema or second session authority. */
export function createNeonAuthMount(options: {
  readonly baseUrl: string;
  readonly cookieSecret: string;
  readonly activate: (signal: AbortSignal) => Promise<void>;
}): AuthHttpMount {
  const base = httpsAddress(options.baseUrl);
  if (base.search) throw new Error("Neon Auth upstream must not contain query parameters");
  validateCookieConfig({ secret: options.cookieSecret, sameSite: "none" });
  const baseUrl = base.href.replace(/\/$/, "");
  return {
    prefix: "/api/auth",
    async handle(request) {
      await options.activate(request.signal);
      const path = new URL(request.url).pathname.slice("/api/auth/".length);
      if (!path || /[%\\]/.test(path)) return new Response(null, { status: 404 });
      const headers = new Headers();
      for (const name of ["accept", "content-type", "authorization", "user-agent"])
        if (request.headers.has(name)) headers.set(name, request.headers.get(name)!);
      headers.set("origin", request.headers.get("origin") ?? new URL(request.url).origin);
      headers.set("cookie", extractNeonAuthCookies(request.headers));
      headers.set(NEON_AUTH_HEADER_MIDDLEWARE_NAME, "true");
      const upstream = new URL(`${baseUrl}/${path}`);
      upstream.search = new URL(request.url).search;
      // The SDK request helper lacks signal/manual redirect support in this pinned release.
      // Keep transport bounded here; the public SDK response primitive still owns all cookie handling.
      const init: RequestInit = {
        method: request.method,
        headers,
        signal: request.signal,
        redirect: "manual",
      };
      if (request.body) init.body = await request.text();
      const response = await fetch(upstream, init);
      const proxied = await handleAuthResponse(response, baseUrl, { secret: options.cookieSecret, sameSite: "none" });
      const location = response.headers.get("location");
      if (location && response.status >= 300 && response.status < 400) {
        const redirect = new URL(location, upstream);
        if (redirect.protocol !== "https:" || redirect.username || redirect.password)
          return new Response(null, { status: 502 });
        proxied.headers.set("location", redirect.href);
      }
      return proxied;
    },
  };
}
