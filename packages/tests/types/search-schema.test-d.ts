import type { BuildQueryResult } from "drizzle-orm";
import type { Id } from "../../../apps/kello/src/core/server/index";
import type { Client } from "@orpc/client";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { keepPreviousData, QueryClient, useQuery } from "@tanstack/react-query";
import { searchRelations } from "../fixtures/search-schema";
import type {
  DonePage,
  NestedPage,
  SearchRow,
  TitlePage,
  titleSelection,
  doneSelection,
} from "../fixtures/search-schema";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2 ? true : false;
type Assert<Condition extends true> = Condition;
type NestedRow = NestedPage["rows"][number];
type Project = NonNullable<NestedRow["project"]>;
type Organization = Project["organization"];
type Team = Organization["teams"][number];
type Member = Team["members"][number];

// These assertions prove native schema/graph derivation, not generated-client compatibility.
export type NativeProjectionProof = [
  Assert<Equal<keyof SearchRow<typeof titleSelection>, "title">>,
  Assert<Equal<keyof SearchRow<typeof doneSelection>, "done">>,
  Assert<Equal<SearchRow<typeof titleSelection>["title"], string>>,
  Assert<Equal<SearchRow<typeof doneSelection>["done"], boolean>>,
  Assert<Equal<keyof NestedRow, "_id" | "at" | "count" | "amount" | "labels" | "project">>,
  Assert<Equal<NestedRow["_id"], Id<"tasks">>>,
  Assert<Equal<NestedRow["at"], Date>>,
  Assert<Equal<NestedRow["count"], bigint>>,
  Assert<Equal<NestedRow["amount"], string>>,
  Assert<Equal<NestedRow["labels"], { name: string }[]>>,
  Assert<Equal<Extract<NestedRow["project"], null>, null>>,
  Assert<Equal<keyof Project, "name" | "organization">>,
  Assert<Equal<Extract<Organization, null>, never>>,
  Assert<Equal<keyof Organization, "name" | "teams">>,
  Assert<Equal<keyof Team, "name" | "members">>,
  Assert<Equal<keyof Member, "name">>,
  Assert<Equal<Member["name"], string>>,
];

type FilteredProject = BuildQueryResult<
  typeof searchRelations,
  (typeof searchRelations)["projects"],
  { columns: { name: true }; with: { organization: { columns: { name: true }; where: { name: { eq: string } } } } }
>;
export type FilteredOneCanBeAbsent = Assert<Equal<FilteredProject["organization"], { name: string } | null>>;

type Conditional = BuildQueryResult<
  typeof searchRelations,
  (typeof searchRelations)["tasks"],
  typeof titleSelection | typeof doneSelection
>;
export type ConditionalMustBeNarrowed = Assert<Equal<Conditional, { title: string } | { done: boolean }>>;
type Widened = BuildQueryResult<
  typeof searchRelations,
  (typeof searchRelations)["tasks"],
  { columns: { title?: boolean; done?: boolean } }
>;
export type WidenedDoesNotInventFields = Assert<Equal<keyof Widened, never>>;

// Even a procedure with an exact, schema-derived fixed output cannot constrain
// defaults installed separately on the caller's native QueryClient.
export function configureNativeSearchDefaults() {
  const initialData: TitlePage = { rows: [{ title: "initial" }], nextCursor: null };
  const cache = new QueryClient({ defaultOptions: { queries: { placeholderData: keepPreviousData, initialData } } });
  cache.setQueryDefaults(["search-proof"], { placeholderData: keepPreviousData, initialData });
  return cache;
}

export function useNativeDoneProof(client: { search: Client<object, typeof doneSelection, DonePage, Error> }) {
  const rpc = createTanstackQueryUtils(client, { prefix: "search-proof" });
  const result = useQuery(rpc.search.queryOptions({ input: { columns: { done: true } } }));
  const done: boolean | undefined = result.data?.rows[0]?.done;
  type NativeClaimsDoneIsPresent = Assert<Equal<NonNullable<typeof result.data>["rows"][number]["done"], boolean>>;
  const assertion: NativeClaimsDoneIsPresent = true;
  void assertion;
  return done;
}
