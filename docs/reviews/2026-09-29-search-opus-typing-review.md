# Claude Opus review: selection-aware oRPC typings

Date: 2026-09-29. User requested Claude Opus 5.5 at low effort. Two read-only Claude CLI calls reviewed the existing U1 proof and a compiler-checked correction. No implementation, dependency, generated application file, or plan was changed.

## Outcome

**There is a concrete candidate for the clean API:** generate input-dependent declarations for the raw client and for the existing `connection.rpc` property. The runtime remains the native oRPC client and `createTanstackQueryUtils` result. Consumers keep the existing method syntax:

```ts
const { rpc } = createClient({ getToken });
const tasks = useQuery(
  rpc.tasks.search.queryOptions({
    input: {
      columns: { title: true },
      with: { labels: { columns: { name: true } } },
    },
    enabled: true,
  }),
);
```

This is a reviewed candidate, not an implemented API. A plain consumer call to upstream `createTanstackQueryUtils(connection.client)` still gets upstream's fixed-output types. Generated `connection.rpc` declarations would carry the projection relation separately. That distinction must be documented; it does not prove that unchanged upstream return typing supports dependent output.

## What was verified locally

The reviewer had no tools or filesystem access. The main agent performed these checks using installed TypeScript 7.0.2, oRPC 2.0.0-beta.40 and TanStack React Query 5.103.2:

1. The original candidate fails compilation: circular generic constraints (`TS2313`) and a nested polymorphic `this` expression (`TS2526`). These were proposal defects, not dependency failures.
2. A small correction moves the excess-key guard into parameter types and the projected page expression into a helper alias. The native option aliases are exported, so no vendoring is needed.
3. The corrected local declaration sketch compiles with positive/negative assertions for required selected root fields, nested many/M2M-shaped fields, nullable one relations, rejected unselected output fields, ID brands, Date, bigint, raw calls, native query/infinite/live option consumption, suspense query, tagged cache/key access, select callbacks, skipToken, enabled and staleTime.
4. Additional assertions reject missing/wrong selected initial-data fields, invalid custom query-function results, unknown root/nested selection keys in variables, and reading an explicitly excluded field. No consumer cast or `any` result field was added.
5. An extra unselected field in `initialData` remains accepted under native structural compatibility. Its presence does not make that field part of the selected result type. The reviewer's original claim that native typing rejects every extra initial-data field was corrected.

These are local declaration tests with a declared connection. They do not prove that emitted packed declarations, real generated raw-client context/options/errors, runtime input forwarding or database output validation already implement this design.

## Reproduced safety gap

`placeholderData: keepPreviousData` can preserve a previous query's rows while a new input requests different columns. The sketch types those rows as the new selection. A native TanStack QueryObserver reproduction returned:

```json
{
  "isPlaceholderData": true,
  "selectedDoneMissing": true,
  "data": { "rows": [{ "title": "Example" }], "nextCursor": null }
}
```

The corresponding sketch accepted `row.done` as `boolean`. This is a demonstrated failure of that placeholder path, so the candidate must not be described as fully sound yet.

A follow-up proof should test a declaration that treats previous placeholder data as the broader validated envelope and requires its callback result to match the current selection. That would retain native syntax/runtime while tightening callback typing. A native runtime guard is another possibility, but would change runtime behavior and needs an explicit decision. Neither remedy is implemented or verified here.

## Recommendation and remaining gates

Pursue generated per-procedure raw-client and RPC declarations, reusing native exported option input/output aliases. The projection descriptor should come from the same schema/relation/public-field model as the server executor and its selection-dependent response validation. Required client fields cannot be backed by the current optional wire envelope alone.

Before accepting this approach:

- Prove the corrected declarations through an installed packed consumer and actual generated API.
- Verify unchanged native runtime input forwarding, operation keys, overrides and full-snapshot live event behavior.
- Close the demonstrated cross-projection placeholder gap; test callback inference, conditional skipToken, widened/optional/union selections, both exactOptionalPropertyTypes settings, and native defaults/exclusions.
- Preserve raw-client context, cancellation, errors and stream options; verify ordinary procedure typings remain unchanged.
- Enforce selection-dependent response validation after authorization and before publication, including nullable relations and supported transport scalar types.

U1's original unchanged-native-utility boundary remains a valid failure. The broader conclusion should be limited to that boundary. This alternative is now a partially compiler-verified candidate; the existing plan gate is not marked passed and U2–U8 remain unstarted.

## Provider receipt

The JSON response usage identifies `claude-opus-5-5` for both review calls, with small auxiliary Haiku usage by the CLI. Low effort was explicitly requested and supported by the CLI, but the response does not separately attest actual effort. No automatic fallback model was requested. Only the proof, selected public type/source excerpts and corrected sketch were sent; no credentials or unrelated work were sent.

```json
[
  {
    "success": true,
    "model_requested": "claude-opus-5-5",
    "model_actual": "claude-opus-5-5",
    "effort_requested": "low",
    "effort_actual": "unverified",
    "duration_ms": 95622,
    "tools_enabled": false,
    "route": "Claude CLI, first-party provider per response usage",
    "auxiliary_model_usage": ["claude-haiku-4-5-20251001"]
  },
  {
    "success": true,
    "model_requested": "claude-opus-5-5",
    "model_actual": "claude-opus-5-5",
    "effort_requested": "low",
    "effort_actual": "unverified",
    "duration_ms": 107361,
    "tools_enabled": false,
    "route": "Claude CLI, first-party provider per response usage",
    "auxiliary_model_usage": ["claude-haiku-4-5-20251001"]
  }
]
```

## Original Claude review

# Review: client-selected relational projections through native oRPC TanStack utils

