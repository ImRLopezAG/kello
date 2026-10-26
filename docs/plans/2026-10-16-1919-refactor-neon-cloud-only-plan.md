---
title: Neon cloud-only runtime and live queries - Plan
type: refactor
date: 2026-10-16
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# Neon cloud-only runtime and live queries - Plan

## Goal Capsule

**Objective:** Developers can build, preview, and deploy Kello applications against Neon cloud, with live data updates and a smaller package that supports one backend execution model.

**Means:** Keep the declared live-function API, use Neon's Realtime engine, replace the local backend with cloud preview deployments, and delete the legacy revision subscription engine.

**Scope:** Current `refactor/neon-cloud-tooling` checkout, starting at `b54d0ed`. Preserve the existing uncommitted Vite+ bundling and local job/cron removal work. This document is a plan, not evidence that the migration has run.

## Product Contract

### Summary

Kello functions execute in Neon Functions. Ordinary calls use HTTPS. Declared live functions authorize and seal typed Drizzle SELECTs; the frontend subscribes through the official Neon SDK. Neon exclusively owns live-query delivery. User-authored async iterators remain ordinary HTTP streaming procedures and do not acquire live-query semantics. Kello does not host a local backend or maintain a second live-query engine.

Developers still edit files, generate types, build bundles, and run a frontend locally. These authoring tools connect to a selected Neon preview branch; they do not execute Kello application handlers locally.

### Problem Frame

The current package maintains overlapping mechanisms: localhost HTTP/WS runtime generations, PostgreSQL revision tables and triggers, polling/LISTEN invalidation, snapshot reevaluation, and official Neon live queries. Generated browser clients still create the older WS transport even when Neon live functions are present. Removing only `LISTEN` would leave its polling fallback and consumers alive.

The replacement already exists in `core/server/realtime/{neon,procedure}.ts`, `core/client/realtime.ts`, and the generated `.live()` function contract. This work finishes that integration and removes the superseded paths; it does not build another abstraction over subscriptions.

### Requirements

#### Backend and authoring

- **R1:** Neon cloud is the supported application backend. Remove local handler serving, local backend WS listeners, local job/cron execution, and localhost database fallback. Delete obsolete configuration fields and public APIs outright; backward compatibility is not required for this alpha.
- **R2:** `kello dev` watches author files and deploys to an explicitly selected, unprotected cloud development/preview target using the existing deployment pipeline. It prints the remote service URL, preserves the last successful deployment on build failure, and never targets production by inference.
- **R3:** Add `kello realtime status` and `kello realtime enable` for the resolved project/branch. Status is read-only. Enable is explicit and idempotent, distinguishes pending from ready, and never reports success before readiness. Existing provisioning handles missing compute; enabling does not silently create a new project or compute.

#### Live data and correctness

- **R4:** Keep `.live()` as the explicit declaration on the function contract in the functions folder, with inferred generated client/React APIs, input validation, explicit typed Drizzle projections, and supported pagination. Its implementation issues an authorized Neon live query through ordinary HTTP; the official Neon SDK owns live delivery and renewal scheduling. Do not route `.live()` through Kello WebSocket/ticket transport, legacy async-iterator wrappers, revision tracking, or handler reevaluation. No arbitrary handler is automatically converted into a live SQL query.
- **R5:** Live queries preserve trusted identity/session ownership, expiry, renewal authorization, SQL permission predicates, and live membership revocation. Preserve committed transaction/replay receipts and `confirmed` versus `unknown` semantics. Realtime unavailability must not silently select polling.
- **R6:** Ordinary procedures continue to work through HTTPS, including user-authored async iterators as ordinary streaming responses. Iteration does not opt a procedure into subscription reevaluation, revision tracking, or transaction-progress confirmation. Preserve migrations, transactions, cloud jobs/crons, storage, ranked search reads and encrypted cursors, error handling, deadlines, and observability that serve these features.
- **R7:** Remove the legacy revision coordinator, polling/LISTEN subscriptions, dependency capture, snapshot reevaluation, live-specific iterator wrappers, custom application WebSocket/ticket transport, and their generated/watch APIs. Update first-party consumers in the same change. Remove only application-owned revision schema objects through a forward migration; preserve user data and immutable applied migration history.

