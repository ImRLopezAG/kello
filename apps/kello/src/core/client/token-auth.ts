import type { KelloAuth } from "./cookie-session";

/** Bridge to an external provider that owns login, sessions, and refresh. Notify subscribers when identity changes so stale token requests cannot attach to a new session. */
export interface TokenAuthOptions {
  /** Read current provider initialization and sign-in state synchronously. */
  readonly getState: () => { readonly isLoading: boolean; readonly isAuthenticated: boolean };
  /** Obtain a token for the current identity, refreshing when requested. */
  readonly getToken: (options: { readonly forceRefresh: boolean }) => Promise<string | null>;
  /** Subscribe to auth changes; return a cleanup function. */
  readonly subscribe?: (onChange: () => void) => () => void;
}

/** Providers own sessions. Kello consumes their tokens and verifies identity on the server. */
export function createTokenAuth(options: TokenAuthOptions): KelloAuth {
  let revision = 0;
  return {
    async getToken(request) {
      const state = options.getState();
      if (state.isLoading || !state.isAuthenticated) return null;
      const generation = revision;
      const token = await options.getToken({ forceRefresh: request?.forceRefresh ?? false });
      const current = options.getState();
      return generation === revision && !current.isLoading && current.isAuthenticated ? token : null;
    },
    subscribe(onChange) {
      return (
        options.subscribe?.(() => {
          revision++;
          onChange();
        }) ?? (() => {})
      );
    },
  };
}
