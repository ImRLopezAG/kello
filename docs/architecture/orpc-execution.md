# oRPC migration execution evidence

Plan: `docs/plans/2026-09-24-1400-refactor-orpc-effect-framework-core-plan.md`.

Entries below are chronological. Each verification claim applies to the code and test run named in that entry; an early statement that work remains does not override a later completed verification. The consolidated [acceptance record](orpc-acceptance.md) records the final six-run matrix and current verification status.

## U1: Dependency compatibility

Pinned oRPC 2.0.0-beta.40, Effect 4.0.0-rc.117, Neon SDK 6.1.0, config 1.7.3 and config-runtime 1.6.3 after checking registry channels on 2026-09-24. Existing TypeScript 7, Bun, Drizzle RC and Neon Functions pins remain. The Drizzle MIT patch is unchanged. The Apache-2.0 Neon config patch applies to 1.7.3 and still rejects unknown/missing bucket access levels; packed-consumer verification exercises that behavior. License notices and the renamed patch are bundled.

Evidence strategy: dependency/configuration changes use compatibility tests; the Effect upgrade reproduced two fixture failures before changing their Standard Schema adapter calls. New native oRPC tests cover service provision, declared errors, validation before execution and compile-time input/context rejection.

- Baseline `bun run check`: 15 tasks succeeded (14 cached).
- Updated `bun run check`: 15 tasks succeeded; 173 unit tests passed.
- Focused validator, oRPC/Effect and Drizzle suites: 20 passed, zero failures.
- Packed consumer and Node/browser smoke: 2 passed; two database checks initially skipped, then executed below.
- PostgreSQL 18 migration and Node compatibility: 5 passed, zero skips. Actual column data survives rename; introspection works in ESM and CommonJS.
- Uncached core typecheck baseline, three samples: 0.407 s, 0.466 s, 0.435 s. Artifact sizes recorded in `/tmp/kello-orpc-u1-baseline.json`. Hosted timing comparisons remain required before runtime acceptance; retain the pre-migration Git base for matching baseline deployment.

Code review and security review ran sequentially in the main session, as instructed. No unresolved findings. Checked dependency/patch scope, Standard Schema API changes, negative type fixtures, Node/browser boundaries, fail-closed privacy behavior and packed license/patch delivery. This was not an independent review. Receipt: `/tmp/compound-engineering-501/ce-code-review/kello-u1/review.json`.

No hosted acceptance is claimed by this unit. Runtime migration starts in U2.

## U2: Effect invocation ownership

Added a shared ManagedRuntime with request-local identity, signal and finalizers. Native Drizzle remains the database implementation. Generated bindings can create schema-bound database/table/validator service keys; scheduler, storage and diagnostics have explicit service keys. The existing runtime's owned Promise operations now drain through the Effect boundary.

Proof-first: the new scope tests failed typechecking because the runtime exports did not exist. Implemented them, then verified identity isolation, interruption finalizers, pre-aborted admission, operation failure, repeated stop and shared-resource disposal. Non-cancellable Promise work stays uninterruptible until its transaction settles; cancellation cannot release its client early.

- `bun run check`: 15 tasks succeeded; 176 unit tests passed.
- PostgreSQL 18 scope, runtime compatibility and credential-preflight suites: 3 passed, zero skips. An interrupted in-flight query retains its pooled client until rollback; escaped transaction execution fails.
- Build/typecheck and Oxlint remain enabled. Corrected the compatibility fixtures to use Node assertion promises and the existing Vite+ unit harness.

Sequential code/security review covered identity capture, shared-versus-request state, cancellation races, rejection propagation, shutdown order, pool ownership and exported service types. Review tightened cleanup so service-disposal failure cannot skip Object Storage close. No unresolved findings. No independent agent or cross-model review ran, per the workspace instruction to execute review tasks in the main thread. Provider deployment is not yet acceptance-tested.

## U3: Native procedure contracts

Added the project-bound native oRPC builder, with schema tables/validators injected once, optional inputs, inferred outputs, ordinary middleware and Effect handlers. Client presentation metadata defaults to mutation and remains separate from database authority; the bare procedure has no database capability. Existing builders remain until U13 parity removal.

Native RPC encoding preserves Date, bigint, undefined, null, sets and maps. Finite result validation rejects unsupported values and cyclic results. Explicit output contracts validate transforms through native oRPC. Precise OpenAPI export requires an explicit output schema and fails with the procedure path when conversion is unsupported. Valibot conversion is pinned to the matching oRPC version and configured to throw; Effect's public JSON Schema converter is invoked directly because the upstream wrapper suppresses conversion errors into empty schemas.

- Red: contract tests failed on the missing project builder export.
- `bun run check`: 15 tasks succeeded; 184 unit tests passed.
- Focused native contracts: 8 passed, including Effect Schema OpenAPI export after the full check.
- Type fixtures reject invalid input, unknown table/ID names, missing invocation context and output-transform mismatches. A discovered context-widening bug was fixed with explicit schema-indexed bindings.
- Oxlint and diff whitespace checks passed.

Sequential code/security review examined native middleware ordering, schema projection, declared error validation, Effect defect redaction, default metadata and finite serialization. Expected Effect failures retain declared public errors; defects are redacted even when their payload is a declared ORPCError. No unresolved findings in this unit. Transaction commit-order proofs remain U4, not a claim of this authoring-only unit. Review was in the main session, not independent.

Provider readiness: authenticated Neon CLI read confirmed project `late-moon-69483649`, name `kello`, region `aws-us-east-1`. The connector currently drops required arguments and cannot read the project; CLI access works. No hosted mutation or new hosted acceptance has occurred.

References checked: https://orpc.dev/docs/middleware, https://orpc.dev/docs/integrations/effect, https://orpc.dev/docs/openapi/specification, and installed beta.40 implementation/declarations.

## U4: Native transactions and replay

Added reusable database-read/write middleware and a native Procedure binding boundary. It moves complete input validation before transaction acquisition, retains output validation inside the transaction, and performs native serialization preflight before commit. Bound middleware receives fully validated input. Router-inherited middleware is supported. This uses oRPC's exported Procedure and OrderedMiddleware interfaces; it does not add a second endpoint registry.

The existing PostgreSQL transaction implementation remains the only conflict retry owner. Read procedures use read-only repeatable-read transactions; writes use serializable transactions. A stable logical invocation token spans retry attempts. Nested calls share the guarded transaction, reject identity/connection changes and write escalation, and poison the transaction when their failures are caught by application code. The guarded database is also supplied as an Effect service.

Replay reuses the existing atomic receipt/tombstone implementation with a native serializer envelope and explicit protocol version. The version is deliberately absent from the lookup scope, so incompatible saved results produce RPC_VERSION_MISMATCH instead of repeating a committed write. Authorization runs inside every attempt and before replay. Native custom error HTTP status mapping belongs to the U6 adapters because oRPC v2 separates error codes from transport status.

- Red: initial native PostgreSQL execution exposed optional serializer fields that JSON persistence must omit. Fixed by using the native JSON transport representation.
- Red: nested conflict test showed premature inner error redaction prevented retry. Moved redaction outside the outer retry owner.
- `bun run check`: 15 tasks succeeded; 184 unit tests passed, with typechecking and static lint enabled.
- PostgreSQL 18 native transactions, existing transactions/replay, and Effect cancellation: 5 passed, zero skips, 92 assertions.
- Native direct, HTTP and real local WebSocket clients replay the same receipt without a second commit; Date and bigint survive transport.
- Negative cases cover malformed input before authorization, transformed input exactly once per invocation, invalid output, unserializable output, revoked authorization, changed arguments, incompatible receipts, read-only writes, nested write escalation, caught nested validation failure and pre-aborted calls. Router inheritance and Effect database access pass.

Sequential code/security review covered commit ordering, authorization on replay/retry, connection and identity ownership, native input transforms, protocol mismatch behavior and nested failure propagation. No unresolved findings in this unit's boundary. Native scheduler/storage rollback integration remains a U10 cross-unit acceptance case; hosted Neon execution remains U12. Review was performed in the main session, not by independent agents.

## U5: Native graph generation

Fresh projects now scaffold ordinary procedures with schema-bound database middleware. First-load virtual bindings resolve `_generated/server` without requiring an existing generation. Native procedure exports and explicit `router`/default router exports form one graph; helper exports stay out. `kello/functions` supplies public routes and `kello/internal` supplies the server-only graph. Collisions, invalid segments, non-procedure router leaves, mixed legacy/native graphs and cyclic routers are rejected.

Generated browser runtime imports only the native client factory. Its declarations derive the exact native RouterClient from type-only procedure imports; internal paths and helpers are absent. Server bundles contain the actual native procedures, with no parallel FunctionReference registry for native projects. Stable public files point at the active private generation; successful activation retains two private runtime generations. Renames/deletions remove old types, including when the last procedure disappears. Recognized older generated wrappers migrate to stable re-exports; modified user files are refused. Migration history stays outside generated output.

Schema table/validator Effect services are provided alongside the Promise context, with distinct service identities so empty schema maps cannot satisfy unrelated capabilities. Database middleware verifies the schema/relations pair and preserves those services. Generated server files reject symlinks instead of writing through them.

- `bun run check`: 15 tasks succeeded; 187 unit tests passed.
- Generation, CLI and packed-consumer integration: 11 passed, zero skips. A clean packed consumer generates and typechecks native procedures and builds the browser client.
- Native PostgreSQL transaction regression: one test passed, zero skips (23 assertions), including HTTP/WebSocket replay.
- Negative type checks cover public/internal separation, input inference, helper exclusion and absence of database authority on bare Effect procedures.
- Browser inspection, failed-generation recovery, deterministic regeneration, deletion, bounded runtime artifacts and generated-file symlink refusal passed. Oxlint and diff checks passed.

Sequential code/security review examined route injection, public/internal separation, source import cycles, artifact replacement, generated file ownership, browser imports and Effect service identity. Fixed file-symlink writes and structural service-identity leakage. No unresolved findings within this unit. Review was performed in the main session, not independently.

Cross-unit boundaries remain explicit: U6 supplies native service transports; U11 assembles deployable service artifacts; U8 adds callable TanStack option methods over the generated native client; U10 moves durable internal calls/workers; U11 integrates activation and upgrades. Native generation is not yet a claim of a deployable hosted service. Legacy lifecycle fixtures remain explicitly named until their replacements land. Hosted Neon acceptance remains U12.

## U6: Authenticated native transports

Added HTTP RPC, strict-contract OpenAPI and native Neon WebSocket adapters over the same public procedure graph. The application owner keeps upgrade requests/responses outside response-rewriting middleware and drains requests and socket work before callers close their database. OpenAPI generation rejects missing output contracts before serving the REST adapter. Native RPC preserves undefined properties, Date and bigint consistently with durable replay.

HTTP checks exact origins, protocol/version headers, methods, byte limits, bearer sessions and expiration; authentication waits have a deadline. Tickets require an authenticated session, browser origin and an empty JSON object. WebSocket admission requires the native protocol, exact deployment version and a single-use ticket. Capacity is reserved before asynchronous redemption. Peer metadata cannot replace trusted identity. Session byte/rate/concurrency/buffer limits, heartbeat, expiration, cancellation and shutdown surround the native oRPC protocol.

Review found and fixed uncancellable ticket work escaping shutdown, serializer defaults dropping undefined properties, REST ingress errors using RPC envelopes, and array-shaped ticket bodies passing an empty-object validator. Shutdown now drains ticket redemption even after admission is cancelled. Code/security review ran sequentially in the main session, including correctness, lifecycle races, authorization boundaries, public contracts, tests and repository standards; it was not independent. No unresolved findings within the adapter unit.

- `bun run check`: all 15 tasks succeeded; 187 unit tests passed, with build/typecheck/static checks.
- Seven native transport integration tests passed, zero skips (49 assertions): real local HTTP/WebSocket clients, trusted identity, errors, cancellation, native values, authentication deadline, strict OpenAPI, malformed binary/oversized frames, idle expiration, reservation limits, unchanged provider response and draining pending redemption.
- Three PostgreSQL 18 regression suites passed, zero skips (69 assertions): durable single-use/scoped tickets, pooled identity isolation and native transaction replay/reauthorization.
- Final native transport typecheck and strict undefined-property assertions passed.

The provider upgrade bridge test uses Neon's documented runtime bridge with a test response; it is not hosted acceptance. Actual Neon Functions deployment and WebSocket acceptance remain U12. Runtime graph binding, generated deployable service assembly and activation remain part of the U10/U11 integration work. Existing legacy adapters remain until U13.

## U7: Transactional notification wake-ups

