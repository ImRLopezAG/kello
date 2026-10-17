import { createProjectContext } from "../../../apps/kello/src/core/server/index";
import { oc } from "../../../apps/kello/src/core/contract/index";
import type { RouterContractClient } from "../../../apps/kello/src/core/contract/index";
import type { SearchRouterClient, SearchRouterUtils } from "../../../apps/kello/src/core/client/index";
import type { RpcCallContext } from "../../../apps/kello/src/core/client/index";
import type { Client } from "@orpc/client";
import type { Id } from "../../../apps/kello/src/core/server/index";
import {
  QueryClient,
  useQuery,
  useInfiniteQuery,
  useSuspenseQuery,
  useSuspenseInfiniteQuery,
  skipToken,
} from "@tanstack/react-query";
import { searchSchema, searchRelations, titleSelection, nestedSelection } from "../fixtures/search-schema";
import * as v from "valibot";

const { validators } = createProjectContext(searchSchema, searchRelations);
const policy = {
  scope: "public",
  through: { taskLabels: "public" },
  columns: ["_id", "title", "done", "at", "count", "amount"],
  filter: ["title", "done", "at", "count", "amount"],
  order: ["title", "at", "count", "amount"],
  text: ["title"],
  relations: {
    labels: { scope: "public", columns: ["name"], order: ["name"], filter: ["name"] },
    project: {
      scope: "public",
      columns: ["_id", "name"],
      relations: {
        organization: {
          scope: "public",
          columns: ["name"],
          relations: {
            teams: {
              scope: "public",
              columns: ["name"],
              relations: { members: { scope: "public", columns: ["name"] } },
            },
          },
        },
      },
    },
  },
} as const;
const search = validators.tables.tasks.search(policy);
const contract = {
  list: oc
    .errors({ NOT_FOUND: { data: v.object({ entity: v.string() }) } })
    .input(search.input)
    .output(search.output),
  ordinary: oc.output(v.string()),
};
type Native = RouterContractClient<typeof contract, RpcCallContext>;
type NativeError = Native["list"] extends Client<object, infer _Input, infer _Output, infer Error> ? Error : never;
declare const client: SearchRouterClient<Native>;
declare const rpc: SearchRouterUtils<Native>;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

export async function raw() {
  const result = await client.list(titleSelection);
  type Proof = Assert<Equal<keyof (typeof result.rows)[number], "title">>;
  const proof: Proof = true;
  const title: string | undefined = result.rows[0]?.title;
  void [proof, title];
  const nested = await client.list(nestedSelection);
  const member: string | undefined = nested.rows[0]?.project?.organization.teams[0]?.members[0]?.name;
  const id: Id<"tasks"> | undefined = nested.rows[0]?._id;
  const at: Date | undefined = nested.rows[0]?.at;
  const count: bigint | undefined = nested.rows[0]?.count;
  const amount: string | undefined = nested.rows[0]?.amount;
  const filtered = await client.list({
    columns: { title: true },
    where: {
      AND: [{ count: { gte: 9007199254740993n } }, { at: { lt: new Date() } }],
      title: { contains: "one", insensitive: true },
      done: { eq: false },
    },
    orderBy: [{ field: "amount", direction: "desc", nulls: "last" }],
    limit: 5,
    count: true,
  });
  const filteredTitle: string | undefined = filtered.rows[0]?.title;
  void filteredTitle;
  const ordinary: string = await client.ordinary();
  void [member, ordinary, id, at, count, amount];
}
export function useSelection() {
  const options = rpc.list.queryOptions({ input: titleSelection });
  const result = useQuery(options);
  type ErrorType = Assert<Equal<NonNullable<typeof result.error>, NativeError>>;
  const errorType: ErrorType = true;
  const cached = new QueryClient().getQueryData(options.queryKey);
  const suspense = useSuspenseQuery(options);
  const infiniteOptions = rpc.list.infiniteOptions({
    input: (cursor: string | null) => ({ ...titleSelection, cursor }),
    initialPageParam: null,
    getNextPageParam: (page) => page.nextCursor,
  });
  const infinite = useInfiniteQuery(infiniteOptions);
  const infiniteSuspense = useSuspenseInfiniteQuery(infiniteOptions);
  for (const page of [
    result.data,
    cached,
    suspense.data,
    ...(infinite.data?.pages ?? []),
    ...infiniteSuspense.data.pages,
  ]) {
    const title: string | undefined = page?.rows[0]?.title;
    void title;
  }
  const selected = useQuery(
    rpc.list.queryOptions({ input: titleSelection, select: (page) => page.rows.map((row) => row.title) }),
  );
  const data: string[] | undefined = selected.data;
  const initial = useQuery(
    rpc.list.queryOptions({
      input: titleSelection,
      initialData: { rows: [{ title: "ok", done: true }], nextCursor: null, previousCursor: null },
    }),
  );
  const defined: string | undefined = initial.data.rows[0]?.title;
  type InitialKeys = Assert<Equal<keyof (typeof initial.data.rows)[number], "title">>;
  const initialKeys: InitialKeys = true;
  useQuery(rpc.list.queryOptions({ input: skipToken, enabled: false }));
  const custom = rpc.list.queryOptions({
    input: titleSelection,
    context: { idempotencyKey: "request" },
    retry: 1,
    staleTime: 100,
    queryFn: async ({ signal }) => {
      signal.throwIfAborted();
      return { rows: [{ title: "custom" }], nextCursor: null, previousCursor: null };
    },
    placeholderData: () => ({ rows: [{ title: "placeholder" }], nextCursor: null, previousCursor: null }),
  });
  void [data, defined, initialKeys, custom, errorType];
}