#### Package and release

- **R8:** Remove obsolete runtime exports, configuration, tests, examples, and documentation. Finish the existing Vite+/Rolldown tooling change; retain `fflate` for deployment ZIPs. Remove dependencies only after checking their remaining cloud consumers. Record actual packed size and dependency changes, without inventing a percentage target.
- **R9:** Run behavioral tests as integration tests in CI, including actual Neon acceptance. CD consumes verified artifacts and publishes; it does not repeat the tests. This planning run launches no tests, services, or provider mutations.

### Scope Boundaries

This is an intentionally breaking alpha release. Existing APIs, exports, configuration, generated clients, and examples may change or be removed to establish the cloud-only contract. Do not add deprecated aliases, compatibility shims, dual transports, fallback modes, or staged API deprecation solely to preserve the previous alpha. Update first-party consumers together and document the new contract.

Breaking API compatibility does not permit weakening authorization, transaction correctness, cleanup, or data integrity. Preserve application data and applied migration history. The user confirms no installed users or deployed consumers require the old alpha behavior, so there is no old-deployment inventory, drain gate, compatibility release, or post-cutover maintenance workflow.

No local/offline backend mode, self-hosted PostgreSQL mode, automatic opaque-query provenance, new subscription registry, custom reconnect engine, or new process-supervision framework will be added. Existing historical evidence remains history, not an extra runtime dependency.

Local frontend preview, code generation, file watching, credential login, packaging, and migrations against Neon remain supported author tools. The official SDK's own WebSocket connection remains; removing Kello's application WS server does not mean Neon uses no WebSockets.

## Planning Contract

### Key Technical Decisions

- **KTD1 — One cloud backend.** Choose cloud preview over parallel local and cloud execution because maintaining both is the problem the user is removing. This accepts network dependence and provider latency during development. Do not reintroduce a local fallback when Neon is unavailable.
- **KTD2 — Preserve `.live()` authoring; replace its legacy execution path.** `.live()` remains the explicit function-contract API and generates the natural typed client/React surface. Wire it directly to authorized Neon issuance/renewal over HTTP and official SDK delivery, without Kello WS/tickets or the old live-iterator and reevaluation machinery. Keep typed Drizzle query builders and runtime output validation; do not expose a raw-SQL-first public API or promise unsupported decoder mappings.
- **KTD3 — Separate ordinary RPC from live delivery.** Generated clients use the existing HTTP transport for ordinary calls and issuance/renewal. Live rows arrive through the official SDK. Preserve user-authored async iterators through ordinary HTTP streaming, including normal cancellation and cleanup. Remove only their legacy live-query instrumentation and reevaluation wrappers. Delete the custom ticket/WS transport and update its first-party callers in the same change.
- **KTD4 — Explicit branch-scoped enablement.** Reuse profile credentials, target resolution, and the official Neon API/SDK. Persist the public Realtime URL with the selected target. Obtain signing secrets through the existing protected deployment-secret channel; never emit them in config, generated browser files, JSON status, or logs.
- **KTD5 — Break the alpha API cleanly; retire schema safely.** Update first-party live functions and cloud preview alongside removal of legacy runtime code, without a compatibility release or dual-engine transition. Remove owned revision-schema objects directly through the forward metadata migration; no deployment-drain prerequisite or legacy-runtime compatibility is required for this unused alpha. Do not rewrite previously applied bootstrap SQL or checksums.
- **KTD6 — Keep dependencies with real cloud work.** `pg` still connects to Neon for migrations/transactions; `libpg-query` still analyzes migrations; `fflate` builds deployment archives. Vite+ is author tooling and must not enter the deployed function runtime. The bundled Neon CLI currently supplies login/link behavior and can retain transitive esbuild/NFT even after direct removal; measure that separately rather than breaking authentication to claim zero transitive copies.

