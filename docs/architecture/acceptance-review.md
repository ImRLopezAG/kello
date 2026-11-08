# Framework acceptance review

Plan: `docs/plans/2026-09-22-1141-feat-kello-full-framework-plan.md`.

This index reconciles the implementation journal's historical partial entries with the final acceptance work. It distinguishes local implementation, disposable Neon acceptance and public publication. The journal remains chronological.

## Unit and requirement trace

| Unit | Requirements           | Implementation and executable verification                                                                                                                                                                                           |
| ---- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| U1   | R1-R3                  | Bun workspace, Turbo graph, runtime-specific TS 7 presets, Vite+ formatting/Oxlint, all generic and Effect anti-slop rules; frozen install and cache-restoration rehearsal.                                                          |
| U2   | R2, R5-R7, R15, R17    | Four Standard Schema vendors, native Relations v2, PostgreSQL 18 and Node 24 compatibility suites; pinned reviewed Drizzle rename patch and packed ESM/CJS consumer verification.                                                    |
| U3   | R4-R6, R9-R10          | Schema/compiler unit and type fixtures; `schema.test.ts` verifies database defaults, system-field immutability, constraints and references.                                                                                          |
| U4   | R7-R8                  | `validation.test.ts` and type fixtures verify transforms, asynchronous refinements, storage revalidation, write masks, public projection and patch omission.                                                                         |
| U5   | R6, R9, R18            | `relations.test.ts` verifies native relational filters, nested projection, self/multiple relations, junctions and snapshot reads.                                                                                                    |
| U6   | R12, R17, R23          | CLI/config/discovery/codegen checks; `cli.test.ts` verifies generated typed references, version changes, structured diagnostics and atomic generation.                                                                               |
| U7   | R10-R11, R14-R16       | Migration planner/runner/history/bootstrap tests verify committed-baseline diffs, populated explicit renames, live drift refusal, role separation and transactional revision triggers.                                               |
| U8   | R12-R15                | Dev coordinator/watcher/replacement/CLI tests verify autosync, destructive refusal, last-good generation, concurrent edits and clone quarantine.                                                                                     |
| U9   | R17-R18, R23           | Dispatch/transactions/evaluation/idempotency/HTTP tests verify read-only snapshots, rollback, whole-transaction retries, replay and action separation.                                                                               |
| U10  | R11, R20               | Authorization, remote JWT, tickets, activation and preflight suites verify issuer/audience/expiry, owner boundaries, single-use origin tickets and runtime credentials.                                                              |
| U11  | R17, R19-R20           | Client unit/type/browser tests and packed browser consumer verify transport, auth changes, cancellation, reconnect, query scoping and React lifecycle.                                                                               |
| U12  | R19-R20                | Revisions/evaluation/WebSocket suites verify direct SQL invalidation and snapshot consistency; two-process SIGKILL/reconnect and slow-reader tests cover process loss and backpressure.                                              |
| U13  | R18, R21               | Jobs/worker/crons suites verify transactional enqueue, competing claims, lease fencing, retries, cancellation, duplicate wakes and killed-worker recovery.                                                                           |
| U14  | R12, R16-R17, R21, R23 | Deployment plan/apply/provision/health suites and actual Neon release coordinator acceptance verify explicit targets, provider receipts, propagation and recovery.                                                                   |
| U15  | R20-R22                | Intent/event/provider/storage HTTP/cleanup suites plus actual Neon browser PUT, provider event and scheduled-worker acceptance verify ownership, reconciliation, retries and exact downloads.                                        |
| U16  | R14-R16, R21, R23      | Release preparation/database/activation, ingress, backfill and concurrent-index recovery suites verify mixed-version guards, partial deployment recovery and safe retirement.                                                        |
| U17  | R19, R21, R23-R24      | Runtime/deployment diagnostics, measured local and Neon workloads, actual local process kills, slow socket and simulated provider throttling; see operating-limits.md for measured successes, rejections and provider uncertainties. |
| U18  | R2, R24                | Astro/Fumadocs build, docs browser routes/search/navigation and maintained snippet compilation against packed exports.                                                                                                               |
| U19  | R1, R4-R24             | Both examples consume public exports; schema evolution replay, browser journeys, copied packed example and actual tasks/jobs-storage Neon acceptance.                                                                                |
| U20  | R3, R23-R24            | Clean-checkout rehearsal, cache restoration, packed Bun/Node/browser consumers, separated credentialed cloud workflow and deliberately disabled publication gate.                                                                    |

All units above are met within their stated verification scope. Requirement coverage follows the plan’s trace:

| Requirements | Verified units       | Status |
| ------------ | -------------------- | ------ |
| R1-R3        | U1, U18-U20          | Met    |
| R4-R6, R9    | U2-U3, U5            | Met    |
| R7-R8        | U4                   | Met    |
| R10-R11      | U7, U10              | Met    |
| R12-R13      | U6, U8, U14          | Met    |
| R14-R16      | U7-U8, U14, U16      | Met    |
| R17-R18      | U9, U11, U13         | Met    |
| R19-R20      | U10-U12, U17         | Met    |
| R21-R22      | U13-U16              | Met    |
| R23-R24      | U6, U9, U14, U17-U20 | Met    |

Core journeys F1-F5 map respectively to initialization/dev, dev/schema evolution, release recovery, live queries, and jobs/storage suites above. AE1-AE2 are exercised by schema and example-lifecycle tests; AE3 by populated rename; AE4 by transactional job rollback; AE5 by direct SQL and reconnect; AE6 by development/release clone quarantine; AE7 by release-boundary failures; AE8 by validator transforms and patch omission.

The public docs previously described only cloud database acceptance. The final review corrected that stale claim to include actual Functions and Object Storage acceptance and the measured limits.

## Review method and scope

The review compares initial commit `fa443b7` with the complete working tree. It uses ce-code-review's correctness, standards, testing, maintainability, security, performance, API-contract, migration, reliability, adversarial and frontend-lifecycle concerns. CLI parity is evaluated through the same structured commands and typed APIs available to scripts. No extra LLM integration is required by the plan.

All passes run sequentially in the primary context under the user's workspace tool mapping. There is no independent reviewer or external peer. Source inspection concentrates on schema/validation boundaries, transaction/dispatch behavior, authorization/tickets, subscription lifecycle, job leases, storage reconciliation, migration locks, release receipts and CI trust boundaries. Executable suites cover the wider implementation. This is not a claim that each of roughly 50,000 changed lines received independent line-by-line inspection.

The separate simplification pass checked reuse, quality and resource ownership in the new lifecycle/capacity fixtures. No behavior-preserving restructuring justified introducing a shared abstraction across these different transports.

## Operational validation for a later deployment

The deploying maintainer owns validation for the selected branch. Before traffic, inspect the release receipt, live health identity, migration history and runtime-role authority. During the first workload, observe `kello.runtime.metric` and `kello.deployment.metric`: dispatch errors, transaction retries, pool waiting, revision reads, job age and lost/recovered leases. Exercise authenticated reads/writes, two-user isolation, socket reconnect and one durable job through the application.

Use the explicit acceptance workload as the initial validation window, then set a sustained observation window for the application's actual traffic; no production traffic baseline exists yet. Stop rollout for owner-data exposure, schema/activation mismatch, unbounded resource growth or failed committed-write convergence. Pause new traffic and use the documented deployment recovery/retirement commands after inspecting durable state. Do not reverse applied DDL blindly. Burst rejection is a measured capacity limitation and must be accounted for before choosing production traffic levels.

Public registry namespace, license decision and publication credentials are still unsettled. The plan explicitly requires publication to remain disabled in this state. No Git remote is configured, so delivery is local; neither a hosted CI run nor registry publication is claimed.

## Final verification and review receipt

September 23, 2026, local time: all 15 workspace checks passed, including 167 unit tests, declaration/type checks, documentation build and Vite+ formatting/Oxlint. PostgreSQL 18 integration passed 111 tests across 67 files with 934 assertions in 131.35 seconds. All five browser tests passed in 23.68 seconds with database credentials supplied; an earlier credential-free browser invocation correctly skipped three database scenarios and is not counted as their acceptance.

Actual Neon tasks acceptance passed all three cloud tests, including the final capacity characterization. At 1/4/8 writers, 3/3, 11/12 and 19/24 writes succeeded and reached every subscribed browser. All six rejections were bounded transaction conflicts and left no rows. Unknown server failures still fail the benchmark. Temporary branch absence and API-key revocation were verified. The earlier jobs-storage cloud acceptance remains recorded separately in operating-limits.md.

The review identified and resolved missing Turbo forwarding of the capacity flag, stale cloud documentation, and generic errors for exhausted transaction conflicts. The conflict fix preserves retry budgets, returns HTTP 409 with a fixed public code, and has real PostgreSQL redaction/retry coverage. Sequential reuse, quality and efficiency simplification passes found no additional justified changes (0 applied, 0 deferred).

Code review: **complete**. Verdict: **Ready to merge**, meaning ready for local delivery within the documented operating limits. Actionable findings: **none**. [Durable review receipt](evidence/framework-review-2026-09-23.json), run `20260923-201403-6de1175f`. All review lenses ran inline under the user's tool mapping; no independent peer is claimed. Log scans found no credential-pattern matches in the captured validation outputs; this does not certify arbitrary application logging.

All U1-U20 verification outcomes and R1-R24 are accounted for above. Public publication and a production deployment remain separate, intentionally unperformed operations. TanStack integration is [research](tanstack-client-research.md), outside the initial plan's automatic-optimism boundary.