export async function nonliteralSelections(flag: boolean) {
  const excluded = await client.list({ columns: { title: false }, with: { labels: {} } });
  type LabelKeys = Assert<Equal<keyof NonNullable<(typeof excluded.rows)[number]["labels"]>[number], "name">>;
  const keys: LabelKeys = true;
  const nestedExcluded = await client.list({
    with: { project: { columns: { _id: false }, with: { organization: {} } } },
  });
  type ProjectKeys = Assert<
    Equal<keyof NonNullable<(typeof nestedExcluded.rows)[number]["project"]>, "name" | "organization">
  >;
  const projectKeys: ProjectKeys = true;
  const conditional = await client.list(flag ? { columns: { title: true } } : { columns: { done: true } });
  if ("title" in conditional.rows[0]!) {
    const title: string = conditional.rows[0]!.title;
    void title;
  }
  type WidenedSelection = { columns: { title: boolean } };
  const widened: WidenedSelection = { columns: { title: flag } };
  const result = await client.list(widened);
  type WidenedTitle = Assert<Equal<(typeof result.rows)[number]["title"], string | undefined>>;
  const widenedTitle: WidenedTitle = true;
  const optional: { columns?: { title: true } } = flag ? { columns: { title: true } } : {};
  const maybeDefault = await client.list(optional);
  type OptionalDone = Assert<Equal<(typeof maybeDefault.rows)[number]["done"], boolean | undefined>>;
  const optionalDone: OptionalDone = true;
  const optionalRelation: { with: { labels?: { columns: { name: true } } } } = flag
    ? { with: { labels: { columns: { name: true } } } }
    : { with: {} };
  const related = await client.list(optionalRelation);
  type OptionalRelation = Assert<Equal<(typeof related.rows)[number]["labels"], { name: string }[] | undefined>>;
  const optionalLabels: OptionalRelation = true;
  void [keys, projectKeys, widenedTitle, optionalDone, optionalLabels];
}

// Predeclared readonly tuples retain root and child order/filter capabilities.
export async function orderedNestedSelection() {
  const input = {
    columns: { title: true },
    with: {
      labels: {
        columns: { name: true },
        orderBy: [{ field: "name", direction: "asc" }],
        where: { name: { in: ["a", "b"] } },
      },
    },
    orderBy: [{ field: "title", direction: "desc" }],
  } as const;
  const page = await client.list(input);
  const name: string | undefined = page.rows[0]?.labels[0]?.name;
  return name;
}
