import * as v from "valibot";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { createORPCClient } from "@orpc/client";
import type { Client } from "@orpc/client";
import { createRpcHttpTransport } from "kello/client";
import { QueryClient, QueryClientProvider, useQuery, useMutation, useMutationState } from "@tanstack/react-query";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";

type Router = {
  write: Client<Record<never, never>, number, number, Error>;
  read: Client<Record<never, never>, undefined, AsyncIteratorObject<{ count: number }, void, void>, Error>;
};
const transport = createRpcHttpTransport({
  url: location.origin,
  version: "a".repeat(64),
  getToken: async () => "test-token",
});
const link = transport.link;
const queryClient = new QueryClient();
const raw = createORPCClient<Router>(link);
const api = createTanstackQueryUtils(raw);
function Result({ label }: { label: string }) {
  const value = useQuery(api.read.liveOptions({ retry: 3, retryDelay: 10, select: (result) => result.count }));
  const pending = useMutationState({
    filters: { mutationKey: api.write.mutationKey(), status: "pending" },
    select: (mutation) => v.parse(v.number(), mutation.state.variables),
  });
  return <output data-testid={label}>{pending.at(-1) ?? value.data ?? "empty"}</output>;
}
function Edit() {
  const queryKey = api.read.liveOptions().queryKey;
  const mutation = useMutation(
    api.write.mutationOptions({
      onMutate: async (count) => {
        await queryClient.cancelQueries({ queryKey });
        const previous = queryClient.getQueryData(queryKey);
        queryClient.setQueryData(queryKey, { count });
        return { previous };
      },
      onError: (_error, _input, rollback) => {
        if (rollback) queryClient.setQueryData(queryKey, rollback.previous);
      },
      onSettled: () => {
        void queryClient.invalidateQueries({ queryKey });
      },
    }),
  );
  return (
    <>
      <button onClick={() => mutation.mutate(9)}>Save</button>
      <button
        onClick={() => {
          void queryClient.invalidateQueries({ queryKey });
        }}
      >
        Refetch
      </button>
      <output data-testid="mutation">{mutation.status}</output>
    </>
  );
}
function App() {
  const [active, setActive] = useState(true);
  return (
    <QueryClientProvider client={queryClient}>
      <button
        onClick={() => {
          queryClient.clear();
          transport.dispose();
          setActive(false);
        }}
      >
        Sign out
      </button>
      {active ? (
        <>
          <Edit />
          <Result label="one" />
          <Result label="two" />
        </>
      ) : (
        <p>Signed out</p>
      )}
    </QueryClientProvider>
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing root");
createRoot(root).render(<App />);
