import type { OperationContext } from "@orpc/tanstack-query";

/** Native oRPC per-call context, including optional retry identity for a logical write. Client operation hints are not authorization. */
export interface RpcCallContext extends OperationContext {
  /** Reuse only when explicitly retrying the same logical write. */
  readonly idempotencyKey?: string;
}

/** Authenticated HTTP transport configuration. Prefer the generated createClient factory, which supplies the contract version. */
export interface RpcTransportOptions {
  readonly url: string;
  readonly version: string;
  /** Generated live clients send the provider session cookie alongside the verified bearer token. */
  readonly credentials?: RequestInit["credentials"];
  /** Server-only provider cookie forwarding for request-scoped SSR. Never dehydrate. */
  readonly sessionCookie?: string | undefined;
  /** Native oRPC cache namespace, assigned by the Kello provider for each identity epoch. */
  readonly cachePrefix?: string;
  /** Return credentials only for this session's identity; return null after an identity change. */
  readonly getToken: () => Promise<string | null>;
}