Added an append-only framework migration replacing the existing revision trigger function. It advances durable revisions and calls PostgreSQL NOTIFY in the same transaction. The channel contains a hash of the metadata/application namespace; the payload is the constant `1`. It carries no row data, identity or credentials. Existing migration hashes remain unchanged, and previously installed triggers pick up the replacement function.

A lazy listener owns one direct PostgreSQL connection, checks the configured runtime identity against database authority, rejects pooled Neon URLs and privileged/member/metadata-owner roles, and commits LISTEN before snapshot work begins. Listener loss publishes a degraded diagnostic, prompts revision reconciliation and reconnects with capped backoff. Stop drains connection setup and closure. The subscription coordinator shares this listener, releases it when the last subscriber leaves, preserves bounded evaluation concurrency and coalesces wake-ups into a follow-up cycle if a commit arrives during evaluation. Reconciliation remains periodic, and notification payloads are never interpreted as results or authority.

- `bun run check`: 15 tasks succeeded; 188 unit tests passed at that run.
- Six focused subscription tests passed after adding the continuous-burst regression (one additional test): startup ordering, commits during an in-flight evaluation, burst coalescing, concurrency/backpressure and listener cleanup.
- PostgreSQL 18: three suites passed, zero skips, 55 assertions. Covered existing-metadata upgrade/hash preservation, insert/delete/truncate, rollback, direct SQL, restricted LISTEN, forged payloads, terminated-listener recovery, privileged/pooler refusal, snapshot consistency and missing revision metadata.
- Final core/e2e/test typechecks, Oxlint and whitespace checks passed.

Sequential code/security review covered SECURITY DEFINER search_path, migration history, opaque hints, credential restrictions, idle/shutdown ownership, reconnect races and bounded notification handling. Fixed reconnect loss during pending setup, repeated client closure, starvation from continuously resetting the wake timer, and subscriber replacement during listener startup. No unresolved findings within U7. Review was in the main session, not independent.

U8 replaces the legacy subscription call envelope with native iterators. U11 exposes explicit polling/notification configuration and resolves the direct runtime URL through the deployment lifecycle. No compute billing setting has been changed. Hosted low-latency acceptance remains U12; local listener success is not hosted acceptance.

## U8: Native callable options and snapshot iterators

Generated `createApi` binds `api`, the raw oRPC client, and an owned TanStack QueryClient to one deployment/generation/identity. Consumers call `useQuery(api.tasks.list({ input, enabled, select }))` or `useMutation(api.tasks.save({ onSuccess }))`. Finite/live/mutation choices come from native presentation metadata. Options use upstream oRPC generics and implementations, preserving initial-data inference, skipToken, callbacks and native wire values. Custom keys replace only the inner key. Convenience methods reject transport replacement; `.native` and `.call` provide explicit upstream escape hatches. Query execution checks its owning QueryClient. Session disposal aborts calls and clears both observers and cache entries.

Live RPC routes emit native iterators at their original paths. The revision coordinator is now independent of the legacy envelope; that envelope has a temporary adapter until examples migrate. Each native evaluation invokes the original authorized procedure, captures revisions inside its read transaction, and publishes only after transaction completion. Input is captured once and cloned for each evaluation. Each iterator holds one latest unread snapshot, enforces session expiry, redacts unexpected errors and drains active evaluation on cancellation. Generated wire types reflect the iterator output without leaking server imports into browser JavaScript.

Verification:

- Full workspace check: 15 tasks, 194 unit tests.
- Three PostgreSQL 18 suites: native live, native transactions and legacy evaluation regression; 55 assertions, zero skips. Includes a write racing with an authorized snapshot, permission revocation, input transforms, native Date/bigint transport and connection release.
- Clean generated consumer compiles cover mutation and live callables, native input/output inference and internal-route exclusion.
- Packed Chromium consumer: native React hooks share a stream, forced WebSocket loss creates one fresh subscription for two observers, and sign-out clears rendering and stops the stream. Combined generator/browser run: 38 assertions, zero skips.
- Oxlint, consumer typechecks and whitespace checks pass.

Sequential code/security review covered identity/key isolation, owning-client checks, input mutation across evaluations, cancellation/drain behavior, bounded queues, declared-error propagation and browser import boundaries. Fixed missing ownership checks and reused mutable input. No unresolved findings within this unit's implemented surface. Review ran in the main session, not independently.

U9 supplies finite SSR snapshots and optimistic pause ownership. Native deployment graph assembly and credentials remain U10/U11; legacy transports stay available to the unmigrated examples until U12/U13. The local PostgreSQL and Chromium results do not establish hosted Neon acceptance.

## U9: Optimistic ownership and finite SSR

`optimisticMutation` composes native mutation options with session-owned pause counts for affected live keys. It cancels active evaluations before `onMutate`, gates refetch/reconnect attempts, and resumes only after the last overlapping mutation's callbacks settle. TanStack remains the sole result cache. Applications supply optimistic edits and rollback; overlapping whole-cache rollback is not inferred. Attempt records survive React option replacement and restored mutation execution. Identity disposal aborts work and prevents late mutation callbacks from repopulating the old cache.

Successful writes are recorded before lifecycle callbacks run. A success/settlement callback failure does not invoke the option-level rollback callback; it releases the pause and reconciles. `OptimisticCallbackError` exposes the phase and `committed` flag to callers and global mutation-cache observers. Global application error policies must respect that flag; native TanStack callback error propagation remains intact.

Live callables expose `.snapshot(...)` for finite SSR query options. It consumes the first native iterator result and closes the iterator in `finally`. Finite and live keys remain distinct; browser live options can seed from the hydrated finite cache and then attach a stream. Caller options retain precedence. Hydration must use the native serializer to preserve Date/bigint, as demonstrated by the integration fixture.

Verification: full workspace check passes 15 tasks and 198 unit tests. Four optimistic unit tests cover overlapping mutations, gated background refetch, queued old emissions, failed writes, throwing callbacks, React option replacement and identity disposal. Three consumer tests pass with zero skips: actual Chromium optimistic behavior, reconnect regression and HTTP SSR/hydration; 23 assertions. SSR releases the finite stream and two hydrated observers share one live stream.

Sequential code/security review found and fixed per-render attempt loss, late callback execution after identity disposal, and ambiguous callback errors after successful writes. Reviewed pause finalization, retry boundaries, same-session ownership, bounded state, snapshot cleanup and native option inference. No unresolved findings in U9; review ran in the main session, not independently. Hosted provider acceptance remains U12.

Sources checked: https://www.postgresql.org/docs/current/sql-listen.html and https://www.postgresql.org/docs/current/sql-notify.html.

## U10a: Native durable job execution

The queue SQL and worker lease lifecycle now have one shared implementation, with temporary legacy adapters. Native jobs persist an explicit `kello-orpc-2` envelope using the oRPC serializer. Scheduling resolves actual procedure objects through the generated internal graph, validates inputs through a validation-only native procedure, and never runs application middleware or handlers during enqueue. Workers invoke the authorized, transaction-bound internal graph using the stable job id for replay.

Database context exposes a typed scheduler and `RpcSchedulerService`. Scheduling belongs to the current write transaction: even unawaited work is drained before output validation/receipt commit, and caught scheduling failures abort that attempt. Context capabilities reject use after their invocation ends. Input is captured before asynchronous enqueue work can observe caller mutations.

Verification: full workspace check passes all 15 tasks and 198 unit tests. Six PostgreSQL suites pass with zero skips and 155 assertions across native jobs, native transactions, legacy jobs, process termination/recovery, cron receipts and storage events. A final focused run adds the escaped-scheduler regression and passes both native suites. Native coverage includes Date/bigint persistence, validation without executing handlers, stable deduplication, committed-write replay after lost acknowledgement, stale lease rejection, caught enqueue failure rollback and unawaited enqueue rollback on invalid output. Oxlint and whitespace checks pass.

Sequential code/security review covered captured inputs, internal procedure identity, native validation sequencing, principal restoration, scoped scheduling authority, pending-work drain, receipt ordering, bounded queue payloads and lease fencing. Fixed a scheduler capability that could otherwise escape its invocation, caught errors from an unconfigured scheduler, and nested draining of the parent's pending work. No outstanding findings in this subunit; review ran in the main session, not independently.

U10 remains in progress: storage/cron native bindings follow. U11 still owns old-envelope migration mappings and activation inventory; U12 owns hosted Neon acceptance. These local tests do not establish hosted acceptance.

## U10b: Native storage-event and cron dispatch

Native storage and cron dispatchers now enqueue versioned oRPC calls through the shared receipt/state-machine implementations. Storage still verifies saved intents and uploaded bytes before enqueue, carries uploaded-by as event data, and executes with a null service identity. Cron occurrence and provider-delivery deduplication remain separate and transactional. Queue/version/declaration inputs are captured at construction. Existing legacy adapters continue using the same receipt code during migration.

The storage-event and cron failure-injection suites now execute native procedures. They cover concurrent deliveries, completed-job redelivery, payload/version conflicts, failed receipt insertion, restricted receipt permissions, late upload reconciliation, failed upload verification, retired ingress, cloned branch isolation and real trigger-adapter HTTP requests. Seven PostgreSQL test files pass eight tests, zero skips, with 88 Bun assertions plus node:assert checks. These include native jobs, legacy queue behavior, storage intents, cleanup and runtime storage. Full workspace check passes all 15 tasks and 198 unit tests; Oxlint and whitespace checks pass.

Sequential code/security review verified that receipt SQL, activation locks, saved owner identity, bucket/key validation, upload verification and reconciliation limits remain shared and unchanged. Reviewed captured configuration, internal-path validation and transaction rollback on enqueue/receipt failure. No outstanding findings in these bindings; review ran in the main session, not independently.

U10's durable execution and trigger bindings are implemented. U11 must assemble them into the generated native runtime, authoring configuration and CLI, including explicit old-job mappings and cutover fences. U12 must still verify actual Neon Functions and Object Storage rather than the local provider fixture.

## U11a: Native runtime, generation and development wiring

Project loading now distinguishes native procedure projects from legacy fixtures. Native auth defaults to deny, and cron/storage declarations resolve actual internal procedure objects. Invalid targets or auth modules cannot replace the active generation. Generated native service and worker modules assemble the same authorized graph, transaction owner, durable queue, revision coordinator and storage control plane. Public transports exclude internal procedures; provider triggers run only on the worker entry.

`kello dev` supports native HTTP and ticket-authenticated oRPC WebSockets. Generation replacement and shutdown retain their existing ownership boundaries. Configuration adds explicit polling/notify mode and a direct runtime URL environment variable. Notify deployment preparation verifies the restricted direct role against the selected database, and runtime startup rejects pooled, mismatched or identity-overriding direct URLs. Development uses its already verified direct runtime connection. Legacy projects reject notify mode instead of silently ignoring it.

Verification: full workspace check passes all 15 tasks and 200 unit tests. Eleven generator/CLI integration tests pass with 160 assertions and no skips, including generated consumer typing, internal-route exclusion, captured native capabilities and atomic failed-generation behavior. Eleven runtime/transport/development tests across five files pass with 93 assertions and no skips. A final focused native-runtime run additionally proves configured oversized outputs roll back their database write. Actual Bun WebSocket calls, duplicate native cron trigger delivery, activation rejection and awaited shutdown pass. Final consumer typecheck, Oxlint and whitespace checks pass.

Sequential main-session code/security review covered default-deny auth, internal graph separation, prototype-safe route construction, capability membership, output limits before commit, direct connection authority, original Neon upgrade requests, storage/worker route separation and shutdown ownership. Fixed inherited-property traversal in router assembly and query-parameter overrides in direct URLs. The review is not independent. No outstanding findings in this subunit.

U11 is not complete: explicit durable-envelope mappings, populated-state upgrade inventory and cutover/rollback fences remain. U12 still owns hosted Neon acceptance and example migration; the tests above use local PostgreSQL and do not establish hosted acceptance. U13 owns removal of temporary legacy adapters and final documentation/release checks.

## U11b: Durable procedure upgrades

Metadata migration 23 adds owner-controlled job routing and a procedure-release ledger without changing migrations 1–22 or stored call envelopes. Native projects may export explicit `defineJobMigration` declarations from `kello/upgrade.ts`. Each declaration identifies the exact old protocol, source version and route, validates the old input, converts it, and validates the target internal procedure's input without executing middleware or handlers. Generated service/worker bindings carry those declarations. Conversion happens in memory when the assigned worker claims a job; the original durable input stays intact.

Activation inventories pending/running work under database barriers. Only never-attempted work without replay history or write receipts can transfer. Attempted work must drain on its retained release; incompatible rollback is refused. Routing changes and activation commit together, incrementing job fences. A database trigger rejects old-worker claims even after a new worker has left its lease version on the row. Runtime credentials cannot modify routing, and deployment preflight detects accidental grants. Native activation cannot bypass this gate through the old low-level activation API.

