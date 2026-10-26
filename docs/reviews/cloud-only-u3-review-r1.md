# U3 bounded independent source review — R1

**Verdict: REVISE.** One P1 and two P2 findings below. This is a source/API/security/lifecycle review of the uncommitted U3 candidate, not cloud acceptance or full CE shipping completion. Coverage is bounded and incomplete for some peripheral/deleted test bodies; the findings do not depend on those unread bodies.

- Canonical checkout: `/Users/angel/.t3/worktrees/loom/release-kello-001-002-alpha`
- Branch: `refactor/neon-cloud-tooling`
- HEAD/base: `623a764820e972aa896dd12d1d88586ef95b384c`
- Frozen manifest: `/tmp/kello-u3-removal-frozen-sha256.txt`
- Manifest SHA-256: `d64f34da0e95da58c0ab2ba03165437e88a9d10588366a5258bd68a921e3d2ad`
- All 52 manifest rows (including deletions) matched before and after review. HEAD remained unchanged. These checks establish snapshot identity, not reading coverage.

## Findings

### F1 — P1: The session pin does not constrain the release's actual mutation target

**Location:** `apps/kello-cli/src/tooling/dev/development.ts:62–68`; downstream `apps/kello-cli/src/tooling/deploy/neon/project.ts:97–121`, `managed-credentials.ts:29–59`.

The selected/current comparison checks one preflight snapshot, then passes only `root`, `file`, `provider` and `signal` to `deployProjectRelease`. That function rereads the project/declaration and resolves managed credentials from the new values. The credential path independently selects its target, then bootstraps metadata, changes the runtime role and writes deployment secrets. It never receives or compares the watch-session pin. Later release checks compare their own freshly selected identities, not the original watch-session authority.

**Trigger:** after the last preview assertion, change the saved target before the release reread, or change the provider's writable endpoint before credential resolution. A saved-link update under `.loom` is ignored by the watcher; a provider endpoint change generates no filesystem event at all. Even with authored-config changes, asynchronous watcher cancellation is not a mutation authorization check. A consistent new target can pass the downstream checks. `assertGeneratedVersion` reloads source and compares it with the release's reread version; it does not compare with the candidate version or session pin.

**Effect:** a running watch session can perform privileged database preparation against an authority it did not pin, and downstream release work has no session-bound rejection. A later rejection cannot undo already committed credential preparation. This breaks the stated restart-to-retarget security contract.

**Minimum fix:** carry the expected preview authority into the existing release path and enforce it against the actual resolved configuration/declaration/target before managed credential writes and release mutations. Bind the release to the generated candidate version too. Reuse the existing target/connection checks; an extra preflight alone leaves the same race. Add a regression at the real release/credential seam that changes the target after dev preflight and verifies zero writes. The five current retarget tests replace `deployProjectRelease` entirely and only cover changes visible before preflight comparison.

### F2 — P2: Publication can cancel its own revision and repeatedly redeploy the same version

**Location:** `apps/kello-cli/src/tooling/deploy/neon/publish-client.ts:33–39`, `apps/kello-cli/src/tooling/dev/development.ts:60–72`; supporting `dev/watcher.ts:21–31`, `dev/coordinator.ts:87–93`, `deploy/receipt-file.ts:17–37`.

`writeManagedPublicEnvironment` writes `.env.local` through a root-level temporary file named `..env.local-<uuid>.tmp`, renames it and performs asynchronous sync/cleanup. Neither path is excluded by the watcher. Any delivered event immediately invalidates the coordinator and aborts the revision. The next publication abort check then throws, or the post-release `revision.assertCurrent()` throws. `active` is only assigned afterward.

**Trigger:** deliver an owned environment-file/temp-file event before publication/release returns. This is an ordinary permitted filesystem event ordering; the remaining awaited filesystem and generation work creates the window.

**Effect:** the already successful remote release is not recorded as active/ready and generated public configuration may remain unpublished. The successor sees the old/null active version and calls release again. Publication rewrites even unchanged environment contents, so the cycle can repeat. Excluding `.env.local` from the source hash does not prevent cancellation before the version is recorded.

**Minimum fix:** keep owned publication output (including its temporary names) from invalidating the source revision, or distinguish an actual source-version change before aborting in response to such events. Preserve cancellation for real edits. Test event delivery while the actual publication promise remains pending, followed by complete client publication and exactly one release. The existing deploy mock writes `.env.local` and immediately returns, so its green result does not cover the actual multi-stage publication window.

### F3 — P2: Stop silently discards a non-cancellation release/cleanup failure

**Location:** `apps/kello-cli/src/tooling/dev/development.ts:68,92`; supporting `dev/coordinator.ts:54–56,100–106`, `apps/kello-cli/src/commands/dev.ts:61–79`.

The new development owner delegates stop entirely to the watcher/coordinator. The coordinator catches every update rejection and records it only when the revision is current, not stopped, and not aborted. After stop or supersession, it discards even a distinct cleanup error. Its `stop()` then resolves. The CLI's careful stop-error propagation cannot observe an error that this layer erased.

**Trigger:** an in-flight release settles with a non-abort error while stop is draining it—for example, a release receipt/configuration lock removal or connection close rejects after cancellation. The same suppression occurs when a newer revision supersedes the old one.

