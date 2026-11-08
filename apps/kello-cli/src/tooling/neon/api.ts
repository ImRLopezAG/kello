import { NeonAuthError, createNeonClient } from "@neon/sdk";
import { AsyncLocalStorage } from "node:async_hooks";
import { request as httpsRequest } from "node:https";
import { createRealNeonApi, type NeonApi } from "@neon/config-runtime/v1";
import * as v from "valibot";
import { NeonCredentialError, createNeonCredentials, type NeonCredentialOptions } from "./credentials";

const invocation = new AsyncLocalStorage<ReturnType<typeof createNeonCredentials>>();
export function withNeonCredentials<T>(options: NeonCredentialOptions, run: () => T): T {
  return invocation.run(createNeonCredentials(options), run);
}

/** The current invocation's key, for child processes that receive it through their environment. */
export function resolveNeonApiKey(): Promise<string> {
  return (invocation.getStore() ?? createNeonCredentials()).resolve();
}

const replayLimit = 1 << 20;
type Credentials = ReturnType<typeof createNeonCredentials>;

/**
 * Bodies up to 1 MiB are buffered so the single 401 replay can resend them; larger or streamed
 * bodies are forwarded once, unbuffered, and a 401 for them is terminal.
 */
async function replayableBody(request: Request) {
  if (!request.body) return { body: null, replayable: true };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) {
      const body = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return { body, replayable: true };
    }
    chunks.push(next.value);
    size += next.value.byteLength;
    if (size > replayLimit) break;
  }
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
    },
    async pull(controller) {
      const next = await reader.read();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    cancel: (reason) => reader.cancel(reason),
  });
  return { body, replayable: false };
}

/** The same single re-resolve and retry as `invoke` below: a 401 request was not applied. */
export function createRetryingFetch(credentials: Pick<Credentials, "resolve">) {
  return Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
      const { body, replayable } = await replayableBody(request);
      const send = (headers: Headers) =>
        fetch(request.url, {
          method: request.method,
          headers,
          body,
          signal: request.signal,
          redirect: request.redirect,
        });
      const response = await send(new Headers(request.headers));
      if (response.status !== 401 || !replayable) return response;
      await response.body?.cancel();
      const headers = new Headers(request.headers);
      headers.set("Authorization", `Bearer ${await credentials.resolve()}`);
      return send(headers);
    },
    { preconnect: fetch.preconnect },
  );
}

/**
 * Terminal SDK auth failures become fixed Kello guidance, so provider response text never reaches
 * the caller. A 401 here already survived the single re-resolve and retry above.
 */
export function neonAuthFailure(cause: Error): Error {
  if (!(cause instanceof NeonAuthError)) return cause;
  if (cause.status === 403) return new NeonCredentialError("NEON_PERMISSION_DENIED");
  return (invocation.getStore() ?? createNeonCredentials()).rejected();
}
/** Wrap every SDK operation made through `createKelloNeonClient`. */
export async function neonCall<T>(operation: Promise<T>): Promise<T> {
  try {
    return await operation;
  } catch (cause) {
    throw cause instanceof Error ? neonAuthFailure(cause) : cause;
  }
}

export function createKelloNeonClient() {
  const credentials = invocation.getStore() ?? createNeonCredentials();
  return createNeonClient({
    apiKey: () => credentials.resolve(),
    throwOnError: true,
    retries: 0,
    requestTimeoutMs: 30_000,
    fetch: createRetryingFetch(credentials),
  });
}

const inProgress = new Set(["scheduling", "running", "cancelling"]);
/** Operations created this long before the recorded create time still count, absorbing clock skew. */
const provisioningSkewMs = 60_000;
const provisioningPageCap = 20;

/**
 * Waits for a created resource's provisioning to finish. Creates are sent without SDK readiness
 * polling so their result can be recorded first; this is the separate readiness step.
 *
 * The operations list documents no sort order, so a busy project's create operations may sit on
 * any page: every page is read up to the end or `provisioningPageCap`, and `since` (recorded just
 * before the create POST) only filters out operations that began earlier than it, less the skew.
 */