Legacy releases retain their established draining behavior. Ingress handoff and explicit database retirement continue to own previous-release shutdown; migration does not prematurely retire retained grants. Development assembles an unpublished candidate under its quarantined grant before activation, and failed assembly leaves the previous grant active. Schema compatibility and retirement checks follow the assigned worker version while the original envelope remains available for audit.

`DURABLE_UPGRADE_BLOCKED` reports a bounded inventory containing UUIDs, version hashes and reason codes, never job inputs. Operators must drain retained work or add reviewed, deterministic mappings, then retry the same release identity. Do not delete replay receipts or reset attempts to force a migration. Expanded metadata remains in place on code rollback; rollback must pass the same durable-state checks.

Verification: all 15 workspace tasks pass, including 202 unit tests. PostgreSQL 18 regression passes 17 tests across 14 suites with 228 assertions and no skips. The suites exercise bootstrap history preservation, lease recovery, native jobs, storage events, cron dispatch, activation, release resumption, schema compatibility and failed candidate startup. Generated migration bindings and negative converter type checks pass. Final focused upgrade/release and CLI checks are recorded with the unit review receipt.

Sequential code/security review in the main session examined claims from old workers, receipt replay, partial activation, rollback, routing privileges, metadata history, code generation and diagnostic redaction. Fixed candidate activation ordering, low-level activation bypass, mutable migration descriptions, accidental routing grants and retained-legacy regression. This is not independent review or hosted acceptance. The final whole-change review remains required.

U11's native CLI wiring and durable upgrade boundary are implemented. U12 still requires migrated examples and actual Neon Functions/Auth/Postgres/Object Storage acceptance, including multi-instance live-query measurements. U13 still requires legacy removal, documentation, packed-consumer checks and CI/release validation.

## U12a — Native runnable examples and browser transport

Migrated Tasks and Upload Catalog to generated native procedures, explicit database middleware, inferred public results, callable TanStack options and per-identity QueryClient ownership. Internal storage jobs now live under `kello/internal` and schedule procedure objects. Public mutation results use explicit projections so inferred output types do not expose owner fields. The upload job-status view uses TanStack's finite polling options. Production examples use Neon Auth; fake Alice/Bob sign-in exists only in the disposable acceptance build fixture.

Added a browser-native oRPC WebSocket transport that obtains single-use tickets, preserves deployment prefixes, refreshes credentials on reconnect and owns socket shutdown. Disposing a session aborts pending calls; a delayed credential lookup cannot open a socket after disposal. Ticket version/auth refusals remain typed errors and stop further ticket requests. Mutation calls are not replayed by reconnection. Generated API exports its release version; contract fingerprint is 13. Storage has a separate control-plane client entry point; extracting its implementation from the legacy transport remains U13.

Verification:

- Full workspace check: 15 tasks, 204 unit tests, followed by the final three transport tests after the version-refusal review fix. Oxlint passes.
- Chromium with PostgreSQL 18: Tasks live updates, reconnect and user isolation; Upload Catalog signed bytes, downloads, retry and terminal failure; zero skips.
- Isolated tarball consumer: copied Tasks installs, builds, typechecks and runs in Chromium outside the workspace.
- PostgreSQL example lifecycle: ownership, public projections, native validation, persisted UUIDv7 IDs, foreign keys, runtime DDL denial, committed migration replay and schema evolution; four tests, zero skips. Upload worker/event integration also passes.
- Native generator regression and packed browser transport regression pass. E2E TypeScript passes. React Doctor reports no issues for either example.

Sequential code/security review covered output redaction, private route discovery, identity-bound credential lookup, bearer-ticket handling, disposal races, fresh reconnect tickets, version refusal, restricted database authority and separation of fake auth from production builds. Review fixed public projections, stale-version error loss, copied-project dependency isolation and pending-call disposal. No outstanding findings within this unit. Review ran in the main session, not independently; the final whole-change review is still required.

U12 remains incomplete: hosted Functions/Auth/Object Storage acceptance, multi-instance notifications, load measurements and populated-branch upgrades are next. Authenticated read-only provider inspection confirmed project `late-moon-69483649` (`kello`), PostgreSQL 18, `aws-us-east-1`. No cloud resource was mutated in this unit. Local results do not establish hosted acceptance.

## U12b — Hosted Auth, Functions and Object Storage

Extended the real Neon Auth acceptance suite to both native examples. Tasks passed signup, live CRUD and session re-entry on the owned Tasks branch. Upload Catalog passed signed upload/download bytes, actual provider object-created delivery, scheduled retries, terminal failure and session re-entry on a separate owned branch. Each run executed one test with no skips; storage took 185 seconds. Target and release evidence is recorded in `orpc-neon-acceptance.md`.

Sequential main-session code/security review checked branch-name fencing, restricted runtime credentials, secret-free receipts, real provider events without manual worker substitution, byte comparison, bounded waits and test-root cleanup. Fixed the selected-example target label and misleading runtime-role assertion. Typecheck and lint pass. This is not independent review. Cloud resources are deliberately retained for the remaining U12 checks and must be removed by this run; their temporary key must be revoked. Multi-instance, performance and populated-upgrade acceptance remain open.

## U12c — Realtime operational counters

Added bounded diagnostic-channel counters for active subscriptions, running evaluations and remaining batch entries. No endpoint or user data is added to the runtime. The hosted acceptance fixture can consume these metrics to verify concurrency and cleanup instead of inferring resource behavior from latency alone.

The blocked-evaluation test proves the concurrency bound, that queued evaluations never begin after stop, and that all counters return to zero after shutdown. Full workspace check passes 15 tasks and 206 unit tests. Sequential main-session code/security review checked cancellation, queue accounting, bounded labels and absence of identifiers or payloads; no outstanding findings in this small unit. Hosted resource acceptance remains pending.

## U12d — Cross-instance hosted realtime smoke test

Added a reproducible two-Function harness using the generated service, a test issuer whose private key stays in the test process, 100 browser TanStack observers, direct SQL writes and forced LISTEN disconnections. Test-only metrics travel over the same authenticated RPC peers as the subscriptions, because separate HTTP requests can reach different Neon isolates. This corrected the initial idle-metrics failure instead of weakening the resource assertions.

The corrected hosted smoke test passed with no skips. Both distinct instances held 50 subscriptions, recovered their listeners, observed all 100 writes and released subscriptions/listeners after unsubscribe; evaluation and batch limits held. Full evidence and preliminary ten-second latency bounds are in `orpc-neon-acceptance.md`. This does not satisfy the full performance gate. An isolated pre-redesign build also established initial size/typecheck comparisons; no measured aggregate exceeds the 20% threshold.

Sequential main-session code/security review checked target fencing, runtime-only deployment credentials, test-only metric authorization, issuer-key isolation, bounded retained samples, original provider upgrade requests, deliberate absence of secret-bearing receipts and cleanup ownership. Typecheck and Oxlint pass. No outstanding findings in this subunit; final whole-change review remains required. Pending work includes long-run matched performance, slow-consumer load, populated upgrades, cleanup and U13.

### Follow-up gates found while preparing final acceptance

- KTD3/U2: `Storage` exists as an Effect service declaration, but `rpc/runtime-graph.ts` does not inject it into procedure contexts. Native handlers also need the diagnostics service in their oRPC Effect context, not only in the outer ManagedRuntime. Complete and verify invocation ownership and identity binding before claiming the service integration finished.
- U6/U11: `createRpcOpenApiApp` exists, but `createNeonRpcService` does not expose an assembled opt-in OpenAPI route. Verify the configuration and finite-router contract end to end rather than counting the low-level adapter alone.
- U11/U12: stale native tickets receive 409; the actual historical client's `/api/kello/call` path still needs a deliberate, client-readable upgrade result on the new service. A generic missing-route result is not enough evidence.
- U13: legacy public builders, transports, React hooks and runtime exports are still present. Their removal, corresponding coverage migration and storage-client extraction remain required.

## U12e — Effect diagnostics context correction

Native Effect handlers now receive Diagnostics in their oRPC context. Database middleware preserves the same service in its typed output context, so composing the generated builder with database capabilities remains type-safe. A regression invokes an actual native Effect handler and observes its diagnostic-channel emission; the full workspace check passes all 15 tasks and 207 tests, and Oxlint passes.

Sequential main-session code/security review covered service identity, context composition, absence of request data in the emitted metric, and listener teardown in the test. The first check caught the database middleware's narrower Effect context; that was fixed before this commit. No outstanding findings in this correction. Storage service injection and assembled OpenAPI remain separate open gates.

## U12f — Assembled OpenAPI configuration

`defineConfig({ openapi: true })` now reaches generated runtime options, the Neon service and local development. Runtime startup rejects public procedures without representable output contracts. REST uses the finite public graph, so a live procedure returns one authorized database snapshot; internal procedures remain absent. The native RPC/WebSocket graph is unchanged. Contract fingerprint is 14.

Verification: full workspace check passes 15 tasks/207 unit tests; 10 PostgreSQL 18 transport, runtime and generation tests pass with no skips. Tests cover configuration propagation, startup rejection, live-to-finite REST output, private route exclusion, invalid authentication and stale versions. The final local runtime test and lint pass after review changed development adapter initialization to occur under an owned request, preventing unobserved initialization rejection. Sequential main-session code/security review found no remaining issues in this unit. This is local adapter evidence, not an additional hosted OpenAPI deployment claim.

## U12g — Invocation-owned storage services

Promise handlers receive `context.storage`; Effect handlers receive `Storage`. Both use the same identity-bound capability. Applications cannot supply an owner or cancellation signal. Started operations drain before invocation completion, shutdown propagates cancellation and waits for cleanup, and escaped capabilities reject further work. Missing storage reports `STORAGE_UNAVAILABLE`.

Storage control-plane calls own independent transactions. Read/write database procedures therefore reject them; a rejected call in a write procedure also poisons its transaction even if application code catches the error. This avoids committing database writes after a forbidden independently committed operation. Storage policy and owner checks remain in the existing intent implementation; typed intent failures become bounded declared RPC errors.

Verification: full workspace check passes 15 tasks and 207 unit tests. PostgreSQL 18 integration verifies actual intent rows, Promise/Effect access, cross-owner denial, escaped capability rejection, transaction rollback after a caught forbidden call, unawaited-operation draining and cancellation during shutdown. Final regression and lint pass after review removed a throw from `finally`, preserving the original handler failure while still draining work. Sequential main-session security/code review examined identity capture, scope escape, retry boundaries and lifecycle ownership. No outstanding findings within this correction; hosted byte/event acceptance remains the U12b evidence, not proof of this newly added handler service on Neon.

## U12h — Deliberate historical-client refusal

The retired `/api/kello/call` path and ticket requests without the native protocol header return a bounded protocol-1 error envelope with `VERSION_MISMATCH` and HTTP 409. This lets the existing historical client report an upgrade requirement without keeping argument decoding, function references or dispatch alive. Origin and method checks still run first; no credentials are verified and no connection ticket is issued for retired requests.

Verification: eight transport tests pass, including the historical client making exactly one request per refused call/ticket and recognizing both errors. E2E TypeScript and Oxlint pass. Sequential main-session code/security review checked preflight/origin ordering, no body parsing or handler side effects, bounded response fields and native protocol preservation. No outstanding findings in this local correction. Actual populated hosted upgrade acceptance remains open.

## U12i — Reproducible sustained hosted load

Extended the two-instance fixture with a 30-second warmup, ten-minute spread/hot-table workloads, finite HTTP timing, concurrent writer lock samples and resource attribution to the measured service pools. Repeated runs reset only rows belonging to the exact test issuer and subject. The issuer fixture now waits for its fresh public key to reach the function URL before issuing tokens. Failed resource assertions retain latency and final-counter evidence without recording credentials.

The full notification spread run completed 6,000 writes, with visibility upper-bound p95 378 ms, zero browser errors and zero remaining subscriptions/listeners. The first historical polling run completed the same workload with upper-bound p95 1,201 ms. These preliminary results do not satisfy the three-run comparison requirement; the latest-runtime run and finite/hot-table measurements remain in progress. See the acceptance receipt for release and measurement boundaries.

E2E TypeScript and Oxlint pass. Sequential main-session code/security review checked fixture ownership, bounded samples, concurrent promise handling, restricted runtime deployments, pool attribution and secret-free receipts. The hosted spread evidence predates the final finite-timing and writer-contention additions; those paths require subsequent hosted verification. No independent review is claimed.

## U12j — Hosted OpenAPI and invocation services

A dedicated storage-enabled fixture now deploys explicit output contracts through the normal generator and Neon release path. Hosted REST verifies Promise creation and Effect status access, cross-owner denial, invalid authentication, stale-version refusal and exclusion of internal procedures. The corrected run passed both this test and the PostgreSQL 18 bootstrap/isolation test with zero skips. The latter now expects all 23 migrations and supplies the owner role explicitly because the branch has multiple roles.