## 1. Is the prior conclusion too strong?

**Yes, as stated. The reproduced failure is valid, but the "KTD2 blocked" conclusion goes further than the evidence.**

What the proof actually establishes:

- `RouterUtils<T>` matches `T extends Client<infer Ctx, infer In, infer Out, infer Err>`. Inferring from a generic call signature instantiates its type parameters at their constraints. So `<const I extends SearchInput>(i: I) => Promise<SelectedPage<I>>` collapses to one fixed `Out`.
- `ProcedureUtils` methods have only `USelectData`, `UInitialData` and `UPageParam` as generics. None of them is an input-carrying generic.
- **Valid conclusion:** you cannot recover dependent output by passing any client type through _unmodified `RouterUtils<…>` typing_. This covers overloads too, because conditional `infer` picks the last overload.

What the proof does **not** establish:

- Kello does not use `createTanstackQueryUtils`'s return type at the consumer boundary. The generated `api.d.ts` writes `readonly rpc: RouterUtils<Client>` itself. That declaration is Kello's, not upstream's.
- Kello can therefore declare `rpc` as a **generated per-procedure specialization**:
  - The type of `rpc.tasks.search` is a Kello interface whose `queryOptions`, `infiniteOptions`, `liveOptions` and their key methods carry `const I`.
  - Every other procedure and member stays `RouterUtils<…>`.
- The runtime object is still exactly `createTanstackQueryUtils(client, …)`. No wrapper, no cache system, and no change to option runtime behavior.
- The consumer syntax is identical: `rpc.tasks.search.queryOptions({ input, select, enabled })` and `useQuery(...)`.

**Exact boundary**

| Approach                                                                                                 | Result                                                |
| -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Unchanged native return type of `createTanstackQueryUtils(client)`                                       | Cannot be dependent. The prior conclusion holds here. |
| Generated `rpc` property typed by a Kello-emitted per-procedure declaration over the same runtime object | Not ruled out by anything tested.                     |

**API deviation:** consumers who call `createTanstackQueryUtils(connection.client)` themselves get fixed output. Only `connection.rpc`, the generated property, is selection-aware. Document this.

**Soundness caveat (the real remaining risk).** A declaration can only be sound if the runtime guarantees the declared shape.

- The current wire output schema is the optional envelope. Contract validation alone does **not** prove that `title` is present when it was selected.
- To avoid the typed result being a lie, the search handler (or a contract output check) must validate the output against a **selection-derived schema** built from the validated input. That can be a server-side projection of the Valibot/Zod row schema through Standard Schema.
- The client specialization is sound only relative to that server guarantee. The U2+ executor tests must enforce it.

## 2. Ranked alternatives

1. **Generated per-procedure `rpc` declaration using a higher-kinded projector (recommended).**
   - Scope: type-only, emitted in `api.d.ts`, using the same runtime `createTanstackQueryUtils` result.
   - Reuses upstream `QueryOptionsIn/Out` and `InfiniteOptionsIn/Out` aliases instantiated with `Project<F, I>`. The `select`, `initialData`, `placeholderData`, `enabled`, `skipToken`, `retry` and `staleTime` controls, `DataTag` cache keys and suspense therefore follow native semantics.
   - Maintainability: one small interface per method family. It needs a drift test against upstream `ProcedureUtils` for fixed-output equality.
   - Scoped options, plugins and interceptors remain typed on the base (envelope) output, which is correct because they see raw wire data.
2. **Module augmentation of `@orpc/tanstack-query`.**
   - Not viable for this. You cannot change a type alias's conditional (`RouterUtils`) or add method type parameters to class `ProcedureUtils` via declaration merging.
   - Merging an overload into the `ProcedureUtils` interface affects all procedures and still sees fixed `TInput`. Reject.
3. **Key-based or discriminated contract, one `Client` per selection.**
   - Would work with unmodified `RouterUtils` only for finitely many selections. That makes it the "finite server-defined projection" alternative in disguise.
   - It does not satisfy client-selected. Reject for R4.
4. **Tiny adapter function, e.g. `selectable(rpc.tasks.search).queryOptions(...)`.**
   - Sound and simple, but it changes the call syntax. Keep it only as a fallback if option 1 fails compilation.
5. **Upstream PR adding an input generic to `ProcedureUtils`.**
   - The cleanest long-term fix, but not available at beta.40.
6. **Finite server projections.**
   - Already compatible, but it changes the requirement.

## 3. Recommendation: generated projector-specialized `rpc`

**Assumptions. None of these are verified; I have no compiler in this invocation.**

- **A1.** `@orpc/tanstack-query` exports the types `QueryOptionsIn`, `QueryOptionsOut`, `InfiniteOptionsIn`, `InfiniteOptionsOut` and `RouterUtils`. Your excerpt shows them declared but not the export list.
  - If they are not exported, vendor verbatim copies into `kello/client` types.
  - Add test T10 asserting the vendored copy is equal to the native one for fixed output.
- **A2.** `@tanstack/react-query` re-exports `DataTag`, `QueryKey`, `InfiniteData` and `SkipToken`, and `@orpc/client` exports `Client`.
- **A3.** TS7 infers `const I` from `input` before contextually typing `select` and `getNextPageParam`. This is the same phase ordering the native generics rely on. **This is the most likely point of failure.**
- **A4.** The `this`-based HKT (`(F & { input: I })["output"]`) behaves in TS7 as in TS5.