export async function waitForProvisioning(
  client: ReturnType<typeof createKelloNeonClient>,
  projectId: string,
  branchId?: string,
  since?: number,
): Promise<void> {
  const list = client.operations.list({ projectId });
  const cutoff = since === undefined ? undefined : since - provisioningSkewMs;
  const pending: Awaited<ReturnType<typeof list.page>>["items"] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < provisioningPageCap; page++) {
    const result = await neonCall(list.page(cursor));
    // Wait only on operations still in progress. Terminal failures, including unrelated ones by other
    // actors, must not block an acknowledged create; its own verification step catches a broken result.
    for (const operation of result.items) {
      if (seen.has(operation.id)) continue;
      seen.add(operation.id);
      const created = Date.parse(operation.created_at);
      if (
        (branchId === undefined || operation.branch_id === branchId) &&
        inProgress.has(operation.status) &&
        // An unparseable timestamp cannot be excluded safely.
        (cutoff === undefined || Number.isNaN(created) || created >= cutoff)
      )
        pending.push(operation);
    }
    // Neon may return a cursor with an empty last page; a repeated cursor also ends the walk.
    if (!result.items.length || !result.cursor || result.cursor === cursor) break;
    cursor = result.cursor;
  }
  if (pending.length) await neonCall(client.operations.waitFor({ operations: pending }));
}

/** Resolve before every operation; never replay an ambiguous resource mutation (an unauthenticated 401 is not ambiguous). */
export function createKelloNeonApi(): NeonApi {
  const credentials = invocation.getStore() ?? createNeonCredentials();
  async function authenticated() {
    return createRealNeonApi({ apiKey: await credentials.resolve(), retryOnLocked: { maxAttempts: 1 } });
  }
  function statusOf(cause: unknown) {
    const response = v.safeParse(
      v.union([v.object({ details: v.object({ status: v.number() }) }), v.object({ status: v.number() })]),
      cause,
    );
    if (!response.success) return undefined;
    return "status" in response.output ? response.output.status : response.output.details.status;
  }
  async function invoke<T>(run: (api: NeonApi) => Promise<T>): Promise<T> {
    // Neon intermittently rejects a valid, unexpired token with 401. A rejected request was not
    // authenticated, so it was not applied; like the Neon CLI, re-resolve the credential (adopting
    // one another `kello login --force` stored) and retry once. Only a repeated 401 means the key is revoked.
    for (let attempt = 0; attempt < 2; attempt++) {
      const api = await authenticated();
      try {
        return await run(api);
      } catch (cause) {
        const status = statusOf(cause);
        if (status === 401 && attempt === 0) continue;
        if (status === 401) throw credentials.rejected();
        if (status === 403) throw new NeonCredentialError("NEON_PERMISSION_DENIED");
        throw cause;
      }
    }
    throw credentials.rejected();
  }
  return {
    listProjects: (...args) => invoke((api) => api.listProjects(...args)),
    getProject: (...args) => invoke((api) => api.getProject(...args)),
    createProject: (...args) => invoke((api) => api.createProject(...args)),
    updateProject: (...args) => invoke((api) => api.updateProject(...args)),
    listBranches: (...args) => invoke((api) => api.listBranches(...args)),
    createBranch: (...args) => invoke((api) => api.createBranch(...args)),
    updateBranch: (...args) => invoke((api) => api.updateBranch(...args)),
    listEndpoints: (...args) => invoke((api) => api.listEndpoints(...args)),
    updateEndpoint: (...args) => invoke((api) => api.updateEndpoint(...args)),
    listBranchRoles: (...args) => invoke((api) => api.listBranchRoles(...args)),
    listBranchDatabases: (...args) => invoke((api) => api.listBranchDatabases(...args)),
    getConnectionUri: (...args) => invoke((api) => api.getConnectionUri(...args)),
    getNeonAuth: (...args) => invoke((api) => api.getNeonAuth(...args)),
    enableNeonAuth: (...args) => invoke((api) => api.enableNeonAuth(...args)),
    getNeonDataApi: (...args) => invoke((api) => api.getNeonDataApi(...args)),
    enableProjectBranchDataApi: (...args) => invoke((api) => api.enableProjectBranchDataApi(...args)),
    updateProjectBranchDataApi: (...args) => invoke((api) => api.updateProjectBranchDataApi(...args)),
    deleteProjectBranchDataApi: (...args) => invoke((api) => api.deleteProjectBranchDataApi(...args)),
    listBranchBuckets: (...args) => invoke((api) => api.listBranchBuckets(...args)),
    createBranchBucket: (...args) => invoke((api) => api.createBranchBucket(...args)),
    deleteBranchBucket: (...args) => invoke((api) => api.deleteBranchBucket(...args)),
    getProjectBranchStorage: (...args) => invoke((api) => api.getProjectBranchStorage(...args)),
    listBranchFunctions: (...args) => invoke((api) => api.listBranchFunctions(...args)),
    deleteBranchFunction: (...args) => invoke((api) => api.deleteBranchFunction(...args)),
    deployBranchFunction: (...args) => invoke((api) => api.deployBranchFunction(...args)),
    getBranchFunction: (...args) =>
      invoke(async (api) => {
        if (!api.getBranchFunction) throw new Error("Neon adapter does not support getBranchFunction");
        return api.getBranchFunction(...args);
      }),
    listBranchTriggers: (...args) => invoke((api) => api.listBranchTriggers(...args)),
    createBranchTrigger: (...args) => invoke((api) => api.createBranchTrigger(...args)),
    updateBranchTrigger: (...args) => invoke((api) => api.updateBranchTrigger(...args)),
    deleteBranchTrigger: (...args) => invoke((api) => api.deleteBranchTrigger(...args)),
    listBranchCustomDomains: (...args) =>
      invoke(async (api) => {
        if (!api.listBranchCustomDomains) throw new Error("Neon adapter does not support listBranchCustomDomains");
        return api.listBranchCustomDomains(...args);
      }),
    registerBranchCustomDomain: (...args) =>
      invoke(async (api) => {
        if (!api.registerBranchCustomDomain)
          throw new Error("Neon adapter does not support registerBranchCustomDomain");
        return api.registerBranchCustomDomain(...args);
      }),
    deleteBranchCustomDomain: (...args) =>
      invoke(async (api) => {
        if (!api.deleteBranchCustomDomain) throw new Error("Neon adapter does not support deleteBranchCustomDomain");
        return api.deleteBranchCustomDomain(...args);
      }),
    createCredential: (...args) => invoke((api) => api.createCredential(...args)),
    listCredentials: (...args) => invoke((api) => api.listCredentials(...args)),
    revealCredential: (...args) => invoke((api) => api.revealCredential(...args)),
    revokeCredential: (...args) => invoke((api) => api.revokeCredential(...args)),
  };
}

