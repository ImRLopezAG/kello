# Selective live invalidation

Generated-search live procedures can declare their additional tracked reads so unrelated table writes do not rerun them. The declarations are server-owned completeness contracts. They do not inspect SQL or prove that callbacks are honest.

## Authoring

Wrap the completed native procedure last with `withLiveDependencies(graph, dependencies, procedure)` from `kello/server`. The helper returns the same procedure object and preserves its inferred native type. Dependencies are logical table names in that exact native graph. Native router construction also clones leaves: declare the final routed procedure after constructing the router. A native builder derived afterward is undeclared; Kello carries declarations through its own runtime clones.

Declare authorizer reads with `defineRpcAuth({ dependencies, authorize })` and policy reads with the existing search scope's `dependencies` property. Omission means unknown. An explicit empty array means the segment has no additional tracked reads. Public policies need no extra declaration. Policy declarations are additive to mandatory root, relation, junction and count-query dependencies; they cannot remove those dependencies.

Procedure declarations cover handler side reads, middleware, service callbacks, transforms, relation RAW predicates, SQL-backed columns and application-managed database functions or RLS involved in the query. Relevant database reads must use the owned invocation transaction. Input validation before transaction acquisition and output work after release must not read the database. Imported pools, external services, time and mutable process state do not become tracked by declaring an empty array.

Local names resolve against the owning scope's schema. A runtime-wide authorizer's declaration must resolve in every scope where it applies. If it directly queries a sibling scope, omit the declaration: this version has no cross-scope declaration syntax. Supported nested generated-search calls instead contribute their own locally bound dependencies to the same attempt.

## Selection and fallback

An evaluation is selective only when it uses generated search and every executed procedure, authorizer and visited non-public policy supplies complete evidence. Any unknown segment, unsupported nested handler or disabled selective binding captures every registered application table across root and mounted scopes. Unknown state is sticky for that attempt. An unvisited policy does not affect the decision.

This broad fallback includes sibling scopes even when the invocation does not call a sibling procedure. Broad capture still cannot observe untracked tables, external providers or process state. Applications depending on those sources need a separate invalidation mechanism.

Malformed declarations, foreign graph identity and unknown local names fail binding. Missing persisted revision rows fail evaluation. A generated-search evaluation claiming completeness without its mandatory table evidence also fails. Valid empty broad registries remain supported.

## Snapshot and publication

Each transaction attempt owns a fresh collector, registered before authorization. Nested calls must retain that invocation's connection and authority. Rows, count queries and lazy policy callbacks finish before search evidence is registered. Final revision reads occur inside the same transaction after owned work and validation complete.

The exact candidate object belongs to that attempt through a private WeakMap. Only successful transaction completion permits acceptance. Retries, failed commits, stale callbacks, copied candidates and cross-evaluation candidates cannot donate evidence. A failed evaluation cannot replace a subscription's previous dependency map. Successful reevaluation may grow or shrink that map; any database selector controlling the branch must itself be tracked.

Private revision keys are `JSON.stringify([physicalNamespace, sqlTable])`; decimal revision strings remain exact. The public revision reader continues to return its existing bare table keys. Application response values and native oRPC/TanStack behavior do not acquire a revision envelope.

The coordinator still performs one shared read of all registered revisions per poll cycle. It compares each subscription's captured keys against that map. A missing captured key closes the subscription with `RESYNC_REQUIRED`, before publishing new data. Absence is never revision zero. Notification wakeups remain hints; polls remain authoritative.

## Rollback and boundaries

The private generation binding option `selectiveInvalidation: false` restores broad capture. It is not client input or a public selector API. Restarting a generation and reconnecting creates a fresh authorized evaluation; no prior capture is reused. There is no metadata migration or revision-trigger change for this feature.

Selective invalidation dependencies do not define optimistic-write confirmation applicability. Optional confirmation evidence belongs to that separate feature; missing evidence remains unavailable. Full-text search does not infer completeness from its document table and remains correct under broad fallback.

## Acceptance evidence

Phase receipts are maintained in `docs/tasks/003-journal.md` and `003-u0.md` through `003-u5.md`. U0–U3 have independent phase acceptance. U4's full native/browser matrix and U5's workload, rollback and hosted search/live receipts are still pending. Local tests, independent reviews, combined integration checks, provider execution and PR CI are distinct gates; none substitutes for another.
