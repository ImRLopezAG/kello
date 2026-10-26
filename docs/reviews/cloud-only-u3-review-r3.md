# U3 affected source review — R3

**Verdict: REVISE — one P2 finding.** The actual apply polling/observation cancellation defect R2-F1 is corrected. One affected activation transaction path still turns failed rollback into clean cancellation. This is bounded SOURCE correctness/API/security/lifecycle review, not exhaustive U3 or provider clearance.

## Authority and intent

Canonical checkout: `/Users/angel/.t3/worktrees/loom/release-kello-001-002-alpha`. Opening and closing branch: `refactor/neon-cloud-tooling`. Opening and closing HEAD: `623a764820e972aa896dd12d1d88586ef95b384c`.

The intended contract is local author watching/codegen/build with ordinary explicit Neon preview releases, pinned target/version, serialized and coalesced cancellation, last-good retention, and no local backend/jobs/database. Natural `.live()` through the official SDK and ordinary HTTP async streams remain the product contract. This correction does not authorize redesigning those surfaces.

Read the full root `/Users/angel/dev/loom/AGENTS.md`, plan `docs/plans/2026-10-16-1919-refactor-neon-cloud-only-plan.md`, full R1 and R2 reports, current checklist `docs/tasks/cloud-only-current.md` including its latest cancellation response, and both freeze manifests. Truncated combined reads were recovered for required bodies. The explicit single-review/no-delegation/one-output scope governs this run; no full multi-agent shipping workflow or extra artifacts were created.

## R3-F1 — P2: activation's outer transaction suppresses failed rollback after cancellation

**Changed location:** `apps/kello-cli/src/tooling/deploy/neon/activation.ts:174–176` (`rethrowSignalCancellation`). **Actual caller:** `apps/kello-cli/src/tooling/deploy/neon/release.ts:142`. **Cleanup boundary:** `apps/kello-cli/src/tooling/migrations/procedure-upgrade.ts:178–192`, especially line 191.

**Trigger:** a development revision is stopped or superseded while `activateGrant` awaits `requireQuarantineCompleted` inside the real `withProcedureUpgrade` transaction. The query finishes successfully, the check at activation line 166 throws the caller cancellation reason, and the new catch preserves that reason. The enclosing procedure-upgrade owner then attempts `ROLLBACK`, but rollback rejects with a distinct error (including a falsey rejection).

**Failure path:** `withProcedureUpgrade` explicitly suppresses that rejection with `.catch(() => {})` and rethrows the original cancellation. Trigger activation now also preserves it. Once release cleanup returns that reason, the coordinator classifies the revision as expected cancellation and does not populate `drained`; `stop()` can resolve, including after a successful successor. The procedure-upgrade transaction had already locked tables and inserted its release declaration, and may have transferred jobs, before invoking activation. This is an actual transaction cleanup boundary, not an irrelevant catch outside the release path.

Before this correction, activation replaced cancellation with a distinct safe error, which the coordinator retained. Preserving cancellation at the changed site exposes the existing rollback suppression as a clean-stop regression. The analogous fix in `prepareGrant` is correct but does not cover this separate outer transaction. A later connection close may terminate the transaction; it does not make the failed rollback observable, and this finding does not claim committed corruption.

**Minimum correction:** preserve expected cancellation through activation only after its owning procedure-upgrade transaction drains successfully. If rollback fails while handling expected caller cancellation, propagate a distinct safe error so the coordinator retains it. Preserve precedence of a genuine primary error and do not expose raw database messages. Avoid suppressing distinct errors solely because the signal is aborted.

**Missing causal regression:** join actual `withProcedureUpgrade`, activation and coordinator source with query/provider boundaries mocked. Abort while activation's quarantine query is pending, let that query finish, then reject rollback. Verify stop rejects with a safe non-cancellation error; cover a successful successor followed by stop, a falsey rollback rejection, and the successful-rollback clean-stop control. Current `deployment-cancellation.test.ts` exercises `prepareGrant` rollback only. This finding is established by source tracing; no reviewer reproduction was executed.

## Correction adjudication

