import * as v from "valibot";
import type { JsonValue } from "../schema/fields";
import { json } from "../validation/encoding";
import { protocolVersion } from "./protocol";

export interface ClientAuth {
  readonly token: string;
  /** Stable issuer/user/tenant partition from the auth adapter; never sent as server authority. */
  readonly identityKey: string;
}
export interface ClientOptions {
  /** Lifetime of the owning authenticated connection. */
  readonly signal?: AbortSignal;
  readonly url: string;
  readonly getAuth?: (options: {
    readonly forceRefresh: boolean;
    readonly signal: AbortSignal;
  }) => Promise<ClientAuth | null>;
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
  readonly maxAttempts?: number;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}
export interface CallOptions {
  readonly signal?: AbortSignal;
  /** Bind a request to the cache/provider's current identity partition. */
  readonly identityKey?: string | null;
  /** Supply the original key when explicitly retrying a mutation after an uncertain response. */
  readonly idempotencyKey?: string;
}
export class KelloClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "KelloClientError";
  }
}
const responseSchema = v.variant("ok", [
  v.strictObject({ protocol: v.number(), ok: v.literal(true), requestId: v.string(), value: json }),
  v.strictObject({
    protocol: v.number(),
    ok: v.literal(false),
    requestId: v.string(),
    error: v.strictObject({ code: v.string(), message: v.string() }),
  }),
]);

export async function readResponse(response: Response, limit: number, signal: AbortSignal): Promise<string> {
  if (!response.body) throw new KelloClientError("INVALID_RESPONSE", "The server returned an empty response");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let text = "";
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) return text + decoder.decode();
      size += chunk.value.byteLength;
      if (size > limit)
        throw new KelloClientError("RESPONSE_TOO_LARGE", "The server response exceeds the configured limit");
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
async function backoff(attempt: number, signal: AbortSignal, retryAfter: string | null = null): Promise<void> {
  signal.throwIfAborted();
  const value = retryAfter?.trim() ?? "";
  const providerDelay = /^\d+$/.test(value)
    ? Number(value) * 1000
    : /^[A-Za-z]{3,9},? /.test(value)
      ? Math.max(0, Date.parse(value) - Date.now())
      : 0;
  // No request lives longer than 120 seconds. Capping here avoids timer overflow;
  // the request deadline cancels waits for longer provider delays before retrying.
  const minimum = Number.isNaN(providerDelay) ? 0 : Math.min(providerDelay, 120000);
  const delay = Math.max(minimum, Math.min(100 * 2 ** attempt, 1000)) + Math.random() * 100;
  await new Promise<void>((resolve, reject) => {
    const done = () => {
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(done, Math.ceil(delay));
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

export function createControlPlaneRequest(options: ClientOptions) {
  const base = new URL(options.url);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname);
  if (
    (base.protocol !== "https:" && !(base.protocol === "http:" && local)) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw new Error("Client URL must use HTTPS, except for local development, without credentials, query or fragment");
  const url = `${base.href.replace(/\/$/, "")}/api/kello`;
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  const getAuth = options.getAuth;
  const attempts = options.maxAttempts ?? 3;
  const timeout = options.timeoutMs ?? 30000;
  const limit = options.maxResponseBytes ?? 1048576;
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 5) throw new Error("Invalid client attempt limit");
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 120000) throw new Error("Invalid client timeout");
  if (!Number.isInteger(limit) || limit < 1024 || limit > 10485760) throw new Error("Invalid response byte limit");
  async function request(
    endpoint: "call" | "ticket" | "storage",
    prepare: () => { body: string; maximum: number },
    callOptions: Pick<CallOptions, "signal" | "identityKey">,
  ): Promise<JsonValue> {
    const deadline = AbortSignal.timeout(timeout);
    const signals = [deadline];
    if (options.signal) signals.push(options.signal);
    if (callOptions.signal) signals.push(callOptions.signal);
    const signal = AbortSignal.any(signals);
    try {
      signal.throwIfAborted();
      const { body, maximum } = prepare();
      let identity: string | null | undefined = callOptions.identityKey;
      let refreshed = false;
      let forceRefresh = false;
      for (let attempt = 0; attempt < maximum; attempt++) {
        signal.throwIfAborted();
        let auth: ClientAuth | null;
        try {
          auth = getAuth ? await getAuth({ forceRefresh, signal }) : null;
          forceRefresh = false;
        } catch {
          throw new KelloClientError("AUTH_ERROR", "Unable to obtain authentication");
        }
        signal.throwIfAborted();
        if (auth && (!auth.identityKey || !/^[\x21-\x7e]+$/.test(auth.token) || auth.token.length > 16384))
          throw new KelloClientError("AUTH_ERROR", "Invalid authentication state");
        const partition = auth?.identityKey ?? null;
        if (identity === undefined) identity = partition;
        else if (identity !== partition)
          throw new KelloClientError("AUTH_CHANGED", "Identity changed during the request; start a new call");
        const headers = new Headers({ "content-type": "application/json" });
        if (auth) headers.set("authorization", `Bearer ${auth.token}`);
        let response: Response;
        let text: string;
        try {
          response = await fetcher(`${url}/${endpoint}`, {
            method: "POST",
            headers,
            body,
            signal,
            credentials: "omit",
            redirect: "error",
            cache: "no-store",
          });
          if (response.status === 401 && getAuth && !refreshed) {
            await response.body?.cancel();
            refreshed = true;
            forceRefresh = true;
            attempt--;
            continue;
          }
          if ([429, 502, 503, 504].includes(response.status) && attempt + 1 < maximum) {
            await response.body?.cancel();
            await backoff(attempt, signal, response.headers.get("retry-after"));
            continue;
          }
          if (response.status === 429) {
            await response.body?.cancel();
            throw new KelloClientError("RATE_LIMITED", "The server rate limit was reached");
          }
          text = await readResponse(response, limit, signal);
        } catch (cause) {
          if (cause instanceof KelloClientError || signal.aborted) throw cause;
          if (attempt + 1 >= maximum)
            throw new KelloClientError("TRANSPORT_ERROR", "The request could not be completed");
          await backoff(attempt, signal);
          continue;
        }
        const parsed = v.safeParse(responseSchema, JSON.parse(text));
        if (!parsed.success) throw new KelloClientError("INVALID_RESPONSE", "The server returned an invalid response");
        const result = parsed.output;
        if (result.protocol !== protocolVersion)
          throw new KelloClientError(
            "PROTOCOL_MISMATCH",
            "Client and server protocol versions differ; update the client",
            result.requestId,
          );
        if (!result.ok) throw new KelloClientError(result.error.code, result.error.message, result.requestId);
        if (!response.ok)
          throw new KelloClientError(
            "INVALID_RESPONSE",
            "The server returned an inconsistent response",
            result.requestId,
          );
        return result.value;
      }
      throw new KelloClientError("TRANSPORT_ERROR", "The request could not be completed");
    } catch (cause) {
      if (callOptions.signal?.aborted) throw new KelloClientError("CANCELLED", "The request was cancelled");
      if (deadline.aborted) throw new KelloClientError("TIMEOUT", "The request timed out");
      if (cause instanceof KelloClientError) throw cause;
      throw new KelloClientError("INVALID_RESPONSE", "The request or response could not be encoded");
    }
  }
  return { request, attempts };
}
