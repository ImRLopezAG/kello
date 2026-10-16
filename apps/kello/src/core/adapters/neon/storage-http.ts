import { readRequestBody, RequestBodyError } from "./request-body";
import { Hono } from "hono";
import * as v from "valibot";
import { protocolVersion } from "../../client/protocol";
import { originPolicy } from "../../server/auth/policy";
import type { VerifiedSession } from "../../server/auth/verify";
import { AuthenticationError } from "../../server/auth/verify";
import type { createStorageIntents } from "../../server/storage/intents";
import { StorageIntentError, StorageVerificationError } from "../../server/storage/contracts";
import { storageRequestValidator } from "../../validation/storage";
import { abortable } from "./abortable";

export interface StorageHttpOptions {
  readonly verify: (token: string) => Promise<VerifiedSession>;
  readonly storage?: ReturnType<typeof createStorageIntents> | undefined;
  readonly origins: readonly string[];
  readonly maxRequestBytes?: number;
  readonly requestTimeoutMs?: number;
}
const failures = {
  INVALID_REQUEST: { status: 400, message: "Invalid request" },
  UNAUTHENTICATED: { status: 401, message: "Authentication required" },
  ORIGIN_DENIED: { status: 403, message: "Origin is not allowed" },
  NOT_FOUND: { status: 404, message: "Route not found" },
  METHOD_NOT_ALLOWED: { status: 405, message: "Method not allowed" },
  PROTOCOL_MISMATCH: { status: 409, message: "Unsupported protocol version" },
  PAYLOAD_TOO_LARGE: { status: 413, message: "Request body exceeds the limit" },
  UNSUPPORTED_MEDIA_TYPE: { status: 415, message: "Expected application/json" },
  CANCELLED: { status: 499, message: "Request cancelled" },
  INTERNAL: { status: 500, message: "Request failed" },
  TIMEOUT: { status: 504, message: "Request timed out" },
  FORBIDDEN: { status: 403, message: "Storage access denied" },
  IDEMPOTENCY_CONFLICT: { status: 409, message: "Storage request conflict" },
  STORAGE_UNAVAILABLE: { status: 409, message: "Storage object or upload unavailable" },
  STORAGE_VERIFICATION_FAILED: { status: 422, message: "Storage verification failed" },
} as const;
class BoundaryError extends Error {
  constructor(readonly code: keyof typeof failures) {
    super(failures[code].message);
  }
}
function headers(origin: string | null): Headers {
  const result = new Headers({ "cache-control": "no-store", vary: "Origin" });
  if (origin !== null) result.set("access-control-allow-origin", origin);
  return result;
}
function failure(
  code: keyof typeof failures,
  origin: string | null,
  requestId: string = crypto.randomUUID(),
): Response {
  const { status, message } = failures[code];
  return Response.json(
    { protocol: protocolVersion, ok: false, requestId, error: { code, message } },
    { status, headers: headers(origin) },
  );
}

/** Authenticated signed-upload control plane, independent of procedure transport. */
export function createStorageHttpApp(options: StorageHttpOptions): Hono {
  const allows = originPolicy(options.origins);
  const verify = options.verify;
  const storage = options.storage;
  const limit = options.maxRequestBytes ?? 1048576;
  const timeout = options.requestTimeoutMs ?? 30000;
  if (!Number.isInteger(limit) || limit < 1024 || limit > 10485760) throw new Error("Invalid request byte limit");
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 120000) throw new Error("Invalid request timeout");
  const app = new Hono();
  app.onError(() => failure("INTERNAL", null));
  app.notFound(() => failure("NOT_FOUND", null));
  app.on("ALL", "/api/kello/storage", async (context) => {
    if (!storage) return failure("NOT_FOUND", null);
    const request = context.req.raw;
    const origin = request.headers.get("origin");
    if (!allows(origin)) return failure("ORIGIN_DENIED", null);
    if (request.method === "OPTIONS") {
      const requested = (request.headers.get("access-control-request-headers") ?? "")
        .split(",")
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean);
      if (
        origin === null ||
        request.headers.get("access-control-request-method") !== "POST" ||
        requested.some((name) => !["authorization", "content-type"].includes(name))
      )
        return failure("ORIGIN_DENIED", origin);
      const allowed = headers(origin);
      allowed.set("access-control-allow-methods", "POST");
      allowed.set("access-control-allow-headers", "Authorization, Content-Type");
      return new Response(null, { status: 204, headers: allowed });
    }
    if (request.method !== "POST") return failure("METHOD_NOT_ALLOWED", origin);
    if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json")
      return failure("UNSUPPORTED_MEDIA_TYPE", origin);
    const deadline = AbortSignal.timeout(timeout);
    const signal = AbortSignal.any([request.signal, deadline]);
    try {
      signal.throwIfAborted();
      let session: VerifiedSession | null = null;
      const authorization = request.headers.get("authorization");
      if (authorization !== null) {
        const bearer = /^Bearer ([^\s]+)$/i.exec(authorization)?.[1];
        if (!bearer) throw new BoundaryError("UNAUTHENTICATED");
        try {
          session = await abortable(verify(bearer), signal);
        } catch {
          throw new BoundaryError("UNAUTHENTICATED");
        }
        if (session.expiresAt <= Date.now() / 1000) throw new BoundaryError("UNAUTHENTICATED");
      } else throw new BoundaryError("UNAUTHENTICATED");
      signal.throwIfAborted();
      const text = await readRequestBody(request, Math.min(limit, 16384), signal);
      let parsed: v.InferOutput<typeof storageRequestValidator>;
      try {
        parsed = v.parse(storageRequestValidator, JSON.parse(text));
      } catch {
        throw new BoundaryError("INVALID_REQUEST");
      }
      if (parsed.protocol !== protocolVersion) throw new BoundaryError("PROTOCOL_MISMATCH");
      if (session.expiresAt <= Date.now() / 1000) throw new BoundaryError("UNAUTHENTICATED");
      const value =
        parsed.operation === "create"
          ? await storage.create(session.identity, parsed.upload, parsed.requestKey, signal)
          : await storage[parsed.operation](session.identity, parsed.id, signal);
      signal.throwIfAborted();
      if (session.expiresAt <= Date.now() / 1000) throw new BoundaryError("UNAUTHENTICATED");
      return Response.json(
        { protocol: protocolVersion, ok: true, requestId: crypto.randomUUID(), value },
        { headers: headers(origin) },
      );
    } catch (cause) {
      if (request.signal.aborted) return failure("CANCELLED", origin);
      if (deadline.aborted) return failure("TIMEOUT", origin);
      if (cause instanceof AuthenticationError) return failure("UNAUTHENTICATED", origin);
      if (cause instanceof StorageIntentError) return failure(cause.code, origin);
      if (cause instanceof StorageVerificationError) return failure("STORAGE_VERIFICATION_FAILED", origin);
      return failure(
        cause instanceof BoundaryError || cause instanceof RequestBodyError ? cause.code : "INTERNAL",
        origin,
      );
    }
  });
  return app;
}
