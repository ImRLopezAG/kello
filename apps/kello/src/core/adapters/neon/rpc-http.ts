import { RPCHandler, BodyLimitPlugin } from "@orpc/server/fetch";
import type { FetchHandler } from "@orpc/server/fetch";
import type { StandardHandlerOptions } from "@orpc/server/standard";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import type { OpenAPIDocument } from "@orpc/openapi";
import * as v from "valibot";
import { ORPCError } from "@orpc/server";
import { createORPCErrorFromJson } from "@orpc/client";
import type { Router } from "@orpc/server";
import { originPolicy } from "../../server/auth/policy";
import { resolveTrustedLogin } from "../../server/auth/login";
import type { TrustedLogin, TrustedLoginResolver } from "../../server/auth/login";
import type { VerifiedSession } from "../../server/auth/verify";
import type { createConnectionTickets } from "../../server/auth/tickets";
import type { ProcedureContext } from "../../server/rpc/procedure";
import { rpcProtocolVersion } from "../../server/rpc/serialization";
import { rpcContext, rpcErrorStatusMap, rpcFailure, rpcTransportSerializer } from "./rpc-context";
import { readRequestBody, RequestBodyError } from "./request-body";
import { abortable } from "./abortable";
import { generateRpcOpenAPI } from "../../server/rpc/openapi";
import { createHash } from "node:crypto";
import {
  composeInvocationSignals,
  constrainInvocationDeadline,
  timedInvocationSignal,
} from "../../server/invocation-deadline";

export interface RpcHttpOptions {
  readonly router: Router<ProcedureContext>;
  readonly version: string;
  readonly origins: readonly string[];
  readonly verify: (token: string) => Promise<VerifiedSession>;
  /** Optional trusted store lookup after verification; never supplied by RPC input. */
  readonly resolveLogin?: TrustedLoginResolver;
  readonly liveQueries?: import("../../server/realtime/procedure").LiveQueryTarget;
  readonly tickets?: Pick<ReturnType<typeof createConnectionTickets>, "issue">;
  readonly allowAnonymous?: boolean;
  readonly maxRequestBytes?: number;
  readonly requestTimeoutMs?: number;
}

/** Fetch-only RPC and ticket ingress. Never pass provider upgrade responses
 * through this boundary or its CORS response handling. */
export function createRpcHttpApp(options: RpcHttpOptions) {
  const handler = new RPCHandler(options.router, {
    ...rateLimitInterceptors(),
    serializer: rpcTransportSerializer,
    allowMethods: ["POST"],
    errorStatusMap: rpcErrorStatusMap,
    plugins: [new BodyLimitPlugin({ maxBodySize: options.maxRequestBytes ?? 1_048_576 })],
  });
  return createHttpIngress(options, handler, "/api/kello/rpc", ["POST"]);
}

/** Validate the public contract before exposing its REST adapter. */
export async function createRpcOpenApiApp(options: Omit<RpcHttpOptions, "tickets">): Promise<{
  fetch(request: Request): Promise<Response>;
  document: OpenAPIDocument<"3.2.0">;
}> {
  const document = await generateRpcOpenAPI(options.router);
  const handler = new OpenAPIHandler(options.router, {
    ...rateLimitInterceptors(),
    errorStatusMap: rpcErrorStatusMap,
    plugins: [new BodyLimitPlugin({ maxBodySize: options.maxRequestBytes ?? 1_048_576 })],
  });
  return {
    ...createHttpIngress(options, handler, "/api/kello/openapi", ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]),
    document,
  };
}

function rateLimitInterceptors(): Pick<
  StandardHandlerOptions<ProcedureContext>,
  "interceptors" | "routingInterceptors"
> {
  const retries = new WeakMap<ProcedureContext, string>();
  const retryData = v.strictObject({
    retryAfterMs: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(86_400_000)),
  });
  return {
    interceptors: [
      async ({ next, context }) => {
        try {
          return await next();
        } catch (error) {
          if (!(error instanceof ORPCError)) throw error;
          if (error.code === "RATE_LIMIT_UNAVAILABLE") {
            throw createORPCErrorFromJson({
              code: "RATE_LIMIT_UNAVAILABLE",
              message: "Rate limit unavailable",
              data: undefined,
              defined: error.defined,
            });
          }
          if (error.code !== "RATE_LIMITED") throw error;
          const parsed = v.safeParse(retryData, error.data);
          if (!parsed.success) throw new ORPCError("INTERNAL_SERVER_ERROR");
          retries.set(context, String(Math.max(1, Math.ceil(parsed.output.retryAfterMs / 1000))));
          throw createORPCErrorFromJson({
            code: "RATE_LIMITED",
            message: "Rate limit exceeded",
            data: parsed.output,
            defined: error.defined,
          });
        }
      },
    ],
    // StandardHandler catches interceptor errors and lets the native codec
    // encode them before returning through this outer routing hook.
    routingInterceptors: [
      async ({ next, context }) => {
        try {
          const result = await next();
          const retry = retries.get(context);
          if (result.matched && result.response.status === 429 && retry !== undefined) {
            result.response.headers["retry-after"] = retry;
          }
          return result;
        } finally {
          retries.delete(context);
        }
      },
    ],
  };
}