**Effect:** CLI stop can report success despite failed owned cleanup; supersession can proceed without reporting that failure. Raw failure information is lost at the new cloud-update ownership boundary. Previously the separate server owner could surface its cleanup failure after watcher shutdown.

**Minimum fix:** retain and surface non-cancellation failures encountered while draining a revision, while treating the expected cancellation reason as normal cancellation and preserving an existing primary failure. Ensure abort/error listeners observe any rejecting stop promise. Add a test using the actual coordinator plus a rejecting release cleanup, rather than only a mocked development object's rejecting `stop()`.

**Independent bounded probe:** imported the current coordinator directly with Bun, blocked an update, called `stop()`, then rejected the update with `Error("cleanup-canary")`. Observed `{ "stopResolved": true, "failure": null }`. This ran without files, provider calls, database access or browser activity. A second in-memory coordinator probe modeled one publication invalidation and observed two update calls for one unchanged version; it is an event-order model, not native filesystem/cloud proof.

## Coverage and evidence limits

Read `/Users/angel/dev/loom/AGENTS.md`, both handoffs in full, the owned-path list and manifest, and the plan's Goal/Product Contract, R1/R2/R6, U3, verification and DoD. No delegates or formal multi-lens chain were used.

Full current-body reading covered the dev owner/project/watcher/coordinator, dev command, credential validator, schema provisioning, release entry point/publication, tooling barrel, new unit tests, HTTP fixture, three ported backend fixtures, dev CLI/component HTTP tests, cloud component watch test, README and development guides. Read the deleted production modules from HEAD and compared their archived pre-deletion differences: the archived runtime's cron removal was inherited WIP. Reviewed CLI changes and failure routing, and the causal diff portions in diagnostics, example lifecycle, RPC runtime and full-text caller tests. Traced relevant existing deployment target/connection, managed credentials, generation/version and environment publication code.

**Not full-file coverage:** the entire unchanged CLI body, the complete diagnostics/example-lifecycle/RPC/full-text test bodies, and all deleted test bodies were not read end to end. Deleted test coverage was an assertion/title inventory from the archive or HEAD, with selected surrounding code/diffs. Some large combined diff outputs were truncated; they are not counted as complete reading. Therefore the requested exhaustive current-source-plus-HEAD-diff reading of every one of the 52 paths is **not claimed complete**. This review supplies actionable source findings, not 52-file clearance.

The removed-symbol search across `apps/kello/src` and `packages` found no remaining TypeScript callers for the removed local APIs/import paths searched. The current barrel removes those APIs and retains standalone diagnostics. Activation still calls release quarantine through `quarantineDeploymentConnection`; no orphan-removal finding is warranted. The relocated URI validator preserves direct endpoint, role/database and pg identity-override rejection and fixed error messages. CLI errors use fixed messages; the read component HTTP proof retains raw signed bytes, unauthorized/forbidden responses and private-route absence. No new credential leak was established in these inspected paths.

Worker evidence, read rather than rerun: final unit log reports 47 tests/11 files; HTTP/CLI/watcher log reports 13 passing tests; diagnostic child log reports one passing test/four filtered. Scoped app/tests/e2e type logs, lint and export logs were inspected; build log reports completion with bundler warnings. The causal RED logs show the setup-abort failure and five preflight retarget failures. These results belong to the worker. They do not prove the three interleavings above. No broad test/build/install was run by this reviewer.

The README/barrel bundler hunks, previous job/cron removals, shared fixture/lifecycle inherited changes, package/lock/apply changes and later-unit WIP were not treated as U3 authorship or modified. Core legacy live-engine removal remains U4; retained engine code is not a U3 finding. Removed auth evolution, revocation/selective invalidation and database lifecycle proof still requires the recorded U4/U6 work. No real Neon, PostgreSQL, provider, browser, packed deployment or release acceptance is claimed.

## Exact reviewed source identities

- `apps/kello-cli/src/tooling/dev/development.ts`: `5c26d2b0985aeffaf475398690d5d3162f87ed4a024de7b973fbf7ebbf5eacc8`
- `apps/kello-cli/src/tooling/dev/watcher.ts`: `036fcddeb24e6ba3fd83fcd286cce04906d291af736326c3c109243dc25dff1e`
- `apps/kello-cli/src/tooling/dev/coordinator.ts`: `35167f3376a19384e1fea0c94614681fea92194d6ab5dc5184ed857a769490fe`
- `apps/kello-cli/src/tooling/deploy/neon/project.ts`: `4abbb92090d4e25ac96098b6dd1f0f520b8f89094a61395e79fdfda4ea65100e`
- `apps/kello-cli/src/tooling/deploy/neon/publish-client.ts`: `78a2b7bed87e4b339968edbb078f19f712cb0029163cbebd6ff91b95bb231d71`
- `apps/kello-cli/src/commands/dev.ts`: `dce92edef286678e721555eb7477b7644d0949ea7e8e5b6ad0688c4a906c4c4f`
- `packages/tests/unit/dev-preview.test.ts`: `20f158e8736dd9f4240e0326ea92ae45fb31a0d8afb487db8065943a88787ffb`
