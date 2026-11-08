import type { JsonValue } from "@kello/core/server";

/** Test-only declarations for the pinned historical bundle. */
export function createClient(options: {
  readonly url: string;
  readonly getAuth?: (options: {
    readonly forceRefresh: boolean;
    readonly signal: AbortSignal;
  }) => Promise<{ readonly token: string; readonly identityKey: string }>;
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
}): {
  call(
    reference: {
      readonly name: string;
      readonly kind: "query" | "mutation" | "action";
      readonly visibility: "public";
      readonly version: string;
    },
    input: Record<string, string>,
  ): Promise<JsonValue>;
  ticket(options: { readonly identityKey: string }): Promise<{ readonly ticket: string; readonly expiresAt: number }>;
};