```ts
// kello/client — shared, type-only (e.g. selection-utils.d.ts)
import type { Client } from "@orpc/client";
import type {
  InfiniteOptionsIn,
  InfiniteOptionsOut,
  QueryOptionsIn,
  QueryOptionsOut,
  RouterUtils,
} from "@orpc/tanstack-query";
import type { DataTag, InfiniteData, QueryKey, SkipToken } from "@tanstack/react-query";

/** Higher-kinded output: `output` is computed from `this["input"]`. */
export interface Projector<In> {
  readonly input: In;
  readonly output: object;
}
export type Project<F extends Projector<unknown>, I> = (F & { readonly input: I })["output"];

/** Deep excess-key guard: extra selection keys become `never`. */
export type NoExtra<I, Shape> = I extends object
  ? { [K in keyof I]: K extends keyof Shape ? NoExtra<I[K], NonNullable<Shape[K]>> : never }
  : I;

type Replaced = "queryKey" | "queryOptions" | "infiniteKey" | "infiniteOptions" | "liveKey" | "liveOptions";

/** Query/infinite projection over a procedure whose wire output is Envelope. */
export type SelectableQueryUtils<Ctx extends object, In, Envelope, Err, F extends Projector<In>> = Omit<
  RouterUtils<Client<Ctx, In, Envelope, Err>>,
  Replaced
> & {
  queryKey<const I extends In & NoExtra<I, In>>(options: {
    input: I | SkipToken;
  }): DataTag<QueryKey, Project<F, I>, Err>;
  queryOptions<const I extends In & NoExtra<I, In>, USelectData = Project<F, I>, UInitialData = undefined>(
    options: QueryOptionsIn<Ctx, I, Project<F, I>, Err, USelectData, UInitialData>,
  ): NoInfer<QueryOptionsOut<Project<F, I>, Err, USelectData, UInitialData>>;
  infiniteKey<const I extends In & NoExtra<I, In>, UPageParam>(options: {
    input: ((pageParam: UPageParam) => I) | SkipToken;
    initialPageParam: UPageParam;
  }): DataTag<QueryKey, InfiniteData<Project<F, I>, UPageParam>, Err>;
  infiniteOptions<
    const I extends In & NoExtra<I, In>,
    UPageParam,
    USelectData = InfiniteData<Project<F, I>, UPageParam>,
    UInitialData = undefined,
  >(
    options: InfiniteOptionsIn<Ctx, I, Project<F, I>, Err, USelectData, UPageParam, UInitialData>,
  ): NoInfer<InfiniteOptionsOut<Project<F, I>, Err, USelectData, UPageParam, UInitialData>>;
};

/** Live projection over an event-iterator procedure; F projects one event. */
export type SelectableLiveUtils<Ctx extends object, In, Wire, Err, F extends Projector<In>> = Omit<
  RouterUtils<Client<Ctx, In, Wire, Err>>,
  Replaced
> & {
  liveKey<const I extends In & NoExtra<I, In>>(options: {
    input: I | SkipToken;
  }): DataTag<QueryKey, Project<F, I>, Err>;
  liveOptions<const I extends In & NoExtra<I, In>, USelectData = Project<F, I>, UInitialData = undefined>(
    options: QueryOptionsIn<Ctx, I, Project<F, I>, Err, USelectData, UInitialData>,
  ): NoInfer<QueryOptionsOut<Project<F, I>, Err, USelectData, UInitialData>>;
};
```

```ts
// Generated by Kello from schema + relations (illustrative for the fixture graph)
import type { Id } from "kello/server";
import type { Projector } from "kello/client";

type Simplify<T> = { [K in keyof T]: T[K] } & {};
type TaskRow = { _id: Id<"tasks">; title: string; done: boolean; at: Date; count: bigint };
type LabelRow = { _id: Id<"labels">; name: string };
type ProjectRow = { _id: Id<"projects">; name: string };
type Pick1<Row, C> = { [K in keyof C & keyof Row as C[K] extends true ? K : never]: Row[K] };
type LabelSel<S> = S extends { columns: infer C } ? Simplify<Pick1<LabelRow, C>> : never;
type ProjectSel<S> = S extends { columns: infer C } ? Simplify<Pick1<ProjectRow, C>> : never;
type With<W> = (W extends { labels: infer L } ? { labels: LabelSel<L>[] } : object) & // many / M2M
  (W extends { project: infer P } ? { project: ProjectSel<P> | null } : object); // nullable one
export type SelectedTask<S> = Simplify<
  (S extends { columns: infer C } ? Pick1<TaskRow, C> : object) & (S extends { with: infer W } ? With<W> : object)
>;
export type TaskSearchInput = {
  columns: { _id?: boolean; title?: boolean; done?: boolean; at?: boolean; count?: boolean };
  with?: {
    labels?: { columns: { _id?: boolean; name?: boolean } };
    project?: { columns: { _id?: boolean; name?: boolean } };
  };
  cursor?: string;
};
export interface TaskSearchPage extends Projector<TaskSearchInput> {
  readonly output: { rows: SelectedTask<this["input"]>[]; nextCursor: string | null };
}
```

```ts
// Generated api.d.ts delta (runtime api.js unchanged)
export type Rpc = Omit<RouterUtils<Client>, "tasks"> & {
  tasks: Omit<RouterUtils<Client["tasks"]>, "search" | "watch"> & {
    search: SelectableQueryUtils<RpcCallContext, TaskSearchInput, TaskEnvelopePage, SearchError, TaskSearchPage>;
    watch: SelectableLiveUtils<
      RpcCallContext,
      TaskSearchInput,
      AsyncIteratorObject<TaskEnvelopePage>,
      SearchError,
      TaskSearchPage
    >;
  };
};
export declare function createClient(/* … */): ReturnType<typeof createRpcTransport> & {
  readonly client: Client;
  readonly rpc: Rpc;
};
```