The first hosted attempt exposed a fixture error: `Effect.promise` treated a denied storage operation as a defect, correctly redacted to 500. The handler now uses `Effect.tryPromise` so the declared 403 survives. A PostgreSQL regression verifies both successful and cross-owner Effect access; production defect redaction remains intact. E2E TypeScript and Oxlint pass.

Sequential main-session code/security review checked complete REST output contracts, generated backend typechecking, native service ownership, cross-owner refusal, private route exclusion, secret-safe diagnostics and disposable-branch fencing. No outstanding findings in this unit; review is not independent. This fixture proves assembled OpenAPI and invocation storage on Neon, while the earlier real Auth/upload acceptance remains the byte/event evidence.

## U12k: Populated Neon upgrade and deployment recovery

The hosted upgrade fixture starts from an actual historical `b8ddb6a` deployment with metadata version 21 and 100 tasks. It preserves the application migration history and existing framework hashes while upgrading to metadata 23. It seeds one pending legacy-format job explicitly; this is persisted-envelope migration coverage, not a claim that the historical application scheduled that fixture job.

On disposable branch `br-shiny-union-awunuvgy` in project `late-moon-69483649`, the test interrupted deployment after a real provider function submission, then resumed through normal deployment APIs. The old client received `VERSION_MISMATCH`. The scheduled Neon worker, without a manually invoked trigger, completed the mapped job in one attempt, retained its original envelope, and wrote the expected result. One test passed, zero skipped, in 115.47 seconds. Historical release: `8d151a64be1644cfccf1174c932c65246564ff3e3f0fc3efdaa98315fb84f4ae`; successor: `824e718e0ede22a66e528d67494e519b51c2776944e4b7209eaabbe516e334ed`. Receipt: `/tmp/kello-u12-upgrade-6.json`, completed 2026-09-24T23:50:01Z.

Failed setup attempts remain failures: the initial disposable upgrade branch reached metadata 23 before the fixture's provider wrapper failed. It was deleted and replaced to repeat acceptance from genuine version-21 state. The fixed wrapper preserves provider instance methods. The issuer fixture now gives each public key a unique ID and JWKS URL; it no longer cancels an already-consumed response body. Private signing keys remain only in the test process.

Sequential code/security review covered disposable-target restrictions, historical activation identity, validated SQL identifiers, preserved job payloads and ownership, real submission before interruption, resumed grant ownership, worker claim fencing, assertion diagnostics and secret handling. No unresolved findings in this unit; review was performed in the main session. Performance repetitions, paused-peer acceptance and final owned-resource cleanup remain separate gates.

## U12l: Hosted capacity refusal and Neon close-code correction

A Node `ws` test pauses the actual TCP receive socket and submits 192 calls to an intentionally delayed, 256-KiB response procedure. The first fast/throttled workloads did not establish saturation. The delayed workload exposed a real adapter defect: Neon rejects reserved close codes through its WHATWG socket API. A separate disposable hosted probe returned `InvalidAccessError` for 1001, 1009 and 1013, and accepted 1000 and 4009. The adapter now maps protocol reasons to application codes (4001 shutdown, 4008 policy, 4009 capacity, 4013 resync) while preserving the reason. The provider's upgrade response remains untouched. Generation fingerprint is now `kello-contract-15`.

Hosted acceptance `/tmp/kello-u12-services-11.json` passed on `br-orange-brook-awq4kx1v`, release `c7c4734a586c2aa5c9c296d1a207418f96cb8db84ad51dd9249f9b065632baf5`, at 2026-09-24T23:56:42Z: one test, zero skips, 59.59 seconds. It received `4009 CAPACITY_EXCEEDED` and also passed assembled REST, Promise/Effect storage, cross-owner denial, authentication, stale-version and private-route checks. This proves bounded concurrent-call refusal with a paused receiver; it does not measure the provider's TCP buffer size. The earlier 1006 closure attempts remain failures.

Nine local native transport tests passed with 51 assertions and no skips, including a bridge mock that rejects reserved close codes. The Node test client uses pinned ws 8.21.3 and @types/ws 8.18.1 only as acceptance dependencies. The documentation's compiled procedures add the already-pinned oRPC server dependency. No runtime dependency upgrade is bundled with the fix.

Sequential code/security review checked that close-code translation occurs only at the Neon boundary, socket getters remain live and methods retain their receiver, shutdown drains owned work, and no authentication or capacity limit is weakened. Test credentials enter the child through stdin and are absent from receipts. The hosted diagnostic function is temporary on the owned acceptance branch and must be removed during final cleanup. Review ran in the main session, not independently.

## U13a: Native procedure and client authoring documentation

Updated the compiled documentation procedures and auth policy to use schema-bound native oRPC, explicit database middleware and inferred outputs. Tutorials now describe direct callable TanStack options, identity-owned sessions, finite snapshots, native escape hatches, optimistic pause ownership, Effect failure handling, explicit OpenAPI output contracts, actual internal procedure targets and standalone Neon Object Storage. Development and deployment instructions lead with `kello.config.ts`; advanced declaration files remain optional. Removed obsolete claims about stringified Date/bigint and the custom live store from these tutorials.

The documentation build and compiled examples passed with the full 15-task workspace check; 207 unit tests passed. Sequential code/security review checked examples against generated factory signatures, middleware authority, owner filters, runtime validation, idempotency boundaries, session disposal and storage-event identities. Corrected a stale claim that documentation snippets had been tested as a packed consumer; their current proof is compilation against the built public API. No unresolved findings in these authoring pages. Operator performance evidence, the final upgrade guide, legacy implementation removal and CI gates still remain in U13.

## U13b: Required cloud runner and reproducible predecessor

`test:cloud` now requires an explicit suite and disposable provider target. It discovers the selected endpoint's connection, verifies even supplied database URLs before setup DDL, provisions real branch Auth when requested, and rejects missing or stale success receipts. Historical upgrade setup archives the pinned predecessor with frozen dependencies and overlays only recorded acceptance fixtures. CI runs six required profiles serially, fails missing credentials or skipped matrix execution, records receipt identity and verifies deletion of its expiring child branch. Child branches avoid the provider's schema-only root-branch quota.

Actual local execution of the CI entrypoint passed three tests with zero failures in each profile: jobs-storage on `br-sweet-resonance-awleb27n` (218.64 seconds), populated upgrade on `br-withered-scene-awkpj2zi` (132.40 seconds after historical preparation), and services on `br-orange-brook-awq4kx1v` (64.83 seconds). The services run includes the latest endpoint-bound URL preflight. Receipts are `/tmp/kello-u13-ci-receipts/jobs-storage.json`, `/tmp/kello-u13-ci-upgrade-receipts/upgrade.json`, and `/tmp/kello-u13-ci-services-receipts/services.json`. These are local executions of the CI runner, not a claim that GitHub Actions ran. Branch cleanup remains pending until final evidence collection.

Sequential code/security review checked default/protected-target refusal, explicit endpoint binding and TLS, quoted setup identifiers, credential-free build subprocesses and diagnostics, fixed historical commit, receipt freshness and target identity, matrix skip rejection and exact owned-name cleanup. TypeScript and Oxlint pass. The historical benchmark's third repetition raced server cleanup immediately after browser unsubscribe; its harness now requires two idle samples within ten seconds while preserving the zero-activity assertion. The historical runtime is unchanged and the complete repetition is rerunning; the failed run is not performance acceptance.

## U13c: Separate storage from retired function transport

The public `createStorageClient` now constructs its own control-plane methods rather than creating the old function client. Shared bounded HTTP mechanics retain authentication refresh, identity pinning, cancellation, response limits, redirect refusal and stable intent keys. The retired client temporarily delegates storage to that same implementation while its remaining consumers are removed; no duplicate storage transport was introduced.

Four standalone storage regressions plus ten existing client tests pass. The PostgreSQL 18 storage HTTP integration now consumes `createStorageClient` directly and passes JWT/tenant isolation, uncertain-response replay, intent validation, verification and signed download behavior with zero skips. Core/E2E TypeScript, build and Oxlint pass. Sequential code/security review compared the moved request logic, checked that a retried create retains its original intent key, and verified that identity refresh cannot send a second request under another user. The retirement of the remaining function client is still open.

## U13d: Remove the legacy React provider

Removed the custom `KelloProvider`, its client context and `useKelloClient`. The optional React entry point now re-exports TanStack's provider and hooks directly. Generated native callables already own their session binding; no second React context is needed. The SSR unit and hook type fixture now exercise native procedures/options. Removed the superseded protocol-1 browser fixture and its browser test.

Coverage mapping: native `rpc-client.test.ts` verifies packed shared streams, reconnect and sign-out disposal; `optimistic-live.test.ts` verifies live pause/refetch during writes; `rpc-ssr.test.ts` verifies finite prefetch and hydration. All three pass (33 assertions, zero skips). The native options suite additionally verifies issuer/subject/tenant/version key isolation, observed-data disposal, mutation callbacks and default retry refusal. Nine focused React/options/transport unit tests pass. Test/E2E TypeScript and Oxlint pass.

Sequential code/security review checked that removing context cannot bypass session ownership, that the public hooks are the actual TanStack hooks, and that no server imports reach React. Native SSR still makes zero requests during ordinary render. The removed browser test's custom protocol machinery is not retained as a second implementation. Legacy query/cache and server generation removal remain open.

## U13e: Move migration and release regressions onto native initialization

Migration CLI, development sync/watcher, release database and release preparation fixtures now use the public native initializer. The storage-enabled release fixture uses native storage declarations. PostgreSQL 18 executed all seven scenarios successfully across the initial run and the corrected release-preparation rerun; no cases were skipped. This retains schema drift, unsafe DDL refusal, history preservation, provider submission recovery, role ownership and trigger checks while removing their dependency on the legacy fixture initializer.

Sequential code/security review verified that only authoring setup changed, existing lifecycle and credential-redaction assertions remain, and the release storage authorization default is still deny. E2E TypeScript passes. Native runtime migration of the remaining development/release fixtures is still pending.

## U13f: Native CLI generation and capability regressions

Converted all nine CLI generation scenarios to native initialization and procedure objects. They retain Node 24 provider bundles, immutable captured configuration, authorization edits, schema-bound relations, concurrent deterministic generation, stale/cancelled activation refusal, symlink ownership checks, browser exclusion of private procedures, invalid cron/storage target refusal and attempt limits. Native cron targets are checked in both retained Node-loaded generations; retired string-reference kind/version assertions were replaced by procedure-object identity and compiled envelope version checks.

All nine scenarios pass (114 assertions, zero skips), including a clean consumer typecheck and browser bundle with a private sentinel. E2E TypeScript, formatting and Oxlint pass. Sequential code/security review confirmed private target exclusion, deny-by-default authorization, policy edit fingerprints and unchanged active generation after rejected candidates. During migration, a fixture invoked the schema-bound procedure without its required Effect context; it was corrected to supply an explicit fixture context. No production error boundary was weakened.

## U13g: Decouple native authentication and runtime contracts

Moved provider JWT/origin configuration out of the legacy authorization definition, so native authentication no longer imports the retired dispatcher. Activation and storage-backend contracts now live independently of the legacy runtime; native runtime and Neon trigger binding imports point there. The implementation preserves verification, denied-by-default policies and activation callbacks.

Core build/typecheck and Oxlint pass. Twenty-one focused auth/entrypoint/trigger unit tests pass. Four PostgreSQL/Node integration scenarios pass with zero skips: TLS JWKS rotation/fail-closed behavior, external activation identity and read-only grant, assembled native runtime shutdown and invocation-owned storage. Sequential code/security review compared configuration parsing and verifier construction, verified that authorization still comes from the branded native policy, and confirmed no new runtime values or provider privileges were introduced.

## U13h: Native development lifecycle regressions

Development startup, packed storage entry points and the complete development loop now use native initialization and oRPC calls. The loop schedules native internal procedures, verifies serialized durable results, dispatches its cron, recovers from invalid source and credentials, fences stale versions, and checks CLI shutdown and quarantine. Explicit `INTERNAL_SERVER_ERROR` assertions preserve redaction at denied runtime activation boundaries.

All three PostgreSQL 18 scenarios pass with zero skips (50.94 seconds), including real database roles and packed provider entries. E2E TypeScript, formatting and Oxlint pass. Sequential code/security review checked unchanged ownership/privilege refusal, credential redaction, lifecycle recovery and pending-job quarantine assertions; the test-only RPC helper accepts undefined for native zero-argument procedures. These are local lifecycle tests, separate from the ongoing hosted Neon benchmarks.

## U13i: Native packed release activation

