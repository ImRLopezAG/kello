import { createTanstackQueryUtils } from "../../../apps/loom/src/core/client/index";
import { defineContract, eventIterator, oc, resolveContract } from "../../../apps/loom/src/core/contract/index";
import type { RouterContractClient } from "../../../apps/loom/src/core/contract/index";
import type { Id } from "../../../apps/loom/src/core/server/index";
import {
  QueryClient,
  skipToken,
  useInfiniteQuery,
  useQuery,
  useSuspenseInfiniteQuery,
  useSuspenseQuery,
} from "@tanstack/react-query";
import * as v from "valibot";

const columns = v.strictObject({ title: v.optional(v.boolean()), done: v.optional(v.boolean()) });
const inputSchema = v.strictObject({
  columns,
  with: v.optional(
    v.strictObject({ labels: v.strictObject({ columns: v.strictObject({ name: v.optional(v.boolean()) }) }) }),
  ),
  cursor: v.optional(v.string()),
});
// A projection-capable wire envelope accepts omitted fields. This is deliberately
// not a search executor: the proof checks what the current native types infer.
const pageSchema = v.strictObject({
  rows: v.array(
    v.strictObject({
      _id: v.optional(v.custom<Id<"tasks">>((value) => v.is(v.string(), value))),
      title: v.optional(v.string()),
      done: v.optional(v.boolean()),
      labels: v.optional(v.array(v.strictObject({ name: v.optional(v.string()) }))),
      project: v.optional(v.nullable(v.strictObject({ name: v.string() }))),
      at: v.optional(v.date()),
      count: v.optional(v.bigint()),
    }),
  ),
  nextCursor: v.nullable(v.string()),
});
const definition = defineContract({
  list: oc.input(inputSchema).output(pageSchema),
  watch: oc.input(inputSchema).output(eventIterator(pageSchema)),
});
const contract = resolveContract(definition, { validators: { tables: {}, id: () => v.string() } });
declare const client: RouterContractClient<typeof contract>;
const rpc = createTanstackQueryUtils(client);
const selected = { columns: { title: true }, with: { labels: { columns: { name: true } } } } as const;
const queryClient = new QueryClient();
const options = rpc.list.queryOptions({ input: selected });
type Page = v.InferOutput<typeof pageSchema>;
type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2 ? true : false;
type Assert<Condition extends true> = Condition;
export type RawOutputIsFixed = Assert<Equal<Awaited<ReturnType<typeof client.list>>, Page>>;

export async function checkRawSelection() {
  const page = await client.list(selected);
  for (const row of page.rows) {
    // @ts-expect-error (projection gap) input selection does not make this required
    const title: string = row.title;
    // @ts-expect-error (projection gap) nested selection also remains optional
    const labels: { name: string }[] = row.labels;
    const unselected: boolean | undefined = row.done;
    const id: Id<"tasks"> | undefined = row._id;
    const project: { name: string } | null | undefined = row.project;
    const at: Date | undefined = row.at;
    const count: bigint | undefined = row.count;
    // @ts-expect-error scalar ID brands are preserved despite selection erasure
    const otherId: Id<"labels"> | undefined = row._id;
    void [title, labels, unselected, id, project, at, count, otherId];
  }
}

