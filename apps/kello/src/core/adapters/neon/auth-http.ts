import { originPolicy } from "../../server/auth/policy";
import { abortable } from "./abortable";
import { BodyLimitError, readBytes } from "./request-bytes";

export interface AuthHttpMount {
  readonly prefix: string;
  readonly handle: (request: Request) => Promise<Response>;
}

/** Native endpoints retain their own validation, cookies, redirects and access policy. */
export function createAuthHttpApp(options: {
  readonly mounts: readonly AuthHttpMount[];
  readonly origins: readonly string[];
  readonly maxRequestBytes?: number;
  readonly requestTimeoutMs?: number;
}) {
  const mounts = [...options.mounts];
  for (const mount of mounts) {
    if (!/^\/api\/auth(?:\/[a-zA-Z0-9_-]+)*$/.test(mount.prefix))
      throw new Error("Auth endpoints must use a canonical /api/auth mount");
    if (
      mounts.some(
        (other) => other !== mount && (other.prefix === mount.prefix || other.prefix.startsWith(mount.prefix + "/")),
      )
    )
      throw new Error("Overlapping auth endpoint mounts");
  }
  if (new Set(mounts.map((mount) => mount.prefix)).size !== mounts.length)
    throw new Error("Duplicate auth endpoint mount");
  const allowed = originPolicy(options.origins);
  const pending = new Set<Promise<Response>>();
  return {
    async fetch(original: Request): Promise<Response> {
      const path = new URL(original.url).pathname;
      const mount = mounts.find((entry) => path === entry.prefix || path.startsWith(entry.prefix + "/"));
      const headers = new Headers({ "cache-control": "no-store", vary: "Origin" });
      const fail = (status: number) => new Response(null, { status, headers });
      if (!mount) return fail(404);
      if (/%|\\/.test(path)) return fail(400);
      const origin = original.headers.get("origin");
      if (!allowed(origin)) return fail(403);
      if (origin) {
        headers.set("access-control-allow-origin", origin);
        headers.set("access-control-allow-credentials", "true");
        headers.set("access-control-expose-headers", "set-auth-jwt, set-auth-token");
      }
      if (original.method === "OPTIONS") {
        const requested = (original.headers.get("access-control-request-headers") ?? "")
          .toLowerCase()
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean);
        const method = original.headers.get("access-control-request-method");
        if (
          !origin ||
          !method ||
          !["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].includes(method) ||
          requested.some((name) => !["authorization", "content-type"].includes(name))
        )
          return fail(403);
        headers.set("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE, HEAD");
        headers.set("access-control-allow-headers", "authorization, content-type");
        headers.set("vary", "Origin, Access-Control-Request-Method, Access-Control-Request-Headers");
        return fail(204);
      }
      const deadline = AbortSignal.timeout(options.requestTimeoutMs ?? 30_000);
      const signal = AbortSignal.any([original.signal, deadline]);
      try {
        const bytes = await readBytes(original, options.maxRequestBytes ?? 1_048_576, signal);
        signal.throwIfAborted();
        const init: RequestInit = { method: original.method, headers: original.headers, signal };
        if (original.body !== null && original.method !== "GET" && original.method !== "HEAD") init.body = bytes;
        const request = new Request(original.url, init);
        const work = Promise.resolve()
          .then(() => mount.handle(request))
          .finally(() => pending.delete(work));
        pending.add(work);
        const response = await abortable(work, signal);
        const outgoing = new Headers(response.headers);
        for (const [key, value] of headers) {
          if ((key === "vary" || key === "access-control-expose-headers") && outgoing.has(key))
            outgoing.append(key, value);
          else outgoing.set(key, value);
        }
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: outgoing,
        });
      } catch (cause) {
        if (original.signal.aborted) return fail(499);
        if (deadline.aborted) return fail(504);
        if (cause instanceof BodyLimitError) return fail(413);
        return fail(500);
      }
    },
    async drain(): Promise<void> {
      while (pending.size) await Promise.allSettled(pending);
    },
  };
}