The HTTPS packed-release fixture now initializes native procedures, calls the oRPC endpoint and uses native auth/storage declarations. Its retained pending job starts as a valid native internal call; the later incompatibility test deliberately assigns a foreign version. An initial test run correctly rejected the old fixture's unmapped legacy job at activation, and the fixture was corrected without weakening the upgrade gate. All health/drift, trigger ownership, rollback, credential, retirement and data-preservation assertions remain.

The PostgreSQL 18 scenario passes with zero skips (4.06 seconds). E2E TypeScript, formatting and Oxlint pass. Sequential code/security review checked that the fixture still denies all public paths except tasks/list, that incompatible work blocks migration, and that trigger/role/activation faults retain their original refusals. The now-unused legacy project initializer is removed; frozen historical fixtures remain separate for real upgrade acceptance.

## U13j: Native-only generation and runtime selection

Removed legacy discovery, string-reference proxies, query-option generation, registry artifacts, generated function builders and legacy runtime selection from tooling. Generation and doctor now report procedures. The manifest requires the native protocol/procedure graph, and contract fingerprint 16 prevents reusing artifacts from the previous runtime contract. Historical upgrade envelope readers and retained release inspection remain intentional compatibility boundaries.

The loader rejects server imports of generated client/internal bindings, preventing a prior generation from entering the next source hash. Native codegen verifies this refusal preserves the active generation; a consumer typecheck proves legacy query builders are no longer exported from generated/server. The existing private-route browser exclusion and native capability ownership tests remain intact.

Nine CLI scenarios (114 assertions), two native codegen scenarios (42 assertions), and the native discovery unit pass. Three PostgreSQL 18 lifecycle scenarios pass with zero skips (35.54 seconds): startup, complete development loop and packed HTTPS release activation. Tooling, CLI, test and E2E TypeScript checks and Oxlint pass. Sequential code/security review checked stable wrapper ownership, deterministic version changes, explicit native auth defaults, private target resolution and retained durable-upgrade enforcement. An initial CLI test exposed doctor still counting the removed function graph; its structured and human output now consistently counts procedures.

## U13k: Native-only development transport

The development server accepts only native runtime graphs and the versioned oRPC socket handshake. Removed legacy HTTP/session assembly and shutdown branches. Its runtime interface declares the capabilities the server actually consumes, allowing native fixtures without constructing unrelated database services.

Eight focused scenarios pass with zero skips, including PostgreSQL-backed runtime replacement. Native HTTP/WebSocket fixtures retain ticket replay/expiry, origin, connection capacity, publication cancellation, late handshake, concurrent replacement, rejected-candidate cleanup, retirement failure and shutdown-drain assertions. Stale socket versions are explicitly refused before ticket redemption. The old runtime fixture's development section moved to the native runtime scenario; startup/connection cleanup also remains covered by the native development lifecycle suite.

Tooling build/typecheck, E2E TypeScript, formatting and Oxlint pass. Sequential code/security review checked that every socket still reserves capacity before asynchronous redemption, release remains idempotent, shutdown waits for owned requests, and removed branches cannot accept retired protocol traffic.

## U13l: Preserve mutation intent during explicit retries

Review of the retired options layer exposed a native regression: caller-enabled TanStack retries generated a fresh transport idempotency key on every attempt. Native mutation interceptors now keep one UUID per TanStack mutation execution in the owning session, including rebuilt options, and pass it through oRPC context to WebSocket headers. Subsequent mutations get distinct keys. Raw transport callers may explicitly supply a UUID for an intentional retry; invalid keys are rejected before procedure dispatch. Default mutation retry remains disabled, and external providers still own their idempotency enforcement.

Thirteen focused options/transport/optimistic tests pass. A Bun WebSocket integration verifies the complete context-to-header path with a simulated write whose response fails: each retry reuses its original key, two logical writes commit twice, and an invalid raw key reaches no handler. This transport test simulates commit uncertainty; existing PostgreSQL replay tests own transactional receipt evidence. Core build/typecheck, test/E2E TypeScript, formatting and Oxlint pass.

Sequential security/code review checked session scoping, weak ownership of completed mutation keys, distinct concurrent execution contexts, UUID validation, and preservation of caller context and native option inference. The correction is documented in the subscription guide. Frozen hosted benchmark revisions do not contain this client-only correction; their live/finite workloads do not exercise explicit mutation retries.

## U13m: Remove the retired query-options implementation

Removed the legacy QueryClient binding, callable reference methods and custom snapshot-to-stream adapter. The query entry point now exposes only native oRPC/TanStack callables, session ownership and optimistic coordination. Removed the old options suite after mapping its scenarios: finite/select/skipToken and identity-key isolation are native options tests; shared streams/disposal are native observer and browser tests; explicit retry intent is U13l; disabled reads and late mutation completion now have a native regression.

Eleven native options/optimistic tests pass. The new disposal regression proves an unresolved write cannot invoke success callbacks or retain mutation cache state after its session ends. Core build/typecheck, test/E2E TypeScript and Oxlint pass. Sequential code/security review verified no remaining imports of the removed query implementation, retained upstream callback/type inference, and cancellation before late result publication.

## U13n: Separate durable ingress from retired declarations

Moved cron validation/receipts and storage-event delivery/reconciliation into shared durable modules. Native adapters now depend on these modules directly; legacy declarations remain thin temporary adapters. Scheduling policy lives with durable job contracts, and the unused legacy Effect scheduler service is removed.

The extracted execution bodies are byte-identical to their previous implementations. Twenty-seven focused unit tests and four PostgreSQL 18 scenarios pass (46 assertions, zero skips); core/tooling/test/E2E typechecks and formatting/Oxlint pass. Sequential code/security review checked parameterized receipt queries, project/branch/deployment scoping, activation locks, upload ownership, consistent lock ordering, duplicate-delivery fingerprints and pending-receipt recovery. No authority, retry or receipt behavior changed.

## U13o: Native Node 24 compatibility

The compiled-package compatibility test now exercises native oRPC HTTP authentication and serialization, including Date and bigint output, and verifies the retired endpoint returns a terminal upgrade refusal. Its browser bundle assertion targets the native transport. Database invocation lifetime and independent patched Drizzle ESM/CommonJS introspection checks remain.

All three Node 24/PostgreSQL 18 scenarios pass with zero skips. E2E TypeScript, formatting and Oxlint pass. Sequential code/security review checked that the test imports compiled public exports, runs without Bun globals, verifies authenticated identity, and retains browser exclusion of Node imports and database configuration.

## U13p: Independent storage HTTP boundary

Native Neon and development runtimes now import a storage-only HTTP boundary. Its public options have no dispatcher, legacy ticket or anonymous-access settings. The storage control-plane protocol remains unchanged; storage HTTP tests now use the standalone storage client. New assertions reject legacy call/ticket routes, foreign origins and invalid protocol versions before storage operations.

Sequential security/code review found the inherited verifier await could exceed the configured deadline. The new boundary uses the existing abortable ingress helper; a stalled-verifier regression returns 504 without invoking storage. Authentication expiry, strict input parsing, 16 KiB body bound, tenant identity, response redaction and CORS behavior remain. Ten focused unit tests and two PostgreSQL 18 integration scenarios pass with zero skips (packed deployment storage and native invocation-owned storage). Core/test/E2E TypeScript, formatting and Oxlint pass.

## U13q: Native tenant-authenticated upload regression

Migrated the real PostgreSQL/JWT storage HTTP scenario onto the native runtime and extracted storage endpoint. Its signed tenant tokens, lost-response retry, persisted intent count, cross-tenant refusal, policy redaction, upload verification and CORS assertions remain. The scenario passes with zero skips, along with E2E TypeScript, formatting and Oxlint. Sequential code/security review confirmed the fixture still uses the restricted database role and actual JWT verification and no longer assembles the retired function dispatcher.

## U13r: Native storage-event lifecycle regression

Migrated the storage runtime/worker lifecycle fixture to native internal procedures and procedure-owned storage events. The invalid-target check now rejects an unregistered internal procedure object; this replaces the retired reference-version check while preserving the capability ownership requirement. The fixture retains backend construction/cleanup counts, duplicate provider delivery, one job execution, copied identity, cross-tenant refusal, private bucket activation, expiry cleanup and shutdown draining.

The PostgreSQL 18 scenario passes with zero skips. E2E TypeScript, formatting and Oxlint pass. Sequential code/security review checked null job identity, required job metadata, pre-connect capability refusal, target mismatch cleanup and the unchanged trigger authorization assertions.

## U13s: Native durable declaration tests

Cron and storage declaration tests now use native procedure objects. They preserve captured inputs/policies, numeric UTC schedule bounds, declaration branding, default-deny storage authorization and handler-specific argument type rejection. Invalid cron names are checked at capability compilation, where the native contract owns that validation. Internal visibility is checked against the generated graph by the existing native capability suite rather than a retired reference kind.

Four focused tests, the complete test typecheck, formatting and Oxlint pass. Sequential security/code review verified copied options cannot replace captured handlers or authorization, unbranded declarations remain rejected, and missing/ambiguous internal targets retain explicit runtime validation.

Hosted progress: the first hot-table pair completed successfully with 6,000 writes. Polling live upper-bound p95 was 1,330.951 ms; native notification p95 was 488.005 ms. Warm finite p95 was 573.912 ms versus 350.433 ms. Two repeated hot-table pairs remain, and the earlier spread finite-latency regression is still unresolved.

## U13t: Durable worker lease regressions without legacy dispatch

Worker unit tests now invoke the shared durable execution engine with native job envelopes. Neon trigger options depend on the durable worker's run contract instead of the legacy adapter. Lease renewal, deadline/ownership loss metrics, cancellation, claim-time shutdown, coalescing, timer cleanup and queue/activation redaction assertions remain. Native procedure context mapping remains covered by rpc-jobs integration tests.

Thirteen worker/trigger tests, core/test typechecks, formatting and Oxlint pass. Sequential code/security review confirmed the execution callback receives the whole persisted job and its owned abort signal, no lease checks moved, and no production worker behavior changed. An initial relative test import was corrected before the successful checks.

## U13u: Native process-crash recovery

The API SIGKILL fixture now hosts the native runtime and socket session; consumers use the native transport, TanStack Query observers and Kello live callables. The test kills one of two processes, commits a raw SQL write during downtime, restarts on the same port and requires both observers to reach the new value with a fresh connection ticket request. The fixture deliberately supplies trusted identity; actual JWT/single-use ticket enforcement remains in dedicated transport and hosted tests.

The PostgreSQL 18 scenario passes with zero skips (2.6 seconds), including a rerun after awaiting socket disposal. E2E TypeScript, formatting and Oxlint pass. Sequential code/security review checked child cleanup, restricted runtime credentials, native stream ownership and no lost downtime write. Native configuration rejected the old fixture's 10 ms polling interval; the fixture now uses the supported 100 ms minimum. Diagnostic assertions now retain useful errors while redacting database URLs.

## U13v: Remove legacy cache and live-client implementations

Removed the custom cache, subscription store and reconnection state machine and their public exports. Native TanStack/oRPC now owns those responsibilities. Removed tests specific to retired sequence frames, duplicate subscription messages and legacy cache eviction. Coverage mapping: native options tests own scope keys, shared streams, observer disposal, disabled queries and late-result refusal; native transport tests own credential/version refusal and disposal during authentication; the packed browser test owns reconnect/fresh tickets/sign-out; U13u owns actual process death and downtime SQL writes. The old HTTP integration now tests its remaining authorization boundary directly instead of using the removed cache. Native type fixtures retain branded IDs, Date/bigint and typed options; storage type checks use the standalone client.

Fourteen focused native unit tests pass. Twelve PostgreSQL/socket/browser scenarios pass with zero skips (104 assertions), including real Chromium and SIGKILL recovery. Core/test/E2E TypeScript, formatting and Oxlint pass. Sequential code/security review verified no source imports remain, query sessions still abort before clearing identity-scoped data, and mutation retry intent remains separate from live reconnect. Upstream cache eviction and oRPC frame ordering are no longer duplicated framework implementations.

## U13w: Native assembled-runtime parity

Moved the remaining assembled legacy-runtime checks into the native scenario, then removed the retired test. Added explicit scheduling replay, persisted retry delay/attempts, configured lease duration, activation refusal before connecting, invalid cron/worker startup, stopped ticket/worker/service refusal, idempotent stops, pending trigger-body cancellation and eventual zero database connections. The native fixture explicitly requests two attempts, as the durable API defaults to one rather than the configuration maximum.

Coverage mapping: native runtime retains internal route exclusion, oversized-result rollback, cron delivery deduplication, development replacement and OpenAPI; native live integration owns revision tracking and cancellation; native transport integration owns verified identity, ticket authority and pending socket shutdown. Three PostgreSQL 18 scenarios pass with zero skips (65 assertions). E2E TypeScript, formatting and Oxlint pass. Sequential code/security review checked startup cleanup, preserved authority boundaries, persisted policy values and cancellation before returning a stopped response.

