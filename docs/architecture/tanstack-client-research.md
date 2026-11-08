# TanStack client integration

The implemented API uses generated callable methods and TanStack Query 5.103.2:

```tsx
const tasks = useQuery(api.tasks.list({ input: { projectId }, enabled: !!projectId }));
const setDone = useMutation(api.tasks.setDone({ onSuccess: (task) => console.log(task) }));
setDone.mutate({ id: taskId, done: true });
```

Methods build real native options with upstream helpers internally. There is no component-side factory or `.queryOptions()` / `.mutationOptions()` suffix. Native options supply types for selectors, initial data, callbacks, and mutation variables. Generated keys and transport functions remain reserved. Flat references remain available for existing imperative and backend consumers; nested methods also carry reference metadata.

A session-scoped `createKelloQueryClient` binds the HTTP and live clients to the actual QueryClient passed by TanStack's function context. Bindings use a WeakMap, never a global current user or serialized cache metadata. Identity changes retire the old client, cancel operations, and clear observed and cached results. SSR requires a new client per request.

The adapter uses pinned `experimental_streamedQuery` with a latest-snapshot reducer. TanStack owns cached data and observers; Kello owns authenticated transport, subscription sharing, sequence handling, reconnects, and server invalidation. A live fetch remains open, so finite `live: false` HTTP mode is required for awaited prefetch and Suspense. Native live hook status becomes successful after the first result while fetch status remains fetching. Remounts resubscribe by default.

Mutation context identity is stable across retries in this pinned TanStack release. A WeakMap assigns one idempotency key per mutation execution. Tests cover retry reuse and distinct subsequent executions. Pending mutation persistence across reloads is unsupported. Actions remain non-idempotent.

TanStack DB was researched using `bunx @tanstack/intent list` and its collection, custom-adapter, and optimistic-mutation guides. It manages normalized keyed collections, indexes and local transactions. Kello query results may be arbitrary projections or aggregates without stable entity keys. Adopting DB universally would introduce a second data model and unresolved ownership rules. An optional entity collection adapter remains separate future work.

Optimistic live confirmation also remains separate: current frames do not expose a database revision fence shared with mutation responses. Native callbacks can perform optimistic edits, but a successful mutation alone does not prove a later subscription snapshot includes its commit. Server freshness still includes the default one-second table-revision polling interval.

References:

- [TanStack Query option helpers](https://tanstack.com/query/latest/docs/framework/react/guides/query-options)
- [oRPC live query options](https://orpc.dev/docs/integrations/tanstack-query#live-query-options)
- [oRPC WebSocket adapter](https://orpc.dev/docs/adapters/websocket)
- [TanStack DB overview](https://tanstack.com/db/latest/docs/overview)
- [TanStack DB custom collections](https://tanstack.com/db/latest/docs/guides/collection-options-creator#complete-example-websocket-collection)

See the [React guide](../../apps/docs/content/docs/authoring/subscriptions.mdx) for session lifecycle and usage.
