import { useInfiniteQuery, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { createKelloReact } from "kello/react";
import { createClient } from "./kello/_generated/api";
import { taskSelection } from "./search-selection";

export const { KelloProviderWithAuth, useKello } = createKelloReact(createClient);

export function FiniteTasks() {
  const { rpc } = useKello();
  const result = useQuery(rpc.search.list.queryOptions({ input: taskSelection }));
  if (result.isPending) return <p>Loading tasks…</p>;
  if (result.error) return <p role="alert">Could not load tasks.</p>;
  return <p>{result.data.rows.map((task) => task.title).join(", ")}</p>;
}

export function SuspenseTasks() {
  const { rpc } = useKello();
  const { data } = useSuspenseQuery(rpc.search.list.queryOptions({ input: taskSelection }));
  return <p>{data.rows.map((task) => task.title).join(", ")}</p>;
}

export function MoreTasks() {
  const { rpc } = useKello();
  const result = useInfiniteQuery(
    rpc.search.list.infiniteOptions({
      input: (cursor: string | null) => ({ ...taskSelection, cursor }),
      initialPageParam: null,
      getNextPageParam: (page) => page.nextCursor,
    }),
  );
  return (
    <>
      <p>{result.data?.pages.flatMap((page) => page.rows.map((task) => task.title)).join(", ")}</p>
      <button disabled={!result.hasNextPage || result.isFetchingNextPage} onClick={() => void result.fetchNextPage()}>
        Load more
      </button>
    </>
  );
}