export class RealtimeError extends Error {
  constructor(
    readonly code:
      | "REALTIME_DENIED"
      | "REALTIME_PROVIDER_FAILED"
      | "REALTIME_COMPUTE_MISSING"
      | "REALTIME_ORIGINS_INVALID"
      | "REALTIME_ORIGINS_CONFLICT"
      | "REALTIME_TARGET_PROTECTED"
      | "REALTIME_PROXY_PENDING",
    message: string,
  ) {
    super(message);
    this.name = "RealtimeError";
  }
}
export interface RealtimeBranchState {
  readonly enabled: boolean;
  readonly pending: boolean;
  readonly invocationUrl: string | undefined;
  readonly allowedOrigins: readonly string[];
}
export interface RealtimeEnableInput {
  readonly projectId: string;
  readonly branchId: string;
  readonly allowedOrigins: readonly string[];
  readonly timeoutMs: number;
}
export interface RealtimeProvider {
  get(projectId: string, branchId: string): Promise<RealtimeBranchState>;
  hasCompute(projectId: string, branchId: string): Promise<boolean>;
  /** Resolves when ready or when the bounded wait expires; callers re-read state before reporting. */
  enable(input: RealtimeEnableInput): Promise<void>;
  /** Server-only signing secret. Never persist, log, or place in public configuration. */
  secret(projectId: string, branchId: string): Promise<string>;
  /**
   * Resolves once the Realtime proxy upgrades a handshake from every origin. The control plane
   * reports ready before the proxy enforces a changed allowlist. Providers without it skip the wait.
   */
  waitForProxyOrigins?(invocationUrl: string, origins: readonly string[]): Promise<void>;
}
/** Resolves with the handshake's HTTP status: 101 when upgraded, 0 for a network failure. */
export type RealtimeHandshake = (url: URL, origin: string) => Promise<number>;
export interface RealtimeProxyWaitOptions {
  readonly handshake?: RealtimeHandshake;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
  /** Called once per origin before its first handshake. */
  readonly onWaiting?: (origin: string) => void;
}
interface Branch {
  projectId: string;
  branchId: string;
}
interface RealtimeClient {
  realtime: {
    get(params: Branch): Promise<{
      enabled: boolean;
      pending: boolean;
      invocation_url?: string;
      allowed_origins?: string[];
    }>;
    enable(
      params: Branch & { allowed_origins?: string[] },
      options: { waitForReadiness: boolean; wait: { timeoutMs: number } },
    ): Promise<void>;
    secret(params: Branch): Promise<{ secret: string; pending: boolean }>;
  };
  postgres: { endpoints: { listByBranch(params: Branch): Promise<readonly unknown[]> } };
}