### Source Grounding

- Local serving: `apps/kello-cli/src/tooling/dev/{development,server,server-generation,runtime,project}.ts` and `src/commands/dev.ts`.
- Legacy engine: `apps/kello/src/core/server/rpc-runtime.ts`, `realtime/{coordinator,notifications,revisions,dependencies}.ts`, `rpc/{live-context,live-dependencies,snapshot,snapshot-stream,runtime-graph,database}.ts`, and `core/search/executor.ts`.
- Revision DDL and baselines: `apps/kello-cli/src/tooling/migrations/{bootstrap,revisions,branch-baseline}.ts`.
- Public target and client generation: `apps/kello-cli/src/tooling/config/{define-config,resolve,development}.ts`, `tooling/codegen/application.ts`.
- Existing deployment: `apps/kello-cli/src/tooling/deploy/neon/{plan-release,prepare-release,release,apply,bundle}.ts` and `commands/deploy.ts`.
- Official [Realtime overview](https://neon.com/docs/realtime/overview), checked 2026-10-16: enablement is per branch, queries must be read-only/deterministic, and Realtime does not currently support RLS. Therefore authorization must remain in issued SQL; transaction-local identity settings cannot replace it.

## Implementation Units

### U1 — CLI enablement and target configuration

**Delivers:** R3, R5. **Dependencies:** none.

**Files:** `apps/kello-cli/src/cli.ts`; new `src/commands/realtime.ts`; `src/tooling/neon/api.ts`; `src/tooling/config/resolve.ts`; project discovery and existing deployment environment/secret preparation; generated public config types.

**Approach:** Add status/enable using the installed official SDK signatures. Bind project, branch, database, and public URL consistently. Validate explicit overrides against the selected target. Enable reports disabled/pending/ready or a fixed actionable provider error. A bounded wait that expires reports pending, not ready. Configure allowed frontend origins explicitly; never add a wildcard to fix a browser failure. Reuse protected credential storage and secret injection. Reject protected/default targets where the existing mutation policy requires explicit authorization. Realtime readiness is required for applications declaring live functions; ordinary HTTP-only applications remain deployable without it.

**CI integration scenarios:** Extend `packages/e2e/integration/cli.test.ts` and `onboarding.test.ts`, add `realtime-cli.test.ts`: read-only status makes no writes; enable is idempotent; target conflicts, provider denial, missing compute, pending timeout, and secret canaries. Actual disposable-branch enablement/discovery is covered in U6.

### U2 — Make generated functions Neon-native end to end

**Delivers:** R4–R6. **Dependencies:** U1.

**Files:** `apps/kello-cli/src/tooling/codegen/application.ts`; `core/server/application/definition.ts`; current `core/server/realtime/{neon,procedure}.ts`, `core/client/realtime.ts`, `core/react/realtime.ts` only where needed; `packages/examples/{tasks,components,integrations,next,jobs-storage}` contracts/functions/consumers.

**Approach:** Preserve `.live()` on function contracts and its inferred generated client/React API. Generate one HTTP client for ordinary RPC and `.live()` issuance/renewal, plus the official Neon live client when declarations require it. Remove any dependency of `.live()` on Kello WS/tickets, legacy iterator wrappers, and revision/snapshot reevaluation. Use discovered Realtime configuration. Convert app-owned `context.live` and generated watch consumers into declared deterministic SELECTs with explicit SQL access predicates. Keep function-folder contracts, input validation, stable ordering, supported page inputs, and trusted HTTP login/session resolution. New page/input/identity means a new bound subscription; dispose the old one. Multi-query/nested search handlers that cannot be represented safely remain ordinary explicit reads, with their unsupported live API removed and documented—no covert polling replacement.

**CI integration scenarios:** Extend `live-functions-codegen.test.ts`, `deployed-client.test.ts`, and public example coverage: ordinary calls use HTTP; generated `.live()` has inferred input/rows; validation and pagination work; missing Realtime config fails clearly; auth switch/logout disposes old rows and pending confirmation; bundle contains no signing secret. Generated ordinary async-iterator procedures retain their streaming contract without a WebSocket client, revision tracking, automatic reevaluation, or Neon subscription. Preserve the existing expiry/replay/unknown regressions.

### U3 — Replace the local backend with cloud preview development

**Delivers:** R1, R2, R6. **Dependencies:** U1, U2.

**Files:** `apps/kello-cli/src/commands/dev.ts`; `tooling/dev/{development,project,watcher,coordinator}.ts`; existing deployment release functions; config validators and CLI help. Remove local-only `server.ts`, `server-generation.ts`, `runtime.ts`, and local quarantine helpers after checking callers.

**Approach:** Retain file watching/debounce and reuse the existing deployment plan/apply path. Serialize deployments, coalesce saves while one runs, and generate clients from the successful remote target. Reuse one configured preview target; do not provision per save. A failed build leaves the last remote release usable. Stop watching on cancellation and settle an already-started deployment through existing release cleanup/receipts; do not tear down the shared preview branch on Ctrl-C. Remove port/maxConnections/local-serving options and local diagnostics attachment. Keep deployment and cloud runtime diagnostics.

**CI integration scenarios:** Rewrite `dev-cli.test.ts`, `dev.test.ts`, and `cloud/dev-component-watch.test.ts` around remote preview: save deploys once, subsequent save updates the same target, invalid source preserves last good release, protected target is refused, cancellation leaves no pending CLI work, and no local backend server is opened. Keep watcher tests that test file watching rather than removed handler hosting.

### U4 — Delete the legacy live engine and migrate its database objects

**Delivers:** R6, R7. **Dependencies:** U2, U3.

**Files:** Legacy engine and migration paths listed in Source Grounding; server/client export indices; `apps/kello/src/core/server/config.ts`; application definition/runtime graph; old WS/ticket adapters and generated search watch surfaces whose callers are now gone; notify-mode validation in `apps/kello-cli/src/tooling/deploy/neon/prepare-release.ts`.

**Approach:** Remove coordinator construction, revision reads, LISTEN connections, dependency instrumentation, snapshot reevaluation, and polling/notify configuration, including the old direct-connection requirement during release preparation. Preserve ordinary transaction middleware, commit/replay behavior, cloud queue wakeups, and user-authored async iterators as ordinary HTTP streaming. Delete live-specific iterator wrappers without removing ordinary streaming cancellation, error propagation, or iterator finalization. Remove revision trigger installation and baseline assumptions in current migration generation. Add a forward metadata migration that validates and removes only Kello's revision triggers/function/table for the selected namespace. Apply this cleanup in the normal migration path. Do not add deployment inventory, drain detection, or a separate retirement command; no old deployment compatibility is required. Preserve historical bootstrap bodies, application rows, unrelated triggers, and cloud jobs. Document the breaking removal; the old engine is no longer supported.

**CI integration scenarios:** Add `packages/e2e/integration/realtime-revision-retirement.test.ts`: upgrade from the existing metadata schema, repeat upgrade safely, ordinary writes/migrations/jobs still work, unrelated triggers/tables survive, fresh baseline/branch creation works, and ordinary async-iterator procedures still stream, cancel, and finalize without starting live-query tracking. Source/import checks prove no supported path starts revision polling or LISTEN. Delete obsolete local/legacy-only tests; retain their security/data invariants in replacement integration cases.

### U5 — Prune the published package and update the supported contract

**Delivers:** R1, R7, R8. **Dependencies:** U3, U4.

**Files:** `apps/kello/package.json`, build configuration, `scripts/third-party.ts`, `bun.lock`, package exports/README; docs authoring subscriptions/configuration/jobs and operations development; examples and obsolete test fixtures.

**Approach:** Finish Vite+ packaging without exposing it as a deployed runtime import. Remove orphan dependencies/exports and stop shipping local-only modules. Keep the smallest existing credential/link path; replace any official CLI dependency only if the same task demonstrates equivalent authentication/profile behavior without private API guesses. Report remaining transitive bundlers honestly. Publish migration guidance for removed `context.live`, notify/polling modes, WS clients, and local dev options. Remove obsolete APIs and configuration instead of preserving aliases or compatibility switches. Migration guidance explains the new alpha contract; it does not require an automated compatibility layer.

**CI integration scenarios:** Extend `neon-bundle.test.ts`, packed-consumer and example lifecycle coverage: install/pack/generate/build/deploy works from public exports; browser/server bundles exclude private credentials and removed backend modules; optional author tooling is absent from deployed functions. Compare packed bytes, file count, and production dependency closure to the pre-change baseline. No arbitrary savings target or false claim that all SQL/PostgreSQL libraries are removable.

### U6 — Verify the actual cloud path and release once

**Delivers:** R1–R9. **Dependencies:** U1–U5.

**Files:** `packages/e2e/fixtures/live-functions-neon.{ts,tsx}`, cloud integration suites, generated/packed browser fixtures, existing CI and publish workflows.

**Approach:** Use a disposable Neon target for end-to-end enablement, deployment, generated client, and browser checks. Reuse current actual-provider live-query proof cases instead of rebuilding an acceptance framework. CI runs the relevant integration suites; CD only packages/publishes the verified revision. Keep secrets in existing CI secret channels and clean only resources acquired by the test. Capture exact revision, result, and cleanup in the normal job output.

**Required scenarios:** External writer updates; commit/rollback/retry/replay and both delivery/response orders; filtered/no-op transaction progress; concurrent receipt confirmation; tenant/membership revocation; expiry/renewal/logout/disposal; pagination ordering; ordinary procedure and cloud job/storage regression; generated public consumer and mounted browser. Confirm the supported application opens no local backend listener or local DB connection. Local browser/relay fixtures in CI are test instruments, not shipped backend support.

## Verification Contract

The implementation request authorizes focused local behavioral tests after each phase, alongside build, typecheck, format, lint, and import/dependency inspection. Test and review each phase before committing it. Run the integration cases in CI for final acceptance; CD does not repeat tests. Do not add a new long-running supervisor harness.

Require green current-revision integration CI plus the U6 real Neon/browser path before publish. Test evidence from the earlier alpha remains useful context, not acceptance for deleted/replaced runtime paths. Report package-size measurements and any remaining transitive tooling rather than estimating savings.

## Definition of Done

- U1–U6 deliver R1–R9, with current-revision CI and real cloud/browser results.
- Breaking alpha APIs/configuration are updated consistently across exports, generation, examples, and docs; no legacy compatibility shims or fallback engine remain.
- CLI can explicitly enable and report Realtime for its selected branch without exposing secrets.
- Generated functions, examples, and React clients use HTTPS plus Neon live delivery and retain authorization/confirmation semantics.
- `kello dev` uses cloud preview; local backend modules and legacy revision subscriptions are absent from supported exports and the packed runtime.
- Legacy live iterators and custom WS/ticket transport are deleted; Neon is the only live-query engine.
- Forward schema cleanup runs in the normal migration path and removes only owned revision objects while preserving applied history and unrelated data; no old-deployment drain gate remains. User-authored async iterators retain ordinary streaming behavior without legacy live-query semantics.
- Packed output/dependency comparison is recorded, supported limitations and alpha migration instructions are updated, and only then is the next alpha prepared. Never overwrite the published alpha version.

## Execution Handoff

Implement in U1 → U2 → U3 → U4 → U5 → U6 order, with one working checklist and direct implementation. Preserve concurrent WIP and the existing bundler changes. No extra coordinator, compatibility engine, review packet hierarchy, or provider mutation during planning. No unresolved product decision prevents starting U1; actual cloud execution uses the selected disposable target and the existing credential/provisioning flow.