`SearchError`, `TaskEnvelopePage` and `Client["tasks"]` are extracted by the generator from the existing contract types. Each is `InferClientError`, the output of `Client["tasks"]["search"]`, and so on.

There are **no internal assertions**. The one runtime-to-type claim is that the `api.js` object satisfies `Rpc`. That claim holds only if:

- the runtime `queryOptions` is input-agnostic about output (true: it calls `client(input)`), and
- the server validates the selection-derived shape (to be built).

**Minimal prototype** (`probe.ts`, packed consumer):

```ts
import { createClient } from "./app/kello/_generated/api";
import { QueryClient, skipToken, useQuery, useSuspenseQuery, useInfiniteQuery } from "@tanstack/react-query";
import type { Id } from "kello/server";
const { rpc } = createClient({ url: "https://search.example.test", getToken: async () => null });
const qc = new QueryClient();

export function Probe() {
  const opts = rpc.tasks.search.queryOptions({
    input: {
      columns: { _id: true, title: true },
      with: { labels: { columns: { name: true } }, project: { columns: { name: true } } },
    },
  });
  const row = useSuspenseQuery(opts).data.rows[0]!;
  const title: string = row.title;
  const id: Id<"tasks"> = row._id;
  const names: string[] = row.labels.map((l) => l.name);
  const proj: { name: string } | null = row.project;
  // @ts-expect-error unselected
  void row.done;
  // @ts-expect-error unselected nested
  void row.labels[0]!._id;
  // @ts-expect-error brand preserved
  const wrong: Id<"labels"> = row._id;

  const cached = qc.getQueryData(opts.queryKey);
  const t2: string | undefined = cached?.rows[0]?.title;

  const titles = useQuery(
    rpc.tasks.search.queryOptions({
      input: { columns: { title: true } },
      enabled: true,
      staleTime: 50,
      select: (p) => p.rows.map((r) => r.title),
    }),
  ).data;
  const t3: string[] | undefined = titles;

  rpc.tasks.search.queryOptions({
    input: { columns: { title: true } },
    // @ts-expect-error initialData cannot contain an unselected field
    initialData: { rows: [{ title: "a", done: true }], nextCursor: null },
  });
  rpc.tasks.search.queryOptions({
    input: { columns: { title: true } },
    // @ts-expect-error placeholder must contain selected title
    placeholderData: { rows: [{}], nextCursor: null },
  });
  // @ts-expect-error unknown column rejected
  rpc.tasks.search.queryOptions({ input: { columns: { bogus: true } } });
  useQuery(rpc.tasks.search.queryOptions({ input: skipToken, enabled: false }));

  const inf = useInfiniteQuery(
    rpc.tasks.search.infiniteOptions({
      input: (cursor: string | null) => ({ columns: { title: true }, cursor: cursor ?? "" }),
      initialPageParam: null,
      getNextPageParam: (p) => p.nextCursor,
    }),
  ).data;
  const t4: string | undefined = inf?.pages[0]?.rows[0]?.title;

  const live = useQuery(rpc.tasks.watch.liveOptions({ input: { columns: { title: true } } })).data;
  const t5: string | undefined = live?.rows[0]?.title;

  void [title, id, names, proj, wrong, t2, t3, t4, t5];
  return null;
}
```

**Specific unverifiable risks to watch**

- **`skipToken`:** `I` falls back to the constraint, so the output becomes `SelectedTask<TaskSearchInput>`, where every column is `boolean | undefined` and resolves to a deep optional-ish type. That is acceptable only because the query is disabled; record the resulting type in the test.
- **`NoExtra`:** the F-bounded `I extends In & NoExtra<I, In>` may be rejected as circular or may degrade inference. The fallback is `input: I & NoExtra<I, In>` in the parameter position.
- **Infinite `input` returning a spread:** `const` inference through a function return may widen `true` to `boolean`, which yields `never` keys. If so, generated `as const` guidance is not acceptable. Instead, add `UPageParam`-first ordering or a `satisfies` helper, and flag this as an API deviation.

## 4. Tests that would disprove it, and impact on U1

**Disproving tests.** All run in the packed TS7/Bundler consumer, with no consumer casts.

1. **T1 root/nested selection:** required, readonly-free, correct types. The unselected root and nested fields give TS2339.
2. **T2 one-relation:** `{ … } | null`. A many/M2M relation is an array. An unselected relation key is absent.
3. **T3 brands, Date and bigint preserved.** Also cross-brand rejection.
4. **T4 `select`, `initialData` and `placeholderData`:** both positive and negative, including an extra field and a missing selected field.
5. **T5 `getQueryData`, `setQueryData`, `fetchQuery` and `ensureQueryData` via the `DataTag` key:** these produce the selected type. Prefix partial `key()` still works for invalidation.
6. **T6 suspense:** query, infinite and live data are non-undefined and selected.
7. **T7 infinite `getNextPageParam` page type is selected.** The inline-spread cursor input stays literal (see A3).
8. **T8 `skipToken`, `enabled`, `retry`, `staleTime`:** these compile, and the disabled output type is recorded.
9. **T9 unselected or unknown input keys are rejected.** This is the `NoExtra` test.
10. **T10 drift test:** for a non-specialized procedure, `rpc.x` equals `RouterUtils<Client>["x"]`. For the specialized one, `mutationOptions`, `streamedOptions` and `call` are unchanged.
11. **T11 runtime identity:** `api.js` is unchanged. A browser bundle check shows no new runtime code.
12. **T12 soundness (U2 gate, runtime):** the server rejects or strips output that violates the selection-derived schema. Without it, the declaration is unsound, and the proposal must not ship.

**Impact on U1**

