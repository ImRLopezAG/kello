import { Hono } from "hono";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { originPolicy } from "../../server/auth/policy";
import type { VerifiedSession } from "../../server/auth/verify";
import { validateComponentHttpMounts } from "../../server/components/http";
import type { ComponentHttpMount, ComponentHttpContext } from "../../server/components/http";
import { abortable } from "./abortable";

import { BodyLimitError, readBytes } from "./request-bytes";

export function createComponentHttpApp(options: {
  readonly mounts: readonly ComponentHttpMount[];
  readonly verify?: (token: string) => Promise<VerifiedSession>;
}) {
  validateComponentHttpMounts(options.mounts);
  const app = new Hono();
  app.options("*", (c) => {
    const request = c.req.raw;
    const method = request.headers.get("access-control-request-method");
    for (const mount of options.mounts) {
      const route = mount.routes.find(
        (entry) => mount.prefix + (entry.path === "/" ? "" : entry.path) === c.req.path && entry.method === method,
      );
      if (!route) continue;
      const origin = request.headers.get("origin");
      const requested = (request.headers.get("access-control-request-headers") ?? "")
        .toLowerCase()
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean);
      if (
        !origin ||
        !originPolicy(route.origins ?? [])(origin) ||
        requested.some((name) => !["authorization", "content-type", "idempotency-key"].includes(name))
      )
        return new Response(null, { status: 403 });
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": origin,
          "access-control-allow-methods": route.method,
          "access-control-allow-headers": "authorization, content-type, idempotency-key",
          vary: "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
        },
      });
    }
    return new Response(null, { status: 404 });
  });
  for (const mount of options.mounts) {
    for (const route of mount.routes) {
      const allowed = originPolicy(route.origins ?? []);
      const adapter = route.router ? new OpenAPIHandler(route.router) : undefined;
      const path = mount.prefix + (route.path === "/" ? "" : route.path);
      app.on(route.method, path, async (c) => {
        const original = c.req.raw;
        const headers = new Headers({ "cache-control": "no-store", vary: "Origin" });
        const fail = (status: number) => new Response(null, { status, headers });
        const origin = original.headers.get("origin");
        if (!allowed(origin)) return fail(403);
        if (origin) headers.set("access-control-allow-origin", origin);
        const deadline = AbortSignal.timeout(route.requestTimeoutMs ?? 30_000);
        let signal = AbortSignal.any([original.signal, deadline]);
        let session: VerifiedSession | null = null;
        try {
          signal.throwIfAborted();
          if (route.access.kind === "verified-user") {
            const token = /^Bearer ([^\s]+)$/i.exec(original.headers.get("authorization") ?? "")?.[1];
            if (!token || !options.verify) return fail(401);
            try {
              session = await abortable(options.verify(token), signal);
            } catch {
              signal.throwIfAborted();
              return fail(401);
            }
            if (!Number.isFinite(session.expiresAt) || session.expiresAt <= Date.now() / 1000) return fail(401);
            signal = AbortSignal.any([
              signal,
              AbortSignal.timeout(Math.max(1, Math.min(120_000, Math.ceil(session.expiresAt * 1000 - Date.now())))),
            ]);
            if (!(await abortable(Promise.resolve(route.access.authorize(session, original)), signal)))
              return fail(403);
          }
          const body = await readBytes(original, route.maxRequestBytes ?? 1_048_576, signal);
          if (route.access.kind === "signed-webhook") {
            try {
              await abortable(
                Promise.resolve(route.access.verify({ request: original, body: body.slice(), signal })),
                signal,
              );
            } catch {
              signal.throwIfAborted();
              return fail(401);
            }
          }
          signal.throwIfAborted();
          const init: RequestInit = { method: original.method, headers: original.headers, signal };
          if (original.body !== null && original.method !== "GET" && original.method !== "HEAD") init.body = body;
          const request = new Request(original.url, init);
          const invocation = { request, signal, session };
          const work = async (context: ComponentHttpContext) => {
            signal.throwIfAborted();
            if (adapter) {
              // SAFETY: validateComponentHttpMounts already checked the canonical leading-slash prefix.
              const result = await adapter.handle(request, { prefix: mount.prefix as `/${string}`, context });
              return result.matched ? result.response : fail(404);
            }
            if (!route.handle) throw new Error("Missing component HTTP handler");
            return route.handle({ ...invocation, context });
          };
          // The invocation owner must drain its scope even when ingress stops waiting.
          const response = await abortable(mount.invoke ? mount.invoke(invocation, work) : work({}), signal);
          signal.throwIfAborted();
          const responseHeaders = new Headers(response.headers);
          for (const [name, value] of headers) responseHeaders.set(name, value);
          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: responseHeaders,
          });
        } catch (cause) {
          if (original.signal.aborted) return fail(499);
          if (deadline.aborted) return fail(504);
          if (signal.aborted) return fail(401);
          if (cause instanceof BodyLimitError) return fail(413);
          return fail(500);
        }
      });
    }
  }
  return { fetch: (request: Request): Promise<Response> => Promise.resolve(app.fetch(request)) };
}
