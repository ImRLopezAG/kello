# U3 affected source review — R4

**Verdict: APPROVE, bounded source-only correction. Zero supported findings.** R3-F1 is resolved in the inspected transaction-owner path. This is not whole-U3, PostgreSQL/provider, runtime or release acceptance.

## Authority and intent

Reviewed only in `/Users/angel/.t3/worktrees/loom/release-kello-001-002-alpha`, branch `refactor/neon-cloud-tooling`, HEAD `623a764820e972aa896dd12d1d88586ef95b384c`. Branch and HEAD matched at opening and closing. The four-file authority is `/tmp/kello-u3-review-r4-freeze.json`; no drift was adopted or repinned.

The governing mission remains cloud-only Neon execution with natural typed `.live()` through the official SDK; local author watching/codegen/build, but no local backend/jobs/database. U3 must serialize/coalesce pinned preview deployments, retain last good state, and report genuine cancellation-drain failures. This pass evaluates the exact outer rollback correction, not a new framework or exhaustive historical review.

Read the actual `/Users/angel/dev/loom/AGENTS.md`, full plan `docs/plans/2026-10-16-1919-refactor-neon-cloud-only-plan.md`, full R1/R2/R3 reports and current `docs/tasks/cloud-only-current.md`. Truncated combined reads were recovered. The explicit no-delegation, source-only and sole-output instructions govern this review; no full CE shipping chain or independent peer review is claimed.

## R3-F1 adjudication

- **Correct transaction owner:** `withProcedureUpgrade` establishes its ownership marker only around the activation callback and clears it in `finally`. The matching `activateGrant` borrows that scope instead of opening a second transaction. The outer owner catches the propagated cancellation and awaits `ROLLBACK`. Standalone `activateGrant` passes its signal when it creates the owner itself. The release upgrade object now carries the original caller signal into both dry-run and actual activation calls.
- **Signal identity:** the new branch requires both an aborted owner signal and `cause === options.signal.reason`. Merely aborting does not replace an unrelated primary error. Activation normalizes identifiable cancellation to the signal reason through `rethrowSignalCancellation`, so the affected path reaches the owner's exact comparison. The borrowed activation session composes the connection/option signals; caller cancellation retains the original reason identity. Release preparation and database connection plumbing carry that caller signal into the session.
- **Falsey failures and primary precedence:** rollback rejection is caught regardless of its value, including zero or undefined. After an expected cancellation, any such rejection becomes `Error("Procedure upgrade rollback failed")`. A different genuine primary cause, including a falsey primary distinct from the reason, is rethrown unchanged. No truthiness test discards it. Exact equality deliberately cannot distinguish a separately thrown value identical to the caller's reason; this is the existing identifiable-cancellation contract, not a newly demonstrated failure in these callers.
- **Drain ordering:** successful rollback completes before the original cancellation is rethrown. Failed rollback produces a distinct error before the owner settles. The coordinator awaits the update, retains the first non-cancellation drain error in an Error wrapper, and waits for settlement in `stop()`. A successful successor clears current `failure` only, not retained `drained`.
- **Actual release redaction:** trigger activation may replace the safe upgrade failure with its fixed `Trigger activation incomplete; inspect provider state before resuming` error. That remains distinct from caller cancellation and is therefore still retained. The tests' direct chain observes the upgrade message; the complete release need not preserve that exact message to preserve honest failure. The new error contains neither the raw rollback message nor its cause. Existing genuine-primary precedence is unchanged; this is not a claim that every historical migration error is redacted.

No successful return shape changes. The added optional `ProcedureUpgradeOptions.signal` preserves existing callers; it supplies cleanup classification, not a new promise to interrupt PostgreSQL queries. No credential disclosure or additional API regression was established in this correction.

## Regression evidence and limits