- Reclassify KTD2 from **blocked** to **decision option 1 with a concrete candidate, pending compiler proof**.
- The existing "projection gap" characterization tests stay as evidence about _unmodified_ `RouterUtils`. They should be renamed so they are not read as a gate on the generated `rpc`.
- U1 passes only if T1–T11 pass exactly as written against the packed install.
- If A3 or `NoExtra` fails, fall back to alternative 4 (the adapter) and record that syntax deviation explicitly.
- U2 must include T12 before any claim of R4/AE1 acceptance.

## Claude follow-up after compiler feedback

# Follow-up review: projected oRPC/TanStack sketch

This is conceptual only. The only compiler evidence is what you supplied: a clean TS 7.0.2 run after the three changes you describe. Anything below about native internals is marked where it depends on native signatures I haven't seen here.

## 1. Correcting my initialData claim

My original claim was wrong. I said an extra field in `initialData` would be rejected. That conflated two different checks:

- **Structural compatibility (what native gives you).** `UInitialData` is inferred from the argument. A fresh object literal inferred into a type parameter loses its freshness. It is then checked by assignability to its constraint, and excess-property checking does not run.
  - `{ rows: [{ title, done }] }` is a structural subtype of `{ rows: { title: string }[] }`, so it passes.
- **Exact-property validation (what I claimed).** This would need a non-generic contextual target, or a `NoExtra`-style mapped guard on the `initialData` position. Native `QueryOptionsIn` provides neither.

The correct statement:

- Native `initialData` enforces that selected fields are present with the right types.
- It does not enforce the absence of unselected fields.

**Runtime impact:** the extra `done` gets cached but is invisible to the types. That is the harmless direction. The cache holds a superset of what the type says.

**Recommendation:** accept this. Don't add an exactness guard, because it would mean re-declaring the native initialData overloads. Keep the removed `@ts-expect-error` out. Add a positive test that a missing `title` is still rejected.

## 2. The main loophole: the projector is asserted, not verified

Even with a server that validates selections, inferred required fields can still be a lie:

- **The handler is typed against `Envelope`, which is `Partial`.** A handler, middleware, or output schema that drops a selected field still type-checks on the server.
  - `F` is a second, independent implementation of the selection semantics. Nothing ties it to the query builder's actual behaviour.
  - Validating the selection's shape does not validate that the response honours it.
- **Field-level authorization or redaction.** The server accepts `columns: { title: true }` but omits `title` for rows the caller can't read. The client type still says `string`.
- **Relation targets that disappear:**
  - A `where`-filtered or RLS-hidden one-relation must be `| null`, even when the foreign key is non-null. The generator must not derive nullability from the FK alone.
  - For M2M relations, a dangling join row can produce a missing or `null` element inside `labels[]`.
- **Version skew.** A client generated from schema v2 talking to a server on v1.
- **Serializer mismatch.**
  - `Date` and `bigint` in `TaskRow` are only true under oRPC's RPC serializer.
  - Behind an OpenAPI/JSON link, `at` arrives as a string and `bigint` fails outright.
  - The generator must emit row types per link and serializer, not per schema.

**Fix:**

1. Make the server handler return type `Project<F, I>`, generated from the same projector, so drift becomes a server compile error.
2. Optionally add a dev-mode runtime assertion in the generated client that checks the selected keys, derived from the runtime input, are present.

Types alone cannot close this gap.

## 3. Sharp failure cases by area