## U13x: Native activation-lock regression

Migrated the activation integration to a native database-read procedure and oRPC HTTP. It retains external branch/endpoint/token checks, runtime-role write refusal, admission races, quarantine/retirement refusal and the shared activation lock held during handler execution. The quarantined in-flight admission now asserts the native redacted INTERNAL_SERVER_ERROR response and proves the handler did not run.

The PostgreSQL 18 scenario, E2E TypeScript, formatting and Oxlint pass with zero skips. Sequential code/security review checked unchanged row-lock timing and provider identity assertions. An initial fixture constructed separate relations objects for the middleware and runtime; the native capability check rejected it. The fixture now shares one schema-bound relations object, preserving that ownership check.

## U13y: Native ingress handoff regression

The handoff integration now uses native durable job envelopes, internal procedures, cron dispatch and storage receipts. It still proves deployment handoff waits for an admitted cron transaction, cancellation escapes a blocked ingress lock, retired storage ingress does not inspect objects, and an already-persisted job executes after ownership changes. Provider control-plane interactions remain an explicit local fixture; hosted deployment/upgrade receipts are separate evidence.

The PostgreSQL 18 scenario passes with zero skips (1.4 seconds), alongside E2E TypeScript, formatting and Oxlint. Sequential code/security review checked the exclusive/shared advisory-lock assertion, unchanged provider branch identity, null service identity and exact one-job/one-execution outcomes. This fixture's handler has no database effects; transactional worker replay remains covered by rpc-jobs.

## U13z: Native Node worker crash recovery

The Node 24 worker fixture and PostgreSQL recovery scenario now use native procedures, transactional replay, job envelopes and workers. They kill a separate Node process after claim and after commit, recover expired leases, manually replay an exhausted committed job and require exactly one database effect per logical job. The test retains persisted identity, immutable attempt metadata, revoked authorization, external-error redaction, explicit external retries and running-job cancellation.

A replacement runtime now cannot claim another version's pending job; the assertion checks the job stays pending with zero attempts, matching native claim fencing. Explicit mapped upgrades are covered separately. All 46 assertions pass with zero skips (6.5 seconds); E2E TypeScript, formatting and Oxlint pass. Sequential code/security review verified child cleanup, original job IDs across retries, no automatic retry of external effects, and the native serialized result envelope.

## U13aa: Native durable queue regression

The queue integration now persists native envelopes and validates native internal targets. It retains transactional enqueue rollback, deduplication conflicts, version/deployment claim isolation, concurrent claims, recovered lease metrics, stale acknowledgements, row-lock expiry, cancellation, replay fencing/audit rollback, restricted-role permissions and configured retry/cron policy.

Removed duplicate legacy function-execution sections: native rpc-jobs owns output-validation rollback, escaped scheduler refusal and idempotent scheduling; rpc-transactions owns caught-failure transaction poisoning. The retired dispatcher-required-await contract is not imposed on native invocation draining. Native worker tests now own stable job replay identity; this queue test checks the original envelope is unchanged. Native validation rejected a reused procedure object registered at two internal paths in the migrated fixture, which now declares distinct procedures.

Three PostgreSQL 18 queue/job/transaction scenarios pass with zero skips (109 assertions). E2E TypeScript, formatting and Oxlint pass. Sequential code/security review checked retained fencing predicates, permission-denied assertions, immutable original envelopes and rollback of both application writes and enqueues.

## U13ab: Native snapshot and revision evaluation regression

Migrated the snapshot regression to native database-bound procedures, live iterators and the shared revision coordinator. It retains authorization-before-handler, concurrent-write snapshot consistency, exact revision capture, empty-result insertion detection, rollback without reevaluation, revoked access, revisions beyond JavaScript's safe integer range, missing tracked rows, permission failures, metrics and pool cleanup. Transport version/visibility/input checks remain in native runtime/transport suites rather than the retired dispatcher.

Two PostgreSQL 18 scenarios pass with zero skips (23 assertions), plus E2E TypeScript and Oxlint. Sequential code/security review checked unchanged restricted credentials and authorization queries, exact old/new revision pairs and terminal access refusal. The internal snapshot test imports the source server boundary consistently: mixing its source AsyncLocalStorage with compiled bindings initially failed, and was corrected without changing production behavior. The adjacent WebSocket scenario exercises compiled public exports.

Hosted progress: hot-table native run 2 failed before measurement with 99 ready subscriptions and one INTERNAL_SERVER_ERROR. Its failed receipt is retained at `/tmp/kello-u12-notify-hot-2.json`; the cause is unresolved. A separately labelled repeat is running. The failure is not counted as a successful performance sample, and the spread finite-latency regression remains open.

## U13ac: Native RLS identity isolation

The RLS integration now calls native database-bound procedures. It retains one physical PostgreSQL connection across Alice/Bob requests, issuer/tenant/anonymous isolation, transaction-local identity inspection during authorization, denied tenant reassignment with unchanged stored data, no identity outside the transaction, forbidden DDL and identity-only handler propagation.

The PostgreSQL 18 scenario passes with zero skips (24 assertions), alongside E2E TypeScript and Oxlint. Sequential code/security review verified the non-owner runtime role, unchanged RLS policy, same backend PID, cleanup after rejected writes and fresh invocation/idempotency keys. This checks trusted-context-to-database binding; JWT verification remains in transport/Neon Auth suites.

## U13ad: Native TCP slow-reader regression

Replaced the retired custom subscription frame fixture with a native oRPC streaming procedure and a real paused Node ws receiver connected to Bun TCP. The test requires bounded server buffering, RESYNC_REQUIRED closure, one disposal, generator cancellation and no later evaluations. This tests transport backpressure independently of database invalidation (covered by native live tests); unlike the hosted concurrent-call test, it directly measures the socket buffer.

The test passes with eight assertions: observed peak 41,980 bytes under the 65,536-byte application limit, 853,610 bytes sent before closure, one disposal and no continuing generator work. E2E TypeScript, formatting and Oxlint pass. Sequential code/security review checked signal ownership, terminal cancellation, real paused reads and cleanup. The fixture uses one documented structural assertion to oRPC's narrow WebSocketLike interface for ws listener-option compatibility; it does not assert a full browser WebSocket or suppress lint.

## U13ae: Fix mutated inputs leaking across transaction retries

Migrating the legacy transaction coverage exposed a native regression: a handler changed `input.amount` from 2 to 1000, hit a PostgreSQL serialization failure, then received 1000 on its retry. A failing native regression reproduced it before the fix.

The database boundary now captures validated input using the native serializer, then decodes a fresh copy for each authorization and handler attempt. A private native procedure executes the original middleware/output stages with already-validated input. The public boundary retains input schemas and contract output metadata; output validation runs once inside the private transaction attempt, before commit. Copies of the encoded representation preserve Date, URL, Set and Map without relying on structuredClone's platform-specific URL support. Caller signal, route and event ID propagate. A cancellation check after authorization prevents an aborted request from entering its handler.

Six PostgreSQL 18 scenarios pass with zero skips (139 assertions). The new regression mutates scalar/Date/Set/URL inputs, forces SQLSTATE 40001, verifies original retry/caller values, and requires one successful output transformation. Existing nested retry/poisoning, rollback, replay, native worker, live snapshot, runtime and RLS scenarios pass. Core/browser/E2E TypeScript, build, formatting and Oxlint pass. Sequential code/security review checked validation ownership, private-only validation bypass, nested retry error propagation, reauthorization per attempt, captured receipt input, signal/route propagation and cancellation before the handler. An intermediate shallow serializer copy still shared data and failed; cloning the encoded representation resolved it.

This changes production transaction execution. Frozen U12 benchmark artifacts do not include this fix; final-runtime acceptance and size/typecheck evidence must be refreshed before completion.

## U13af: Retain transaction engine coverage without legacy functions

The public conflict-exhaustion regression now invokes a native write procedure and requires three attempts followed by the redacted CONFLICT response. Shared transaction-engine tests remain: repeatable-read snapshots, enforced read-only transactions, rollback, real serialization conflicts/deadlocks, bounded retry metrics, cancellation, escaped deferred/prepared queries, cross-invocation borrowing refusal and idle pool cleanup.

Removed duplicate legacy execution cases now covered by rpc-transactions: invalid/unencodable output rollback, mutated input retries, nested writes, read-to-write escalation refusal and caught nested failure poisoning. Retired helper-specific saved-context and mandatory-await tests are removed; native database capabilities and invocation draining own that lifetime, with guarded database and scheduler escape tests retained.

Three PostgreSQL 18 scenarios pass with zero skips (56 assertions), plus E2E TypeScript, formatting and Oxlint. Sequential code/security review checked unchanged deadlock synchronization, database error redaction, bounded retries, unchanged guards and expected state after removing duplicate writes.

## U13ag: Native replay concurrency and scope regression

The replay integration now uses native database procedures and persisted native receipts. It retains canonical input ordering, fresh request identity with stable intent, input/key conflicts, authorization on replay, anonymous/issuer/subject/tenant/deployment/path scope isolation, invalid-output rollback, simultaneous conflicting updates, simultaneous independent inserts with receipt collision, expiry tombstones and pool cleanup.

Native regeneration intentionally reuses the existing receipt rather than adding a code-version discriminator that would repeat the effect. Incompatible serialized receipts remain explicitly refused by rpc-transactions and upgrade coverage. The PostgreSQL 18 scenario passes with zero skips (28 assertions), plus E2E TypeScript, formatting and Oxlint. Sequential code/security review checked barriers require both real transactions, one committed insert, distinct scope assertions, unchanged expiry refusal and authorization before receipt reads.

Hosted progress: second hot-table baseline upper-bound visibility p95 1,306.008 ms versus 368.993 ms for the separately labelled successful native repeat; warm finite p95 450.228 ms versus 166.539 ms. Both completed 6,000 measured writes. The original failed startup receipt remains a distinct unresolved reliability finding. The third hot-table pair is running.

## U13ah: Native local capacity workload

The local contention workload now evaluates native database procedures through the shared revision coordinator. It preserves 1/4/8 writers, 2/16/64 subscribers, two independent four-connection pools, real table-revision lock contention, exact final convergence, no subscription errors and zero queued acquisitions at completion. Evaluation timing is measured around native snapshot execution rather than the removed dispatch metric.

The PostgreSQL 18 scenario passes all 18 assertions with zero skips, plus E2E TypeScript, formatting and Oxlint. Peak connections were 3/8/8 and every subscriber reached all committed writes. Sequential code/security review checked bounded concurrency, unchanged writer retry bounds, restricted runtime credentials, per-evaluation identity/signal ownership and timer/pool cleanup. Internal snapshot capture uses a consistent source module graph; hosted/packed tests provide separate compiled-runtime evidence. Local throughput does not satisfy hosted release latency gates.

## U13ai: Standalone storage throttling regression

The concurrent Retry-After test now exercises the standalone storage client, which owns bounded control-plane retries. Four independent upload intents each receive HTTP 429, wait at least one second and resend identical bodies before accepting validated status responses. Native procedure retry semantics remain covered by rpc-retry, with retries opt-in and stable intent keys.

The test passes ten assertions, plus E2E TypeScript, formatting and Oxlint. Sequential code/security review verified distinct intent bodies, exact retry-body reuse and no added automatic native mutation retry. The local HTTP fixture tests retry policy; actual storage provider behavior remains in hosted acceptance.

## U13aj: Native procedure observability and dispatcher-test retirement

Added `rpc.procedure` timing/status metrics with bounded finite/live/mutation labels and `kello.procedure.failure` events containing only request ID and public error code. Native error mapping remains unchanged. An invocation observation scope avoids duplicate reports when the runtime graph and database boundary nest; metrics cover validated procedure execution rather than every HTTP admission failure.

Eleven native contract tests and three PostgreSQL scenarios pass with zero skips. Tests require no database capability on bare handlers, no automatic retry of an external error carrying SQLSTATE 40001, secret-free diagnostics, correct success/failure labels and exactly one event through the assembled runtime's nested boundaries. Core/browser/test/E2E TypeScript, build, formatting and Oxlint pass. Sequential code/security review checked no raw causes, messages, paths, SQL, identities or arguments enter diagnostic payloads; nested boundaries still redact errors and observation state remains invocation-local.

Removed the legacy dispatcher integration after coverage mapping: native transports own protocol/version/private-route refusal; rpc-contracts owns input validation, inferred handlers, redaction and external no-retry; rpc-runtime owns internal graph/worker assembly; rpc-transactions owns pre-aborted and authorization-time cancellation, transactional capabilities and pool cleanup. Shared transaction tests retain enforced read-only behavior. Legacy dispatch metric types remain only while their production adapter still exists.

