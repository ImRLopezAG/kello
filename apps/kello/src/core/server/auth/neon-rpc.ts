import { extractNeonAuthCookies } from "@neondatabase/auth/server";
import { httpsAddress } from "./verify";

/** Same-origin frontend bridge for HttpOnly Neon cookies. The server owns the
 * fixed hosted destination; ordinary RPC and live issuance keep one transport. */
export async function forwardNeonRpcRequest(request: Request, serviceUrl: string): Promise<Response> {
  const incoming = new URL(request.url);
  if (incoming.pathname !== "/api/kello/session" && !incoming.pathname.startsWith("/api/kello/rpc/"))
    return new Response(null, { status: 404 });
  if (request.method !== "POST") return new Response(null, { status: 405 });
  const origin = request.headers.get("origin");
  if (origin && origin !== incoming.origin) return new Response(null, { status: 403 });
  const destination = httpsAddress(serviceUrl);
  if (destination.search) throw new Error("Kello service URL must not contain query parameters");
  destination.pathname = `${destination.pathname.replace(/\/$/, "")}${incoming.pathname}`;
  destination.search = incoming.search;
  const headers = new Headers();
  for (const name of [
    "authorization",
    "content-type",
    "x-loom-protocol",
    "x-loom-version",
    "x-loom-operation",
    "idempotency-key",
  ])
    if (request.headers.has(name)) headers.set(name, request.headers.get(name)!);
  headers.set("origin", incoming.origin);
  headers.set("cookie", extractNeonAuthCookies(request.headers));
  const upstream = await fetch(new Request(destination.href, request), {
    headers,
    redirect: "error",
    cache: "no-store",
  });
  const responseHeaders = new Headers(upstream.headers);
  responseHeaders.delete("set-cookie");
  responseHeaders.set("cache-control", "private, no-store");
  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}