The full current `deployment-cancellation.test.ts` body joins actual `withProcedureUpgrade`, `activateGrant` and `createDevelopmentCoordinator` with mocked `pg.Client.query`. Its six new cases cover successful rollback, Error rejection and zero rejection, each under direct stop and supersession followed by a successful revision. A pending quarantine query provides the cancellation point; explicit flush schedules the successor; rejection observation is attached before releasing the query. The callback reaches the existing owned scope. No actual connection is opened.

These cases support the causal correction, but do not execute the complete release/provider chain or directly gate a pending rollback to measure settlement ordering. The awaited rollback ordering, standalone signal forwarding and genuine-primary precedence were assessed from source. No new test requirement is asserted merely for those bounded limits.

Parent-attributed logs were read, not rerun:

- `/tmp/kello-u3-outer-rollback-red-r2.log`: four expected failure cases received clean/null stop, five cases passed. This is the repeat causal RED after scheduling correction.
- `/tmp/kello-u3-outer-rollback-red.log`: five failures total, including three successor scheduling timeouts and two assertion failures; four passed. The timeouts are not counted as causal production evidence. The parent states scheduling was corrected before implementation.
- `/tmp/kello-u3-outer-rollback-final.log`: 31 passing tests across three files.
- `/tmp/kello-u3-r3-app-types-final.log`, `/tmp/kello-u3-r3-tests-types-final.log`, `/tmp/kello-u3-r3-lint-final.log`: inspected; exit-zero statuses are parent-attributed because the terse logs do not independently establish process exit status.

These are supplied post-correction results, not reviewer execution or independent exact-hash runtime certification. Earlier greens retain their original attribution and limits; no new post-fix claim is inferred from them. There is no actual PostgreSQL, Neon/provider, transport, browser or release acceptance here.

## Body coverage and earlier corrections

Full current bodies read: all four R4 files; `dev/coordinator.ts`, `deploy/neon/observe.ts`, `deploy/neon/triggers.ts`; `dev/development.ts`, `dev/watcher.ts`; and `migrations/connection.ts`. Read relevant signal/connection/session caller sections of `deploy/neon/prepare-release.ts`, `release-database.ts`, and `connection.ts`, and searched actual production `withProcedureUpgrade` callers. Inspected current-versus-HEAD diffs for the owner and release change. Partial caller reads are not represented as full-file coverage.

R2 target pinning and publication-event corrections remain in place: the development owner forwards its expected target/version, the inspected connection path checks authority before URI resolution and under the lock, and the watcher excludes the owned root publication names. All 60 original R2 manifest entries still match. Eight R3 entries outside the two R4 replacements also match, including observe/apply/health/triggers/coordinator. This is identity continuity and bounded caller inspection, not a new full review of earlier bodies or a new execution claim. Earlier reports retain their own coverage limits.

U5 bundler changes in apply/index and U4 `runtime-cloud-only.test.ts` are separate preexisting work, not approved or modified here. Historical deletion bodies, all transitive callees, full SDK/runtime and later units were not exhaustively reread.

## Opening and closing pins

All four hashes matched the supplied R4 manifest at opening and closing; zero drift. Manifest SHA-256 remained `f863daddfd351e62a8071c6c900a816ca56981b5975cec8ee5d1d00b2a591dcf`.

```text
6d05b0c12b0bdafc89fd80dc317bce8c2125c1c54701175630a3458cec645997  apps/kello/src/tooling/migrations/procedure-upgrade.ts
f2b59fa47b2941a3f60a325d1664105ab1b689cefb666282f1426d59adb63a3e  apps/kello/src/tooling/deploy/neon/activation.ts
3107dec94d94c227c13c33daa0c35f365e150ba588213f57848c9519e2bb9599  apps/kello/src/tooling/deploy/neon/release.ts
6df37927212eabf3cdda92cdb09e36b7e9e3b83db715030487b056ceb62f44dc  packages/tests/unit/deployment-cancellation.test.ts
```

No delegates, tests/builds, network/database operations, commits or source edits occurred. The sole written file is this report. Terminal review state: **APPROVE — bounded affected source, zero findings**.