## U13ak: Native JWT HTTP and lost-response regression

Migrated the real JWT/PostgreSQL HTTP fixture to native oRPC ingress and client calls. It retains verified issuer/audience/tenant identity, fresh single-use tickets, origin/authentication refusal, forged ticket identity refusal, no-store/CORS headers, private-route exclusion, reauthorization, redacted external errors and atomic receipt replay. Forged owner input never controls the stored owner.

A lost-response fixture now explicitly retries the same native intent key: the first request commits and fails at the client, does not retry automatically, and the second returns the saved value. Exactly two logical intents produce two rows. Legacy client identityKey guarding maps to native session/transport ownership tests rather than being reintroduced into HTTP.

The PostgreSQL 18 scenario passes with zero skips (30 assertions), plus E2E TypeScript, formatting and Oxlint. Sequential code/security review checked actual JWT verification, runtime-role privileges, identical replay payload/key, fresh independent keys, single-use redemption and cancellation of rejected response bodies. Fixed an unbound fetch method warning before committing.

## U13al: Enforce HTTP body expiry before dispatch

Migrating HTTP guard tests exposed a security regression: a token expired while its body arrived; native ingress eventually returned 401 but had already invoked the handler. The failing test observed two handler calls instead of one. A Fetch Request's abort signal alone did not cancel the custom input stream.

Native RPC/OpenAPI ingress now reads bounded request bodies through the existing cancellable reader, checks the combined authentication/request deadline, then passes the completed body to oRPC. GET/bodyless requests retain their original shape. This rejects expiry, stalled reads and dishonest Content-Length before dispatch. The migrated tests retain strict origins, anonymous-call versus authenticated-ticket separation, preflight, invalid input/protocol, size bounds and no credential CORS. A deliberate ticket issuer exception is treated as an internal failure; invalid/missing credentials remain 401.

Three HTTP guard tests pass, including zero extra handler calls on expiry and 504 with stream cancellation on a stalled body. Eleven PostgreSQL/native transport/OpenAPI/runtime scenarios pass with zero skips (126 assertions). Core/browser/test TypeScript, build, formatting and Oxlint pass. Sequential code/security review checked authentication-before-body, bounded allocation, immediate signal checks, no handler execution after expired body reads and unchanged output/transaction ownership. An initial conditional empty spread was replaced with explicit RequestInit assignment to satisfy anti-slop lint. Final hosted acceptance must include this changed ingress; frozen benchmark artifacts do not.

## U13am: Direct native revision-coordinator regressions

Subscription tests now target the shared native revision coordinator instead of the retired reference/poller adapter. They retain LISTEN readiness before snapshots, burst wakeups during evaluation, unchanged-revision suppression, non-starving continuous notifications, runtime concurrency/subscription caps, cancellation and slow-consumer refusal, session expiry, degraded-read resync and shutdown coalescing. Native snapshot values replace retired sequence/response envelopes.

All six focused tests, test TypeScript, formatting and Oxlint pass. Sequential code/security review checked every previous synchronization barrier remains, expiry discards pending values, unsubscribe aborts the owned evaluation before its deferred result settles, and stop removes listener/timer ownership. Native oRPC owns wire ordering; the coordinator owns snapshot scheduling.

## U13an: Native application shutdown boundary

Application unit tests now use native procedures and createNeonRpcApplication. They require synchronous cancellation of the active handler, refusal of new HTTP work, an unresolved stop until the handler releases, idempotent shutdown and correct socket-upgrade refusal. Both focused tests, test TypeScript, formatting and Oxlint pass.

The legacy combined application's trigger test is retired: native worker entry shutdown is covered by rpc-runtime (pending body cancellation, drain, repeated stop and post-stop refusal), while job-worker tests require active execution to drain and shutdown during claim to prevent dispatch. Revision coordinator ownership belongs to the native runtime and its direct tests. Sequential code/security review checked the native protocol/version headers, the active handler's real signal, the explicit deferred release and no weakening of the drain assertion.

## U13ao: Native socket resource and admission regressions

Replaced the legacy wire-protocol unit suite with native session/admission tests. Three tests require heartbeat output, buffer overflow closure, oversized frame refusal, rate-limit closure using valid native cancellation frames, timer cleanup, origin/protocol checks before ticket redemption, pending-redemption capacity and release after provider-upgrade refusal. Native integration tests retain ordered procedure results, cancellation, identity isolation, malformed binary frames, idle credential expiry and exact provider upgrade responses; the real TCP slow-reader scenario owns actual backpressure evidence.

Focused tests, test TypeScript, formatting and Oxlint pass. Sequential code/security review checked valid native frame use, no credential echo, no redemption on rejected origins/protocols and explicit stop/drain. Native keepalive is outbound whitespace; it does not implement the retired application ping/pong deadline. Real peer transport/cancellation and idle expiry tests remain. Outside Neon, native upgrade failure currently returns the same redacted 401 as failed admission; these tests require that existing behavior and verify capacity is released.

## U13ap: Native authentication declaration regression

Authentication declaration tests now exercise defineRpcAuth and its native configuration adapter. Both tests pass with real ES256 signing/JWKS verification: declarations capture immutable policy, forged lookalikes fail, omitted policy denies, malformed tokens fail, construction performs no fetch, later caller config mutation cannot change captured issuer/audience/origin, and invalid audience or tenant claims fail. Native authorization receives path/input/signal context and returns FORBIDDEN on denial.

Test TypeScript, formatting and Oxlint pass. Sequential code/security review checked deny-by-default behavior, immutable captured callbacks, lazy trusted JWKS configuration and unchanged token validation. Tests import the private adapter and its declaration factory from the same source module so the registration WeakSet is shared; assembled runtime and hosted suites independently exercise compiled exports.

## U13aq: Native builder and scheduler type parity

Replaced legacy builder/scheduler declarations with native procedure type tests for schema-bound tables and validators, relational filters/projections, required arguments, branded output IDs, derived insert schemas, scheduled wire inputs and cron inputs. Native visibility is resolved by the generated graph; rpc-capabilities tests require public/ambiguous targets to fail compilation. The native handler context test now also requires the exact schema table/validator references.

Removed obsolete function-preparation and builder-context fixtures after mapping their behavior to native contract transformations, invalid-output/serialization refusal, schema-context identity and PostgreSQL rpc-transactions. Legacy JSON stringification of Date/bigint is intentionally replaced by native value-preserving serialization. Thirteen focused tests, all test TypeScript (including expected type errors), formatting and Oxlint pass. Sequential code/security review checked no new casts, preserved branded output inference, wire input versus transformed handler input and database capability required for relational access.

## U13ar: Storage control-plane client parity

The remaining legacy client suite now targets the standalone storage client. Twelve control-plane/storage tests pass, retaining numeric/date Retry-After handling, bounded attempts and wait cancellation, stable captured upload intent/key on lost responses, token refresh, identity-change refusal, malformed envelopes, dishonest size headers, stalled response cancellation, application error/request IDs and local argument refusal. Test TypeScript, formatting and Oxlint pass.

Legacy automatic action/mutation and ticket methods are removed from this suite. Native rpc-retry and HTTP tests own explicit procedure retry semantics; native transport owns terminal authentication/version refusal and session lifetime. Sequential code/security review checked upload payload/key stability, no extra fetch after identity changes or invalid arguments, bounded body reads and preservation of public error codes without leaking provider payloads.

## U13as: Bound and cancel native ticket response reads

A new regression reproduced a transport leak: disposal rejected the procedure call but a stalled ticket-response stream remained open. Native ticket parsing now uses the existing bounded, abort-aware control-plane reader, with a 1 KiB limit and the same ten-second signal as the fetch. This bounds dishonest Content-Length and cancels body reads on deadline or session disposal before socket creation.

Seventeen focused native transport/control-plane/storage tests pass. New tests require actual stream cancellation and reject oversized, malformed and expired ticket bodies without creating a WebSocket. Core/browser/test TypeScript, build, formatting and Oxlint pass. Sequential code/security review checked shared-reader browser safety, byte counting rather than trusting headers, strict ticket validation, unchanged terminal refusal and no credential logging. This production browser change requires refreshed final packed/browser acceptance.

## U13at: Pin the actual historical client outside production exports

Local and hosted upgrade refusal tests now import a test-only bundle of the actual b8ddb6a client instead of the current core's legacy client export. The archive's transport/protocol/reference sources and package manifest were byte-checked against the pinned Git commit before bundling. The fixture README records reproduction, Bun version and SHA-256; the integration checks that hash before requiring terminal VERSION_MISMATCH without authentication or ticket issuance.

Nine native transport scenarios pass with zero skips, plus E2E TypeScript, formatting and Oxlint. Sequential code/security review checked the bundle contains only the historical browser client and validation dependency, no credentials, no production-package inclusion and no new fallback dispatch. The exact generated fixture is excluded from lint/format transforms to preserve its checksum; source rules remain enforced. Hosted upgrade will rerun with this fixture during final acceptance; this unit does not claim that rerun has happened.

The first fixture declaration used an unknown return and failed anti-slop lint. Its return now uses the historical JSON wire domain; the focused lint/type checks were rerun before amending this unit.

## U13au: Retire the obsolete opt-in cloud suite

Removed the legacy functions cloud suite and its synthetic-login browser, old capacity and old upload fixtures. Required native acceptance already owns those scenarios through Neon Auth, live load, services, storage and historical upgrade profiles. The shared frontend helper remains. Removed the obsolete Turbo environment toggle; README now documents the required suite runner, branch guard, fresh receipts and six serial CI profiles. The old operating-limits report is explicitly historical pending the final native report.

E2E TypeScript, focused runner lint and formatting pass. Sequential code/security review checked no remaining fixture imports, no deletion of actual native provider tests, mandatory missing-credential failure, unprotected owned-branch checks and no claim of GitHub-hosted execution.

All three frozen hot-table native runs are now complete (including the explicitly labelled second-run repeat). Upper-bound live p95 pairs in milliseconds: 1330.951→488.005, 1306.008→368.993, 1249.535→390.870. Warm finite p95 pairs: 573.912→350.433, 450.228→166.539, 192.047→333.812. The last finite pair regressed; spread finite median regression and the retained failed native startup remain unresolved. These frozen results predate subsequent runtime fixes and do not close U12.

## U13av: Remove the legacy runtime and public dispatch surface

Removed the legacy query/mutation/action builders, dispatcher/runtime, reference client, custom subscription/socket adapters, old Neon entry/application/HTTP bridge, auth declarations and durable wrapper adapters. Native procedures, oRPC HTTP/WebSocket, the shared revision coordinator and durable engines are the only executable framework path. The historical job-call validator remains for explicit migration; storage retains its separate protocol-1 control plane and shared retry reader. No old-client runtime is shipped merely to test upgrades.

The shared queue now validates its claim envelope directly instead of spreading a legacy claim schema; field validation is unchanged. Native worker types replace the last tooling reference. Relational integration now exercises native schema-bound database middleware, typed projections and rejection of mismatched relations before its handler.

Verification: all 189 unit tests across 46 files passed, all 13 workspace type/build tasks passed, and seven PostgreSQL scenarios across six files passed with zero skips (175 assertions). The adjusted relations assertion also passed separately after resolving a lint warning. Changed source formatting and Oxlint pass. Sequential code/security review checked all removed exports against remaining imports, retained historical envelope parsing and upgrade fencing, unchanged queue identity/lease validation, no fallback public dispatch, and no server imports in the browser barrel. A full packed/browser/hosted run remains required after this breaking removal.

## U13aw: Refresh native generation and clean-consumer verification

Advanced the runtime contract fingerprint to 17 after the runtime fixes and legacy removal so an existing generation cannot conceal changed framework behavior. The complete integration run executed 131 scenarios: 129 passed and two stale fixtures failed. The notification fixture now reconstructs metadata version 21 explicitly before applying both later migrations, preserving the complete historical receipt prefix. The packed docs fixture executes the native oRPC procedure with its Effect invocation context and typechecks its verification script as well as the documented examples. Both repaired scenarios pass separately.

The browser run passed five scenarios and failed packed schema loading. The copied consumer now excludes private .kello artifacts and canonicalizes its temporary root before importing packed packages. This prevents macOS /var and /private/var module identities from splitting the schema registry. The isolated packed browser scenario now passes, including clean install, build, typecheck and authenticated live CRUD. No runtime schema guard was weakened.

Sequential code/security review checked that the fixture downgrade touches only its disposable metadata namespace, packed verification uses the public native API and exact dependency pins, and copied consumers cannot inherit workspace runtime artifacts. All four changed source files pass formatting and Oxlint. Full post-fix integration/browser runs and final hosted measurements remain required.