export function useSearchSelection() {
  const finite = useQuery(options).data;
  const cached = queryClient.getQueryData(options.queryKey);
  const suspense = useSuspenseQuery(options).data;
  const infinite = useInfiniteQuery(
    rpc.list.infiniteOptions({
      input: (cursor: string | null) => ({ ...selected, cursor: cursor ?? "" }),
      initialPageParam: null,
      getNextPageParam: (page) => page.nextCursor,
    }),
  ).data;
  const live = useQuery(rpc.watch.liveOptions({ input: selected })).data;
  const liveSuspense = useSuspenseQuery(rpc.watch.liveOptions({ input: selected })).data;
  const infiniteSuspense = useSuspenseInfiniteQuery(
    rpc.list.infiniteOptions({
      input: (cursor: string | null) => ({ ...selected, cursor: cursor ?? "" }),
      initialPageParam: null,
      getNextPageParam: (page) => page.nextCursor,
    }),
  ).data;
  type NativeOutputsAreFixed = [
    Assert<Equal<typeof finite, Page | undefined>>,
    Assert<Equal<typeof cached, Page | undefined>>,
    Assert<Equal<typeof suspense, Page>>,
    Assert<Equal<NonNullable<typeof infinite>["pages"][number], Page>>,
    Assert<Equal<typeof live, Page | undefined>>,
    Assert<Equal<typeof liveSuspense, Page>>,
    Assert<Equal<(typeof infiniteSuspense)["pages"][number], Page>>,
  ];
  const proof: NativeOutputsAreFixed = [true, true, true, true, true, true, true];
  void proof;
  useQuery(rpc.list.queryOptions({ input: skipToken, enabled: false, retry: 1, staleTime: 50 }));
  useQuery(
    rpc.list.queryOptions({
      input: selected,
      initialData: { rows: [{ done: true }], nextCursor: null },
      placeholderData: { rows: [{ done: false }], nextCursor: null },
      select: (page) => page.rows.map((row) => row.title),
    }),
  );
  // @ts-expect-error declared scalar validation remains intact
  rpc.list.queryOptions({ input: selected, initialData: { rows: [{ title: 123 }], nextCursor: null } });
  for (const page of [finite, cached, suspense, ...(infinite?.pages ?? []), live]) {
    for (const row of page?.rows ?? []) {
      // @ts-expect-error (projection gap) every native option uses the fixed output
      const title: string = row.title;
      // @ts-expect-error (projection gap) native options cannot specialize nested fields
      const labels: { name: string }[] = row.labels;
      const unselected: boolean | undefined = row.done;
      void [title, labels, unselected];
    }
  }
}

type SearchInput = v.InferInput<typeof inputSchema>;
type FullTask = { title: string; done: boolean };
type PickTrue<Row, Selection> = {
  [Field in keyof Selection & keyof Row as Selection[Field] extends true ? Field : never]: Row[Field];
};
type SelectedPage<Input extends SearchInput> = {
  rows: (PickTrue<FullTask, Input["columns"]> &
    (Input extends { with: { labels: { columns: infer LabelSelection } } }
      ? { labels: PickTrue<{ name: string }, LabelSelection>[] }
      : object))[];
  nextCursor: string | null;
};
// Best-case generated declaration experiment. There is no runtime implementation
// and no consumer cast: this isolates the native utility's conditional type.
declare const genericClient: {
  list: <const Input extends SearchInput>(input: Input) => Promise<SelectedPage<Input>>;
  watch: <const Input extends SearchInput>(input: Input) => Promise<AsyncIteratorObject<SelectedPage<Input>>>;
};
const genericRpc = createTanstackQueryUtils(genericClient);

export async function checkGenericSelection() {
  const page = await genericClient.list(selected);
  for (const row of page.rows) {
    const title: string = row.title;
    const labels: { name: string }[] = row.labels;
    // @ts-expect-error raw generic calls retain the exact selected keys
    void row.done;
    void [title, labels];
  }
}

export function useGenericSearchSelection() {
  const finite = useQuery(genericRpc.list.queryOptions({ input: selected })).data;
  const infinite = useInfiniteQuery(
    genericRpc.list.infiniteOptions({
      input: (cursor: string | null) => ({ ...selected, cursor: cursor ?? "" }),
      initialPageParam: null,
      getNextPageParam: (page) => page.nextCursor,
    }),
  ).data;
  const live = useQuery(genericRpc.watch.liveOptions({ input: selected })).data;
  for (const row of [finite, ...(infinite?.pages ?? []), live].flatMap((page) => page?.rows ?? [])) {
    // @ts-expect-error (projection gap) native RouterUtils erases the generic input/output relationship
    const title: string = row.title;
    void title;
  }
}