| Area                            | Failure case                                                                                                                                                                                                                                                                          | Direction                                                                                                                                                                                             |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **placeholderData**             | `placeholderData: keepPreviousData` (or `(prev) => prev`) while the user toggles columns. `prev` comes from the previous key, which had a different `I`, but is typed as the new `Project<F, I>`. Switching from `{title}` to `{done}` gives `row.done: boolean` holding `undefined`. | **Unsound.** This is native TanStack behaviour, but the projection makes it newly reachable. Document it, or narrow the generated `placeholderData` function parameter to the unprojected `Envelope`. |
| **skipToken**                   | `input: skipToken` alone gives no inference site, so `I` falls back to `In`, which produces `{ rows: {}[] }`. `input: cond ? {...} : skipToken` infers `I` from the object branch correctly.                                                                                          | Sound; empty rather than wrong.                                                                                                                                                                       |
| **Widened variable selections** | `const sel = { columns: { title: true } }` without `as const`, or a value typed `TaskSearchInput`, has `C[K]` of `boolean`, so the field is dropped.                                                                                                                                  | Sound but surprising.                                                                                                                                                                                 |
| **Casts**                       | `true as any` or a mutated object after inference makes the type claim more than the runtime input selects.                                                                                                                                                                           | Unsound, but only via casts or mutation.                                                                                                                                                              |
| **Optional literal**            | `{ title?: true }`: whether `C[K] extends true` holds depends on `exactOptionalPropertyTypes`. `Pick1`'s `keyof C & keyof Row` is non-homomorphic, so it also turns optional into required.                                                                                           | **Must test under both settings.** It may be unsound under exactOptionalPropertyTypes.                                                                                                                |
| **Missing columns**             | If the server follows Drizzle semantics (no `columns` = all columns; `{ title: false }` = everything except `title`), the types give `{}`.                                                                                                                                            | Conservative, but a documented deviation.                                                                                                                                                             |
| **Union selections**            | For infinite queries, a page function returning different selections per page makes `I` a union, and `SelectedTask` distributes over it. Reading a field that isn't common to every member is an error.                                                                               | Sound.                                                                                                                                                                                                |
| **Union input shapes**          | `NoExtra` uses `keyof Shape`. If `In` has union members (polymorphic relations), only common keys survive, so valid selections get rejected.                                                                                                                                          | Over-restrictive. The generator must distribute over the union.                                                                                                                                       |
| **Nested relations**            | `with` inside `labels` isn't modelled in this fixture.                                                                                                                                                                                                                                | The generator must emit recursive `With`, or reject nested `with` via `NoExtra`.                                                                                                                      |
| **custom queryFn**              | Only relevant if native `QueryOptionsIn` admits `queryFn` (I haven't verified that). If it does, the return is typed `Project<F, I>` but the runtime value is arbitrary.                                                                                                              | User responsibility. Same as native.                                                                                                                                                                  |
| **select**                      | `USelectData` defaults to the projection and the `select` parameter is `Project<F, I>`.                                                                                                                                                                                               | Sound.                                                                                                                                                                                                |
| **Key methods**                 | `.key()` isn't in `Replaced`, so it keeps native, unprojected typing. `qc.setQueriesData({ queryKey: rpc.tasks.search.key() }, updater)` can write `{}`-shaped rows into every selection's cache entry.                                                                               | **Unsound write path.** Either type `.key()` data as `Envelope` explicitly, or document that `setQueriesData` over a partial key is unprojected.                                                      |
| **Streaming**                   | `liveOptions` is correct only if every event is a full snapshot. If events are deltas or patches, projecting each event as a complete row is a lie. `experimental_streamed*` is not in `Replaced`, so it stays `Envelope[]`.                                                          | `streamed*` is sound but inconsistent. For the delta case, the generator must know the event semantics.                                                                                               |
| **call() and the raw client**   | Native `call()` still returns the `Partial` `Envelope`.                                                                                                                                                                                                                               | Sound but unprojected. See §5.                                                                                                                                                                        |

## 4. NoInfer

- **Inference sites.** `I` should be inferred only from `input`.
  - The other positions (`initialData`, `placeholderData`, and the `select` parameter) all reach `I` through `Project<F, I>`. That is an indexed access on an intersection, which TS can't invert, so they produce no inference candidates today.
  - That property comes from how the projector is encoded, not from a guarantee. Wrap those positions as `NoInfer<Project<F, I>>` defensively, so a future projector encoding can't widen `I` from a placeholder.
- **The return type.** `NoInfer<…>` there is a no-op, because NoInfer only affects parameter-position inference. It's harmless; drop it for clarity.
- **The input position.** `I & NoExtra<I, In>` still infers from the naked `I`. That's the intended behaviour, and your compile run confirms it.

## 5. Raw client and generated rpc declarations

Yes: separate generated declarations solve this without modifying the native utility, with one constraint.

**Raw client**

- Generate a generic callable per procedure, and cast the native runtime client to it at a single boundary in generated code:
  ```ts
  search<const I extends In>(input: I & NoExtra<I, In>, options?: ClientOptions<Ctx>): Promise<Project<F, I>>
  ```
  ```ts
  createORPCClient(link) as unknown as GeneratedClient;
  ```
- It must mirror the native second parameter (`context`, `signal`, `lastEventId`) and the error typing.

**rpc utils**

- You cannot pass the generic raw client to native `createTanstackQueryUtils` and get projection back.
  - Native `RouterUtils` pattern-matches `Client<Ctx, In, Out, Err>`.
  - Matching a generic function signature instantiates `I` at its constraint, so projection collapses to `Project<F, In>`.
- So the rpc declarations must also be generated, as the sketch does. The runtime value is the native utils object, built from the native (non-generic-typed) client and cast to the generated type.

**Soundness condition**

- The native runtime forwards `input` unchanged. Keys are derived from the input, and no transformation depends on output type.
- That is a property of native runtime behaviour. It's plausible, but it is not proven by the compile run. Cover it with a packed runtime test.

## 6. Global module augmentation

What was shown is only that one design failed. The precise status:

- **Impossible if** the native `ProcedureUtils`/`RouterUtils` target is an exported **type alias**, since aliases can't be merged. It is also impossible if the projector `F` cannot be reached from the type parameters the native type has (`Ctx, In, Out, Err`).
- **Not ruled out if** the target is an **interface**:
  - Augmentation can add method overloads.
  - Merged later declarations' overloads are tried first.
  - If the generated server output type carries the projector as a phantom brand (`Envelope & { readonly [projectorKey]?: F }`), an augmented overload can detect it and project.
- **Why I still wouldn't choose it:**
  - It's global to every consumer in the program.
  - Overload fallback is silent: if inference fails, you get the native `Partial` signature with no error. That is sound, but the loss of projection goes unnoticed.
  - It is tightly coupled to native internal type names across versions.
  - The brand leaks into server types.

## 7. Deviations to accept

1. `initialData` is structurally checked, not exact.
2. With `skipToken` only or widened boolean selections, the data type is empty (`{}` rows).
3. Omitted or `false` columns are treated as "not selected", even under Drizzle all-columns semantics.
4. `.key()`, `setQueriesData`, `experimental_streamed*`, and `call()` on the native utils stay unprojected (`Partial`).
5. There is one `as unknown as` cast boundary per generated client.
6. `keepPreviousData` across selection changes is unsound. Document it, or type the `prev` parameter as `Envelope`.

## Final recommendation

Ship the generated-declarations approach (generic raw client plus generated rpc utils, both cast at one boundary), with these changes:

1. Add `NoInfer` to the `Project` positions in parameters.
2. Test the optional/`exactOptionalPropertyTypes` behaviour of `Pick1` under both settings.
3. Emit `| null` for filtered or authorized one-relations, and serializer-specific row types.
4. Most important: make the server handler's return type the same generated `Project<F, I>`, so the client's required fields are backed by a server compile check rather than a parallel assertion.
5. Before claiming soundness, add a packed `.d.ts` plus runtime test covering:
   - key equality between the native and generated paths
   - input forwarding
   - live event shape
   - the `keepPreviousData` case

## Locally checked declaration specimen

This is a throwaway local typing specimen, not generated library code. Its final placeholder example intentionally records the accepted unsafe path described above. Its constructors and clients are declarations rather than runtime implementations.

```ts
import type { Id } from "kello/server";
// kello/client — shared, type-only (e.g. selection-utils.d.ts)
import type { Client } from "@orpc/client";
import type {
  InfiniteOptionsIn,
  InfiniteOptionsOut,
  QueryOptionsIn,
  QueryOptionsOut,
  RouterUtils,
} from "@orpc/tanstack-query";
import type { DataTag, InfiniteData, QueryKey, SkipToken } from "@tanstack/react-query";

/** Higher-kinded output: `output` is computed from `this["input"]`. */
interface Projector<In> {
  readonly input: In;
  readonly output: object;
}
type Project<F extends Projector<unknown>, I> = (F & { readonly input: I })["output"];

/** Deep excess-key guard: extra selection keys become `never`. */
type NoExtra<I, Shape> = I extends object
  ? { [K in keyof I]: K extends keyof Shape ? NoExtra<I[K], NonNullable<Shape[K]>> : never }
  : I;

type Replaced = "queryKey" | "queryOptions" | "infiniteKey" | "infiniteOptions" | "liveKey" | "liveOptions";

/** Query/infinite projection over a procedure whose wire output is Envelope. */
type SelectableQueryUtils<Ctx extends object, In, Envelope, Err, F extends Projector<In>> = Omit<
  RouterUtils<Client<Ctx, In, Envelope, Err>>,
  Replaced
> & {
  queryKey<const I extends In>(options: { input: I | SkipToken }): DataTag<QueryKey, Project<F, I>, Err>;
  queryOptions<const I extends In, USelectData = Project<F, I>, UInitialData = undefined>(
    options: QueryOptionsIn<Ctx, I & NoExtra<I, In>, Project<F, I>, Err, USelectData, UInitialData>,
  ): NoInfer<QueryOptionsOut<Project<F, I>, Err, USelectData, UInitialData>>;
  infiniteKey<const I extends In, UPageParam>(options: {
    input: ((pageParam: UPageParam) => I) | SkipToken;
    initialPageParam: UPageParam;
  }): DataTag<QueryKey, InfiniteData<Project<F, I>, UPageParam>, Err>;
  infiniteOptions<
    const I extends In,
    UPageParam,
    USelectData = InfiniteData<Project<F, I>, UPageParam>,
    UInitialData = undefined,
  >(
    options: InfiniteOptionsIn<Ctx, I & NoExtra<I, In>, Project<F, I>, Err, USelectData, UPageParam, UInitialData>,
  ): NoInfer<InfiniteOptionsOut<Project<F, I>, Err, USelectData, UPageParam, UInitialData>>;
};

/** Live projection over an event-iterator procedure; F projects one event. */
type SelectableLiveUtils<Ctx extends object, In, Wire, Err, F extends Projector<In>> = Omit<
  RouterUtils<Client<Ctx, In, Wire, Err>>,
  Replaced
> & {
  liveKey<const I extends In>(options: { input: I | SkipToken }): DataTag<QueryKey, Project<F, I>, Err>;
  liveOptions<const I extends In, USelectData = Project<F, I>, UInitialData = undefined>(
    options: QueryOptionsIn<Ctx, I & NoExtra<I, In>, Project<F, I>, Err, USelectData, UInitialData>,
  ): NoInfer<QueryOptionsOut<Project<F, I>, Err, USelectData, UInitialData>>;
};
// Generated by Kello from schema + relations (illustrative for the fixture graph)

type Simplify<T> = { [K in keyof T]: T[K] } & {};
type TaskRow = { _id: Id<"tasks">; title: string; done: boolean; at: Date; count: bigint };
type LabelRow = { _id: Id<"labels">; name: string };
type ProjectRow = { _id: Id<"projects">; name: string };
type Pick1<Row, C> = { [K in keyof C & keyof Row as C[K] extends true ? K : never]: Row[K] };
type LabelSel<S> = S extends { columns: infer C } ? Simplify<Pick1<LabelRow, C>> : never;
type ProjectSel<S> = S extends { columns: infer C } ? Simplify<Pick1<ProjectRow, C>> : never;
type With<W> = (W extends { labels: infer L } ? { labels: LabelSel<L>[] } : object) & // many / M2M
  (W extends { project: infer P } ? { project: ProjectSel<P> | null } : object); // nullable one
type SelectedTask<S> = Simplify<
  (S extends { columns: infer C } ? Pick1<TaskRow, C> : object) & (S extends { with: infer W } ? With<W> : object)
>;
type TaskSearchInput = {
  columns: { _id?: boolean; title?: boolean; done?: boolean; at?: boolean; count?: boolean };
  with?: {
    labels?: { columns: { _id?: boolean; name?: boolean } };
    project?: { columns: { _id?: boolean; name?: boolean } };
  };
  cursor?: string;
};
type SearchPageFor<Input> = { rows: SelectedTask<Input>[]; nextCursor: string | null };
interface TaskSearchPage extends Projector<TaskSearchInput> {
  readonly output: SearchPageFor<this["input"]>;
}
type Envelope = {
  rows: Partial<TaskRow & { labels: Partial<LabelRow>[]; project: Partial<ProjectRow> | null }>[];
  nextCursor: string | null;
};
declare function createClient(options: { url: string; getToken: () => Promise<string | null> }): {
  rpc: {
    tasks: {
      search: SelectableQueryUtils<{}, TaskSearchInput, Envelope, Error, TaskSearchPage>;
      watch: SelectableLiveUtils<{}, TaskSearchInput, AsyncIteratorObject<Envelope>, Error, TaskSearchPage>;
    };
  };
};
import { QueryClient, skipToken, useQuery, useSuspenseQuery, useInfiniteQuery } from "@tanstack/react-query";
const { rpc } = createClient({ url: "https://search.example.test", getToken: async () => null });
const qc = new QueryClient();

export function Probe() {
  const opts = rpc.tasks.search.queryOptions({
    input: {
      columns: { _id: true, title: true },
      with: { labels: { columns: { name: true } }, project: { columns: { name: true } } },
    },
  });
  const row = useSuspenseQuery(opts).data.rows[0]!;
  const title: string = row.title;
  const id: Id<"tasks"> = row._id;
  const names: string[] = row.labels.map((l) => l.name);
  const proj: { name: string } | null = row.project;
  // @ts-expect-error unselected
  void row.done;
  // @ts-expect-error unselected nested
  void row.labels[0]!._id;
  // @ts-expect-error brand preserved
  const wrong: Id<"labels"> = row._id;

  const cached = qc.getQueryData(opts.queryKey);
  const t2: string | undefined = cached?.rows[0]?.title;

  const titles = useQuery(
    rpc.tasks.search.queryOptions({
      input: { columns: { title: true } },
      enabled: true,
      staleTime: 50,
      select: (p) => p.rows.map((r) => r.title),
    }),
  ).data;
  const t3: string[] | undefined = titles;

  rpc.tasks.search.queryOptions({
    input: { columns: { title: true } },
    // Native initialData inference permits structural extra fields.
    initialData: { rows: [{ title: "a", done: true }], nextCursor: null },
  });
  rpc.tasks.search.queryOptions({
    input: { columns: { title: true } },
    // @ts-expect-error placeholder must contain selected title
    placeholderData: { rows: [{}], nextCursor: null },
  });
  // @ts-expect-error unknown column rejected
  rpc.tasks.search.queryOptions({ input: { columns: { bogus: true } } });
  useQuery(rpc.tasks.search.queryOptions({ input: skipToken, enabled: false }));

  const inf = useInfiniteQuery(
    rpc.tasks.search.infiniteOptions({
      input: (cursor: string | null) => ({ columns: { title: true }, cursor: cursor ?? "" }),
      initialPageParam: null,
      getNextPageParam: (p) => p.nextCursor,
    }),
  ).data;
  const t4: string | undefined = inf?.pages[0]?.rows[0]?.title;

  const live = useQuery(rpc.tasks.watch.liveOptions({ input: { columns: { title: true } } })).data;
  const t5: string | undefined = live?.rows[0]?.title;

  void [title, id, names, proj, wrong, t2, t3, t4, t5];
  return null;
}
export function AdversarialChecks() {
  rpc.tasks.search.queryOptions({
    input: { columns: { title: true } },
    // @ts-expect-error selected title remains required in initial data
    initialData: { rows: [{}], nextCursor: null },
  });
  rpc.tasks.search.queryOptions({
    input: { columns: { title: true } },
    // @ts-expect-error selected title is a string
    initialData: { rows: [{ title: 123 }], nextCursor: null },
  });
  rpc.tasks.search.queryOptions({
    input: { columns: { title: true } },
    // @ts-expect-error custom queryFn must return selected title
    queryFn: async () => ({ rows: [{}], nextCursor: null }),
  });
  const invalid = { columns: { title: true, privateSecret: true } };
  // @ts-expect-error input variables cannot bypass unknown-column guard
  rpc.tasks.search.queryOptions({ input: invalid });
  const invalidNested = { columns: { title: true }, with: { labels: { columns: { privateSecret: true } } } };
  // @ts-expect-error nested input variables cannot bypass unknown-column guard
  rpc.tasks.search.queryOptions({ input: invalidNested });
  const skipped = useQuery(rpc.tasks.search.queryOptions({ input: { columns: { title: false } } }));
  // @ts-expect-error explicitly omitted title is inaccessible
  void skipped.data?.rows[0]?.title;
  const all = useSuspenseQuery(rpc.tasks.search.queryOptions({ input: { columns: { at: true, count: true } } })).data;
  for (const row of all.rows) {
    const at: Date = row.at;
    const count: bigint = row.count;
    void [at, count];
  }
  const byKey = qc.getQueryData(rpc.tasks.search.queryKey({ input: { columns: { title: true } } }));
  const title: string | undefined = byKey?.rows[0]?.title;
  const liveKey = qc.getQueryData(rpc.tasks.watch.liveKey({ input: { columns: { title: true } } }));
  const liveTitle: string | undefined = liveKey?.rows[0]?.title;
  void [title, liveTitle];
}
declare const selectedClient: {
  search: <const Input extends TaskSearchInput>(
    input: Input & NoExtra<Input, TaskSearchInput>,
  ) => Promise<Project<TaskSearchPage, Input>>;
};
export async function RawChecks() {
  const rows = (
    await selectedClient.search({ columns: { title: true }, with: { labels: { columns: { name: true } } } })
  ).rows;
  for (const row of rows) {
    const title: string = row.title;
    const labels: { name: string }[] = row.labels;
    // @ts-expect-error unselected raw field
    void row.done;
    void [title, labels];
  }
}

import { keepPreviousData } from "@tanstack/react-query";
export function PreviousProjectionCheck() {
  const result = useQuery(
    rpc.tasks.search.queryOptions({ input: { columns: { done: true } }, placeholderData: keepPreviousData }),
  );
  for (const row of result.data?.rows ?? []) {
    const done: boolean = row.done;
    void done;
  }
}
```
