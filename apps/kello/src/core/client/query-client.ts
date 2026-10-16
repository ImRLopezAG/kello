import { QueryClient } from "@tanstack/query-core";
import type { QueryClientConfig } from "@tanstack/query-core";

/** Call once per browser provider or SSR request. Never share this across server requests. */
export function createQueryClient(config: QueryClientConfig = {}) {
  return new QueryClient({
    ...config,
    defaultOptions: {
      ...config.defaultOptions,
      queries: { staleTime: 60_000, retry: false, ...config.defaultOptions?.queries },
      mutations: { retry: false, ...config.defaultOptions?.mutations },
    },
  });
}