// Internal authoring proof uses the source graph consistently; public consumer
// projection checks above continue to cover package exports independently.
import { createProjectContext } from "../../../apps/loom/src/core/server/rpc/procedure";
import type {
  SearchScope,
  SearchPolicy,
  InferSearchProjector,
  SearchProjection,
} from "../../../apps/loom/src/core/search/types";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { searchSchema, searchRelations } from "../fixtures/search-schema";
import { sql } from "drizzle-orm";

type Graph = typeof searchRelations;
const graphScope: SearchScope<Graph["tasks"], Graph> = {
  name: "root",
  version: "1",
  dependencies: ["members"],
  where: ({ table }) => sql`${table.done} = false`,
};
const legacyRoot: SearchScope<Graph["tasks"]> = {
  name: "legacy-root",
  version: "1",
  where: ({ table }) => sql`${table.done} = false`,
};
const legacyJunction: SearchScope<Graph["taskLabels"]> = {
  name: "legacy-junction",
  version: "1",
  where: ({ table }) => sql`${table.taskId} is not null`,
};
const graphPolicy = {
  columns: ["title"],
  scope: graphScope,
  through: { taskLabels: { name: "junction", version: "1", dependencies: ["teams"], where: () => sql`true` } },
  relations: {
    labels: { columns: ["name"], scope: { name: "child", version: "1", dependencies: [], where: () => sql`true` } },
  },
} satisfies SearchPolicy<Graph, Graph["tasks"]>;
const sourceValidators = createProjectContext(searchSchema, searchRelations).validators;
const declaredPair = sourceValidators.tables.tasks.search(graphPolicy);
const legacyPair = sourceValidators.tables.tasks.search({
  columns: ["title"],
  scope: legacyRoot,
  through: { taskLabels: legacyJunction },
  relations: { labels: { columns: ["name"], scope: "public" } },
});
type DeclaredProjection = InferSearchProjector<StandardSchemaV1.InferOutput<typeof declaredPair.output>>;
type LegacyProjection = InferSearchProjector<StandardSchemaV1.InferOutput<typeof legacyPair.output>>;
export type DeclarationsPreserveSelection = Assert<
  Equal<DeclaredProjection["selection"], LegacyProjection["selection"]>
>;
export type DeclarationsPreserveProjection = Assert<
  Equal<SearchProjection<DeclaredProjection, typeof selected>, SearchProjection<LegacyProjection, typeof selected>>
>;
export type DeclaredProjectionKeepsRequiredScalars = Assert<
  Equal<
    SearchProjection<DeclaredProjection, typeof selected>["rows"][number],
    { title: string; labels: { name: string }[] }
  >
>;
const declaredContract = resolveContract(
  defineContract({ list: oc.input(declaredPair.input).output(declaredPair.output) }),
  { validators: sourceValidators },
);
declare const declaredClient: RouterContractClient<typeof declaredContract>;
export type DeclaredNativeInputIsUnchanged = Assert<
  Equal<Parameters<typeof declaredClient.list>[0], StandardSchemaV1.InferInput<typeof declaredPair.input>>
>;
export type DeclaredNativeOutputIsUnchanged = Assert<
  Equal<Awaited<ReturnType<typeof declaredClient.list>>, StandardSchemaV1.InferOutput<typeof declaredPair.output>>
>;
sourceValidators.tables.tasks.search({
  columns: ["title"],
  scope: {
    ...graphScope,
    dependencies: [
      // @ts-expect-error root declarations use graph keys
      "membrs",
    ],
  },
});
sourceValidators.tables.tasks.search({
  columns: ["title"],
  scope: "public",
  through: {
    taskLabels: {
      name: "junction",
      version: "1",
      where: () => sql`true`,
      dependencies: [
        // @ts-expect-error junction declarations use the same graph keys
        "teamz",
      ],
    },
  },
});
sourceValidators.tables.tasks.search({
  columns: ["title"],
  scope: "public",
  relations: {
    project: {
      columns: ["name"],
      scope: {
        name: "child",
        version: "1",
        where: () => sql`true`,
        dependencies: [
          // @ts-expect-error child declarations use the same graph keys
          "memberz",
        ],
      },
    },
  },
});