## U13ax: Align operator limits with the native runtime

The operator page now documents current polling/notification behavior, shared listener ownership, reevaluation and socket bounds, Neon close-code mapping and the required cloud runner's target guard. It labels the former custom-protocol burst results as historical and leaves final native performance gates open. README now points its release-status claim at this active record.

Sequential code/security review compared defaults with runtime configuration, coordinator and socket-session source, checked provider close-code mapping and verified required-runner prerequisite failure and branch restrictions. Formatting passes. These documentation corrections do not claim new hosted acceptance. The complete local check now passes all 15 tasks (190 unit tests across 47 files), and the post-fix browser run passes all six scenarios with zero skips.

## U12 diagnostics: Attribute finite-RPC timing

The disposable live-load fixture now retains the last 64 finite procedure and database-acquisition durations. Its receipt reads those samples immediately after the existing 31 finite requests; that additional diagnostic request is excluded from the timed workload. Isolate identity is retained because provider routing prevents assuming that a separate HTTP request observes the same runtime. Empty or partial samples must not be presented as matched per-call attribution.

Sequential code/security review checked bounded memory, numeric operational labels only, no production exports or runtime changes, and unchanged timed workload. An executable fixture check published 100 metrics and verified retention of exactly samples 36 through 99, plus pool counters. E2E TypeScript, Oxlint and formatting pass. Hosted collection remains pending. Separately, the final-runtime native service acceptance passed on the owned storage branch in 70.34 seconds; receipt `/tmp/kello-final-services-1.json` records its target and release.

## U13ay: Bound the packed storage boot test explicitly

The full integration rerun overlapped local build/browser work. Its multi-bundle storage boot scenario exceeded Bun's implicit five-second timeout; Bun killed the shared esbuild service, causing ten downstream failures. This scenario now has an explicit 30-second test budget for building both provider entries and booting their configuration cases. Its behavior assertions are unchanged.

Sequential code/security review confirmed the timeout remains bounded and changes only test orchestration. Formatting and Oxlint pass. The complete PostgreSQL 18 suite then passed serially: 131 tests across 77 files, 1,072 assertions, zero failures and zero skips in 111.48 seconds. The failed concurrent-run log remains `/tmp/kello-final-integration-2.log`; the passing receipt is `/tmp/kello-final-integration-3.log`.

## U13az: Preserve absent HTTP input on Neon

Final hosted setup exposed a real no-input HTTP regression: the same metrics procedure returned 500 for omitted input and 200 for `{}` or `null`, while WebSocket metrics succeeded. The bounded HTTP reader rebuilt an empty provider stream as an empty string. Node adds `text/plain` to that Request; oRPC consequently decodes a Blob instead of absent input. Bun does not add that header, so the existing Bun-only check missed it. Reconstructing the request from URL/method/headers and omitting an empty body preserves the no-input contract while retaining bounded reads and expiry checks. The generation fingerprint advances to 18.

A real Node subprocess regression now asserts that an empty provider stream, both with and without Content-Length, reaches the handler as undefined. The failing Node reproduction returned 500 before the body omission; the corrected test passes. Thirteen focused HTTP/transport tests pass, including bounded and stalled bodies, expiry before dispatch, native errors and upgrade refusal. E2E TypeScript, Oxlint and formatting pass. Hosted Node 24 acceptance on the owned Tasks branch then passed: 100 subscriptions across two Functions, listener interruption/recovery, finite HTTP calls including omitted input, and drained resource assertions (`/tmp/kello-final-no-input-fix-2.json`, 87.45 seconds). This one-second measured workload is a regression smoke check, not the full timing gate. Earlier failed diagnostic receipts remain retained.

Sequential code/security review checked unchanged protocol/origin/auth admission, byte bounds and cancellation before dispatch, preserved request method/URL/headers, and no credentials in diagnostics. No caller workaround or new public endpoint was added.

The completed ce-code-review receipt is `/tmp/compound-engineering-501/ce-code-review/20260924-221629-23023239/review.json`, reviewing 3537a39 against main. It records the final hosted/performance gate as not ready. Local lenses ran sequentially under the user instruction; they are not independent corroboration. The external Claude peer timed out without a usable report; its owned job directory was removed. Independent validation was unavailable under that execution constraint. The caller continues the already-authorized acceptance work; the receipt is not a release approval. The final simplification pass found no additional behavior-preserving cleanup worth changing.

## U12 final functional acceptance at 903e0ec

The required cloud runner passed Tasks, jobs-storage, services and populated upgrade against actual Neon. Each profile ran three tests with zero failures or skips; upgrade also ran the pinned historical implementation first. The final PostgreSQL 18 integration suite passed 132 tests across 77 files, with 1,072 assertions. Full workspace checks remain green at 190 unit tests and 15 tasks. The versioned [functional receipt](evidence/orpc-neon-functional-2026-09-25.json) preserves release IDs, targets, test counts and verified branch removal.

Tasks exercised real Neon Auth and deployed Functions. Storage exercised signed bytes, object-created events, scheduled processing, retry success and terminal failure. Services exercised OpenAPI, Promise/Effect storage access, owner/auth/version/internal-route refusals and bounded slow-peer rejection. Upgrade preserved 100 tasks, resumed an interrupted release and migrated retained legacy work. These are local invocations of the required cloud runner, not a claim that GitHub Actions executed.

Failed attempts remain recorded: the temporary test helper chose new roles on provisioned branches, and the runtime preflight refused their missing application grants; preserving the existing restricted roles corrected setup. Subsequent trigger creation reached Neon's project quota (HTTP 422). Deleting completed owned acceptance branches freed quota; the profiles then passed without weakening runtime checks. The archived upgrade runner lacked Git history, so the same verified commit was tested from the checkout that contains its pinned predecessor.

Sequential code/security review compared receipts with logs, verified restricted-role refusal and provider quota evidence, checked that deletions named only owned disposable branches, and inspected the committed receipt for credentials and user payloads. This unit changes documentation/evidence only; no new behavioral test is needed. Final performance gates and temporary-key revocation remain open.

## AE4: Verify the combined rollback boundary

The final acceptance audit found separate coverage for output-validation rollback and transactional scheduling, but the invalid-output job test did not write application data in that same handler. It now updates the fixture counter, schedules work without awaiting it, and returns an invalid output. The test verifies that the counter, queued-job count and successful idempotency-receipt count remain unchanged. This exercises transaction cleanup and the scheduler's admitted-work drain together.

The focused PostgreSQL 18 test passed with 18 expectations, zero failures and zero skips in 348 ms (`/tmp/kello-final-atomic-output.log`). E2E TypeScript, Oxlint and formatting passed. Sequential code/security review checked that the failure occurs after the write and scheduling call, that receipt and job assertions observe the same metadata scope, and that no production behavior or privileges changed.

## AE8: Declare active-version compatibility before schema expansion

The hosted audit exposed a missing operator step. Redeploying an already-active version under a new release key applied the reviewed expansion but correctly refused to continue without its final function acknowledgement. Release recovery and retained-code restrictions remain intact. `kello migrations declare-compatibility --release <file>` now records a reviewed range for exact existing source, separately from applying DDL or deploying functions. `declareProjectCompatibility` supplies programmatic parity. Multiple retained versions can declare their ranges before migration application checks all dependencies.

The operation owns the deployment and migration locks, verifies generated source, exact artifact history, metadata ownership, consistent live catalog/history and the target-bound active grant, then uses the existing immutable-source/prefix compatibility guard. It does not read activation/runtime secret values, apply DDL, alter grants or create ingress claims. Tests reject changed source/history, an absent active deployment, an excluding schema range, clone mode, cancellation and the restricted runtime role. Repeated valid declarations leave schema history and activation state unchanged. CLI misuse and failures retain structured, redacted diagnostics.

The normal Tasks example passed actual Neon Auth and Functions acceptance after adding a nullable application column. The test first proves undeclared migration refusal, invokes the real compatibility CLI, applies through the project migration API, signs in to the old client against the expanded database, deploys the new version, writes another task and signs out/in. The [schema receipt](evidence/orpc-neon-schema-2026-09-25.json) records three passing cloud tests, zero failures/skips, release identities and verified disposable-branch removal. Alongside the already-passing populated interrupted-release test, this completes AE8's schema and recovery coverage.

Failed attempts are retained: the rejected redeployment approach above, followed by a browser fixture that incorrectly expected its in-memory UI session to survive navigation. Explicit Neon sign-in after reload fixed the latter. Neither attempt counts as passing acceptance. Both failed branches and the final successful branch were deleted and verified absent.

Verification: all 15 workspace tasks and 190 unit tests pass; focused PostgreSQL checks pass three tests with 143 assertions; the final full PostgreSQL 18 sweep passes 132 tests across 77 files, 1,088 assertions, zero failures/skips in 132.70 seconds (`/tmp/kello-final-integration-5.log`). Hosted Tasks passes three tests in 114.78 seconds. E2E TypeScript, Oxlint and formatting pass after the browser correction.

Sequential code/security review inspected target/source binding, metadata-owner enforcement, exclusive migration locking, cancellation and idempotent acknowledgement, strict CLI flags, unchanged release-recovery guards and secret-safe output. Application compatibility remains a reviewed declaration rather than inferred behavior. No open finding remains in this unit; the overall review's final performance gate remains pending.

The final compatibility delta also received the ce-simplify-code reuse, quality and efficiency passes, sequentially under the workspace instruction. No change was warranted: existing release parsing, deployment ownership, migration inspection and compatibility persistence are reused; CLI cancellation follows the existing command lifecycle. The schema acceptance helper is deliberately specific to the Tasks fixture. Applied simplifications: zero. The passing workspace and PostgreSQL checks above remain applicable because this pass changed no code.

Documentation review clarified the chronology of the development and deployment architecture notes and linked current operator guides. Sequential code/security review checked the links and preserved the remaining provider-retirement and abandoned-lock limits. Formatting and whitespace checks pass; these changes contain no executable behavior or credentials.

## U12/U13: Final acceptance and review resolution

All six final-runtime load runs passed: three spread and three hot-table workloads, each with 100 subscriptions across two actual Neon Functions and ten committed writes per second for ten minutes after warmup. Native live upper-bound p95 is 268.90–378.30 ms, improving 68.49–79.00% over the matched polling baseline. Every warm finite-RPC comparison improves; typecheck medians and browser/declaration sizes remain inside the 20% limits. The [consolidated acceptance record](orpc-acceptance.md) accounts for R1–R17 and AE1–AE8, with percentile distributions, commit identities, resource evidence, review limits and operational validation.

Heap samples show repeated collection drops within 21.96–56.13 MiB, without sustained growth in quarterly means or peak envelope. Per-isolate reevaluations, queues and pools remain bounded; subscriptions and listeners drain. Hot-table writer-side samples expose up to nine waiting writers during bursts even though slower database samples report none. The evidence retains this contention and the separation in time between baseline and final runs. No performance SLA or formal proof of leak absence is claimed.

Caller resolution closes the completed ce-code-review finding #1 using the final functional, schema and performance receipts; the original review artifact is unchanged. Sequential code/security review checked all six result sets, gate calculations, requirement trace, first-request versus cold-start wording, owned-resource deletion and credential-free receipts. No justified finding remains unresolved. Local required cloud runs are not represented as GitHub Actions execution.

All recorded owned acceptance branches were deleted and verified absent while retaining main. Account-level API-key revocation initially refused the organization-owned key; passing the verified project organization corrected the command. The temporary key was revoked and verified absent, and its temporary credential file was removed. The user's CLI authentication remains intact. Final delivery follows the ce-work shipping workflow.

Final delivery verification: `bun run check` passes all 15 tasks after the consolidated evidence and operator documentation updates (`/tmp/kello-final-delivery-check.log`). The substantive runtime and database tests above remain unchanged.

## Delivery CI: portable CLI integration assertions

The first push/PR CI runs (36094510851 and 36094530940) reported a successful migration receipt for `kello_test`, but the test required the local database name `postgres`. The assertion now compares the receipt against `current_database()` from the independently connected admin client. One run also exhausted Bun's five-second test deadline across thirteen sequential CLI launches. Those existing cases now run as individually named tests with isolated fixtures and the original per-test deadline; all exit-code, empty-stdout, error-code, credential-redaction and filesystem assertions remain.

Focused verification passes all 14 tests against a deliberately different local PostgreSQL database (`kello_ci_regression`), with 100 assertions and no skips. `bun run check` passes all 15 tasks. Sequential code/security review checked preservation of all thirteen cases, fixture cleanup, exact target validation and unchanged secret-redaction assertions. No runtime or provider behavior changed. The fresh hosted CI run is the verification of runner-specific timing; no timeout was raised and no security assertion was removed.