- **R2-F1 apply cancellation: resolved in reviewed source.** `readWithSignal` rejects with the supplied signal reason. Apply's catch compares against the original caller signal, so both direct abort checks and timer `AbortError` with matching cause reach the coordinator as expected cancellation. The real apply/coordinator cases cover polling, pending observation, supersession followed by successful completion, and a distinct finalizer rejection.
- **Identity versus genuine errors:** the helper requires an aborted signal plus exact reason identity, or an `Error` named `AbortError` whose cause is that exact reason. Arbitrary errors and falsey values distinct from that reason continue through redaction. The coordinator wraps falsey failures rather than testing their truthiness. Successful successors clear current failure, not retained drain failure. This is source reasoning, not a runtime test of every identity combination.
- **Timeout separation:** apply and health use composed wait signals but classify against the caller signal. An internal deadline reason remains a deployment/health failure, including when a different caller reason arrives later. A read-only observation race may abandon a pending read; it does not cancel the underlying provider request or prove physical transport shutdown. Mutations are not raced this way.
- **Late accepted mutations and receipts:** apply awaits an already-started provider deployment, records its acknowledged ID and submitted state, and writes the receipt before observing cancellation in polling. Receipt-write failures remain distinct safe failures. The supplied fixture covers a late acknowledgement, lock exclusion and resume without reupload. Trigger activation also awaits started writes and relies on provider-state reconciliation for partial progress.
- **Preparation rollback:** `prepareGrant` awaits rollback before preserving cancellation and emits a safe error if rollback fails. Its correction is sound within that function. R3-F1 concerns the different transaction owner around activation.
- **Security/API:** ordinary provider failures still lose raw provider causes at the changed redaction boundaries. The deliberately preserved value is the caller's own cancellation reason. No credential leak or additional API break was established in this affected pass. Internal helper addition does not change successful release return shapes.
- **Earlier F1/F2:** R2's target-binding and publication-event resolutions remain applicable; every original R2 manifest entry still matches. I reread the development/project/connection/release propagation and watcher/publication callers, but do not claim a new complete review of all earlier authority tests or deleted modules. The preexisting U5 bundler hunk in apply was observed and neither adopted nor modified.

## Exact reading coverage

All ten current bodies in `/tmp/kello-u3-review-r3-freeze.json` were read in full:

- `apps/kello-cli/src/tooling/deploy/neon/observe.ts`
- `apps/kello-cli/src/tooling/deploy/neon/apply.ts`
- `apps/kello-cli/src/tooling/deploy/neon/health.ts`
- `apps/kello-cli/src/tooling/deploy/neon/activation.ts`
- `apps/kello-cli/src/tooling/deploy/neon/triggers.ts`
- `apps/kello-cli/src/tooling/dev/coordinator.ts`
- `packages/tests/unit/deployment-cancellation.test.ts`
- `packages/tests/unit/neon-trigger-deployment.test.ts`
- `packages/tests/unit/dev-coordinator.test.ts`
- `packages/e2e/integration/deployment-apply.test.ts`

Additional full current bodies read: Neon `release.ts`, `project.ts`, `receipt.ts`, `prepare-release.ts`, `connection.ts`, `release-database.ts`, `publish-client.ts`; development `development.ts`, `watcher.ts`; `commands/dev.ts`; migration `procedure-upgrade.ts` and `connection.ts`. Current-versus-HEAD correction diffs were inspected for observe/apply/health/activation/triggers, including identification of the separate bundler hunk.

This is not full rereading of the 60-path R2 scope, all transitive callees, historical deleted bodies, official SDK implementation, live-query/HTTP runtime, bundler internals or the whole release journal. Earlier report coverage belongs to those reports. No provider/database/transport concurrency schedule or full release acceptance is certified.

## Parent-attributed evidence and limits

Read the supplied logs without executing checks:

- `/tmp/kello-u3-cancellation-red.log`: actual apply/coordinator selection, three failing cancellation cases and one passing cleanup-failure control. The final apply log includes all four passing.
- `/tmp/kello-u3-cancellation-boundaries-red.log`: three failures and fourteen passes. Its preparation failure displays an undefined expected reason; the current test uses a captured cancellation object and explicit query mock implementations. Do not treat that older assertion form as unchanged final proof.
- `/tmp/kello-u3-cancellation-unit-final.log`: 25 passing tests across three files.
- `/tmp/kello-u3-apply-final.log`: 12 passing tests, zero failures, including actual source apply/coordinator, temporary artifacts, archive/bundle generation and mocked provider boundaries. It does not execute the complete deployment pipeline against Neon.
- `/tmp/kello-u3-{app,tests,e2e}-types-final.log` and `/tmp/kello-u3-correction-lint-final.log`: inspected; exit-zero status is parent-reported, not independently inferred from terse command-only logs.

The parent discloses the final async/await test annotation change after the last runtime 12-green run, followed by type/lint exit zero. I inspected the current body but did not rerun it or claim exact-current-hash runtime evidence. Earlier test typing errors were corrected; all reported execution remains parent-attributed. The greens do not cover R3-F1's actual outer activation rollback path.

No delegates, production edits, test/build/install execution, network/provider/database access or commits occurred. The sole write is this report. Shared dirty work was preserved.

## Opening and closing identity

All ten R3 SHA-256 pins matched at opening and closing, with zero drift. The R3 manifest SHA-256 remained `e44b999c1d1522dfeeed2f560de9fe1b128f016e73174c85cd3cdf0836ba3175`.

The original R2 manifest was checked twice during this review: all 60 entries matched (38 file hashes and 22 absences). Its SHA-256 is `c8d85686cc37f7c83d69bab7f18b4e4d8027ea3cf9b8d50ffdbcc45c46227ebf`. These are identity checks, not additional body-reading coverage. Corrected files are governed by R3 pins; no obsolete hash was demanded for them.

R1 report SHA-256: `781131f58b42e16f9e054b64ca3c3cd9ac822e9236bb627e9d864ab709724e65`.
R2 report SHA-256: `40054d09a17f05069a2a739377b620e3453ff673256b85b688fa7aec87c1b448`.
Supporting procedure-upgrade SHA-256: `39b6d736263d8113d1228956a3e27e4a496276d8c866d0e5b1a6b47e3bb32809`.
Supporting migration connection SHA-256: `4b73d5fbf1326415b324521284b64adbdb97d38d6848b2a68c49b425527a9224`.

Opening/closing R3 body hashes:

```text
cc3cf716ced2e1d83a246ab69f81ca5f096f0baf04241a8e889582101ac52559  apps/kello-cli/src/tooling/deploy/neon/observe.ts
38b6efc70c0453d04c6f54a2982c9e807215e25d2f984f2b35caa9109073c470  apps/kello-cli/src/tooling/deploy/neon/apply.ts
d5b30753c5beb1da598246792fd4e318432ea62d4bd661ce92043571982d1ca6  apps/kello-cli/src/tooling/deploy/neon/health.ts
f0083961b271a44cbef827404fc0e89ed3b68474a33d5ea88e40bc17e2bb1d0c  apps/kello-cli/src/tooling/deploy/neon/activation.ts
11e852917d6f6630fe3b4b06b6cc672be0f46b47f7b7b9b1a7920a402e8abac5  apps/kello-cli/src/tooling/deploy/neon/triggers.ts
e0fed59cb204d514976cf161e418fcf3503d785d3e901449771f9b539f66f452  apps/kello-cli/src/tooling/dev/coordinator.ts
327db930ffc5ad94ee31a1675d2c989a53539200f58034dca9730ac5da00d735  packages/tests/unit/deployment-cancellation.test.ts
819388b9c6564f169c779e41ea40a29d8271f5ac0128318bd8f1765f3c590e9b  packages/tests/unit/neon-trigger-deployment.test.ts
0ee16fc3c25941f534deab6f513738e53df4702f5b5561e642cb4ac65d80b3ef  packages/tests/unit/dev-coordinator.test.ts
18036a518ade46c14f814a6fca2c83261db9ee29261872c2938dbc85f3440362  packages/e2e/integration/deployment-apply.test.ts
```

Terminal review state: **REVISE (1 P2), source only**.
