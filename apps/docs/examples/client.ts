import { withKelloServerSession } from "kello/client";
import { createClient, createServerClient } from "./kello/_generated/api";

/** Create once per authenticated provider scope; dispose when that scope ends. */
export function connect(url: string, getToken: () => Promise<string | null>) {
  const connection = createClient({ url, getToken });
  const { rpc } = connection;
  return {
    connection,
    greeting: rpc.tasks.greeting.queryOptions({ input: { name: "Ada" } }),
    createTask: rpc.tasks.create.mutationOptions(),
  };
}

/** The caller obtains a credential from this request's provider integration. */
export function prefetchGreeting(url: string, token: string | null, signal: AbortSignal) {
  return withKelloServerSession(
    createServerClient,
    { url, getToken: async () => token, signal },
    async ({ connection, queryClient, dehydrate }) => {
      const greeting = await queryClient.query(connection.rpc.tasks.greeting.queryOptions({ input: { name: "Ada" } }));
      return { greeting, hydration: dehydrate() };
    },
  );
}
