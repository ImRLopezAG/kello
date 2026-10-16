"use client";

export type { KelloProviderAuth } from "./provider";
export { createKelloReact } from "./provider";

// Optional re-exports of the native TanStack React bindings.
export {
  QueryClientProvider,
  useQuery,
  useMutation,
  useSuspenseQuery,
  useQueries,
  useQueryClient,
} from "@tanstack/react-query";

export { useNeonLiveQuery } from "./realtime";
export { createLiveQueryHooks } from "./live-query";
export type { LiveQueryHooks } from "./live-query";