/** Provider text can echo request data, so only fixed messages leave this boundary. */
function realtimeFailure(cause: unknown): Error {
  if (cause instanceof NeonCredentialError) return cause;
  if (cause instanceof NeonAuthError) return neonAuthFailure(cause);
  const kind = cause instanceof Error && "kind" in cause ? cause.kind : undefined;
  return kind === "auth"
    ? new RealtimeError(
        "REALTIME_DENIED",
        "Neon denied Realtime access for the selected branch. Check profile permissions.",
      )
    : new RealtimeError(
        "REALTIME_PROVIDER_FAILED",
        "Neon Realtime request failed. Check `kello realtime status` before retrying.",
      );
}

const realtimeProtocol = "neon.realtime.v2";

/** A real WebSocket opening handshake whose status is read directly; the socket is closed at once. */
function realtimeHandshake(url: URL, origin: string): Promise<number> {
  return new Promise((resolve) => {
    const target = new URL(url);
    target.protocol = "https:";
    const request = httpsRequest(target, {
      timeout: 10_000,
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        Origin: origin,
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64"),
        "Sec-WebSocket-Protocol": realtimeProtocol,
      },
    });
    request.once("upgrade", (_response, socket) => {
      socket.destroy();
      resolve(101);
    });
    request.once("response", (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.once("timeout", () => request.destroy());
    request.once("error", () => resolve(0));
    request.end();
  });
}

/** 403 means the proxy has not admitted the origin yet; any other refusal is a real failure. */
export async function waitForRealtimeProxyOrigins(
  invocationUrl: string,
  origins: readonly string[],
  options: RealtimeProxyWaitOptions = {},
): Promise<void> {
  const handshake = options.handshake ?? realtimeHandshake;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? Bun.sleep;
  const intervalMs = options.intervalMs ?? 2_000;
  const url = new URL(invocationUrl);
  url.protocol = "wss:";
  const deadline = now() + (options.timeoutMs ?? 120_000);
  for (const origin of origins) {
    options.onWaiting?.(origin);
    for (;;) {
      const status = await handshake(url, origin);
      if (status === 101) break;
      if (status !== 403 && status !== 0)
        throw new RealtimeError(
          "REALTIME_PROVIDER_FAILED",
          `The Realtime proxy refused a handshake from ${origin} with HTTP ${status}. Check kello realtime status before retrying.`,
        );
      if (now() >= deadline)
        throw new RealtimeError(
          "REALTIME_PROXY_PENDING",
          `The Realtime allowlist is saved, but the Realtime proxy does not accept ${origin} yet. Wait a minute, then connect again or run kello realtime status.`,
        );
      await sleep(intervalMs);
    }
  }
}

export function createRealtimeProvider(
  client: RealtimeClient = createKelloNeonClient(),
  proxy: RealtimeProxyWaitOptions = {},
): RealtimeProvider & Required<Pick<RealtimeProvider, "waitForProxyOrigins">> {
  return {
    waitForProxyOrigins: (invocationUrl, origins) => waitForRealtimeProxyOrigins(invocationUrl, origins, proxy),
    get: async (projectId, branchId) => {
      try {
        const state = await client.realtime.get({ projectId, branchId });
        return {
          enabled: state.enabled,
          pending: state.pending,
          invocationUrl: state.invocation_url,
          allowedOrigins: state.allowed_origins ?? [],
        };
      } catch (cause) {
        throw realtimeFailure(cause);
      }
    },
    hasCompute: async (projectId, branchId) => {
      try {
        return (await client.postgres.endpoints.listByBranch({ projectId, branchId })).length > 0;
      } catch (cause) {
        throw realtimeFailure(cause);
      }
    },
    enable: async ({ projectId, branchId, allowedOrigins, timeoutMs }) => {
      try {
        await client.realtime.enable(
          { projectId, branchId, allowed_origins: [...allowedOrigins] },
          { waitForReadiness: true, wait: { timeoutMs } },
        );
      } catch (cause) {
        // An expired readiness wait means the change was accepted and is still pending.
        if (
          cause instanceof Error &&
          "kind" in cause &&
          cause.kind === "timeout" &&
          "source" in cause &&
          cause.source === "wait"
        )
          return;
        throw realtimeFailure(cause);
      }
    },
    secret: async (projectId, branchId) => {
      let state;
      try {
        state = await client.realtime.secret({ projectId, branchId });
      } catch (cause) {
        throw realtimeFailure(cause);
      }
      // A pending rotation has not yet published the replacement secret.
      if (state.pending) throw new RealtimeError("REALTIME_PROVIDER_FAILED", "Neon Realtime secret is still rotating.");
      return state.secret;
    },
  };
}