function createHttpIngress(
  options: RpcHttpOptions,
  handler: FetchHandler<ProcedureContext>,
  prefix: `/api/kello/${string}`,
  methods: readonly string[],
) {
  const allowed = originPolicy(options.origins);
  const limit = options.maxRequestBytes ?? 1_048_576;
  const timeout = options.requestTimeoutMs ?? 30_000;
  if (!/^[a-f0-9]{64}$/.test(options.version)) throw new Error("Invalid RPC deployment version");
  if (!Number.isInteger(limit) || limit < 1024 || limit > 10_485_760) throw new Error("Invalid request byte limit");
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 120_000) throw new Error("Invalid request timeout");
  const permittedHeaders = [
    "authorization",
    "content-type",
    "x-loom-protocol",
    "x-loom-version",
    "idempotency-key",
    "x-loom-operation",
  ];
  return {
    async fetch(request: Request): Promise<Response> {
      const pathname = new URL(request.url).pathname;
      const ticket = pathname === "/api/kello/ticket" || pathname === "/api/loom/ticket";
      const sessionRequest = prefix === "/api/kello/rpc" && pathname === "/api/kello/session";
      const retired =
        pathname === "/api/loom/call" ||
        pathname === "/api/loom/ticket" ||
        pathname === "/api/kello/call" ||
        (ticket && !request.headers.has("x-loom-protocol"));
      const headers = new Headers({ "cache-control": "no-store", vary: "Origin" });
      const fail = (code: string, status: number) => {
        // A bounded refusal is the only retained legacy transport behavior. Do
        // not decode arguments or dispatch historical procedure references.
        if (retired)
          return Response.json(
            { protocol: 1, ok: false, requestId: crypto.randomUUID(), error: { code, message: code } },
            { status, headers },
          );
        return prefix === "/api/kello/openapi"
          ? Response.json(new ORPCError(code).toJSON(), { status, headers })
          : rpcFailure(code, status, headers);
      };
      if (!retired && !ticket && !sessionRequest && !pathname.startsWith(`${prefix}/`)) return fail("NOT_FOUND", 404);
      if (ticket && !options.tickets) return fail("NOT_FOUND", 404);
      const origin = request.headers.get("origin");
      if (!allowed(origin) || (ticket && !origin)) return fail("FORBIDDEN", 403);
      if (origin) {
        headers.set("access-control-allow-origin", origin);
        headers.set("access-control-expose-headers", "Retry-After");
      }
      if (request.method === "OPTIONS") {
        const requested = (request.headers.get("access-control-request-headers") ?? "")
          .split(",")
          .map((value) => value.trim().toLowerCase())
          .filter(Boolean);
        if (
          !origin ||
          !(ticket ? ["POST"] : methods).includes(request.headers.get("access-control-request-method") ?? "") ||
          requested.some((name) => !permittedHeaders.includes(name))
        )
          return fail("FORBIDDEN", 403);
        headers.set("access-control-allow-methods", ticket ? "POST" : methods.join(", "));
        headers.set("access-control-allow-headers", permittedHeaders.join(", "));
        return new Response(null, { status: 204, headers });
      }
      if (!(ticket ? ["POST"] : methods).includes(request.method)) return fail("METHOD_NOT_SUPPORTED", 405);
      if (retired) return fail("VERSION_MISMATCH", 409);
      if (
        request.headers.get("x-loom-protocol") !== rpcProtocolVersion ||
        request.headers.get("x-loom-version") !== options.version
      )
        return fail("RPC_VERSION_MISMATCH", 409);
      const deadline = timedInvocationSignal(timeout);
      let signal = composeInvocationSignals([request.signal, deadline]);
      try {
        signal.throwIfAborted();
        const authorization = request.headers.get("authorization");
        let session: VerifiedSession | null = null;
        let login: TrustedLogin | undefined;
        if (authorization !== null) {
          const token = /^Bearer ([^\s]+)$/i.exec(authorization)?.[1];
          if (!token) return fail("UNAUTHORIZED", 401);
          try {
            session = await abortable(options.verify(token), signal);
          } catch {
            signal.throwIfAborted();
            return fail("UNAUTHORIZED", 401);
          }
          if (!Number.isFinite(session.expiresAt) || session.expiresAt <= Date.now() / 1000)
            return fail("UNAUTHORIZED", 401);
          const monotonic = performance.now();
          const remaining = session.expiresAt * 1000 - Date.now();
          const sessionSignal = timedInvocationSignal(Math.min(timeout, Math.max(1, Math.ceil(remaining))));
          constrainInvocationDeadline(sessionSignal, monotonic + remaining);
          signal = composeInvocationSignals([signal, sessionSignal]);
          try {
            login = await abortable(resolveTrustedLogin(options.resolveLogin, token, session, signal), signal);
          } catch {
            signal.throwIfAborted();
            return fail("UNAUTHORIZED", 401);
          }
          if (login) {
            const loginMonotonic = performance.now();
            const loginRemaining = login.expiresAt * 1000 - Date.now();
            const loginSignal = timedInvocationSignal(Math.min(timeout, Math.max(1, Math.ceil(loginRemaining))));
            constrainInvocationDeadline(loginSignal, loginMonotonic + loginRemaining);
            signal = composeInvocationSignals([signal, loginSignal]);
          }
        } else if (!options.allowAnonymous || ticket || sessionRequest) return fail("UNAUTHORIZED", 401);
        signal.throwIfAborted();
        if (sessionRequest) {
          if (!session) return fail("UNAUTHORIZED", 401);
          const key = createHash("sha256")
            .update(
              JSON.stringify([
                options.version,
                session.identity.issuer,
                session.identity.subject,
                session.identity.tenantId ?? null,
                ...(login ? [login.id] : []),
              ]),
            )
            .digest("hex");
          return Response.json({ key, expiresAt: login?.expiresAt ?? session.expiresAt }, { headers });
        }
        if (ticket) {
          if (!session || !origin || !options.tickets) return fail("UNAUTHORIZED", 401);
          const body = await readRequestBody(request, 1024, signal);
          try {
            const parsed: unknown = JSON.parse(body);
            if (Array.isArray(parsed) || !v.is(v.strictObject({}), parsed)) return fail("BAD_REQUEST", 400);
          } catch {
            return fail("BAD_REQUEST", 400);
          }
          const issued = await options.tickets.issue(session, origin);
          signal.throwIfAborted();
          if (issued.expiresAt <= Date.now() / 1000) return fail("UNAUTHORIZED", 401);
          return Response.json(issued, { headers });
        }
        // A Fetch Request signal does not cancel a custom body stream. Finish
        // bounded reading before oRPC can invoke a handler with an expired session.
        const body = request.body ? await readRequestBody(request, limit, signal) : undefined;
        signal.throwIfAborted();
        // Rebuild without inheriting the consumed provider stream. An empty
        // string body would add text/plain in Node and turn no input into a Blob
        // in oRPC's body decoder, so preserve its absence after bounded reading.
        const init: RequestInit = { method: request.method, headers: request.headers, signal };
        if (body) init.body = body;
        const result = await handler.handle(new Request(request.url, init), {
          prefix,
          context: () => {
            const context = rpcContext(
              session,
              signal,
              request.headers.get("idempotency-key") ?? undefined,
              request.headers.get("x-loom-operation") ?? undefined,
              login,
            );
            return options.liveQueries ? { ...context, liveQueries: options.liveQueries } : context;
          },
        });
        signal.throwIfAborted();
        if (!result.matched) return fail("NOT_FOUND", 404);
        const response = result.response;
        for (const [name, value] of headers) response.headers.set(name, value);
        return response;
      } catch (cause) {
        if (request.signal.aborted) return fail("CANCELLED", 499);
        if (deadline.aborted) return fail("TIMEOUT", 504);
        if (signal.aborted) return fail("UNAUTHORIZED", 401);
        if (cause instanceof RequestBodyError) return fail(cause.code, cause.code === "PAYLOAD_TOO_LARGE" ? 413 : 400);
        if (
          cause instanceof ORPCError &&
          ["UNAUTHORIZED", "INVALID_IDEMPOTENCY_KEY", "BAD_REQUEST"].includes(cause.code)
        )
          return fail(cause.code, cause.code === "UNAUTHORIZED" ? 401 : 400);
        return fail("INTERNAL_SERVER_ERROR", 500);
      }
    },
  };
}
