# U3 cloud preview source review, round 2

**Verdict: REVISE — one P2 finding.** F1 and F2 are resolved in the reviewed source paths. F3 preserves genuine drain failures, including falsey values, but misclassifies ordinary cancellation from the actual release implementation.

## Authority and scope

Canonical checkout: `/Users/angel/.t3/worktrees/loom/release-kello-001-002-alpha`. Branch: `refactor/neon-cloud-tooling`. Opening and closing HEAD: `623a764820e972aa896dd12d1d88586ef95b384c`.

This was one independent correctness/API/security/lifecycle source review, not a CE shipping invocation. No delegates, source edits, history changes, commits, build, test, install, browser, network, provider or database execution. The only written artifact is this report. Other dirty work was neither adopted nor reverted.

I read the full applicable `/Users/angel/dev/loom/AGENTS.md`, the actual plan `docs/plans/2026-10-16-1919-refactor-neon-cloud-only-plan.md`, R1, all three supplied handoffs, the 60-path freeze manifest, the original 52-path ownership list, and the final correction hash file. Truncated reads were recovered. The contract reviewed is author-side watching/codegen/build with ordinary explicit Neon preview releases, session-pinned unprotected/nondefault linked authority, serial/coalesced cancellation with actual release draining, last-good retention, and no locally served backend/database/jobs/crons. Natural official Neon `.live` delivery remains required; U4 engine removal, U5 dependency work and U6 provider acceptance are separate.

## Finding R2-F1 — P2: real release cancellation is retained as a cleanup failure

**Location:** `apps/kello-cli/src/tooling/dev/coordinator.ts:60–70`, especially cancellation classification and assignment to `drained`; downstream causal site `apps/kello-cli/src/tooling/deploy/neon/apply.ts:271–306`; observable rejection at coordinator `stop()` line 121 and `apps/kello-cli/src/commands/dev.ts:78`.

**Trigger:** An ordinary edit supersedes a release, or the user stops development, while `applyNeonFunctions` is polling an accepted function deployment. The actual release awaits a signal-aware timer at line 301 (or checks the same composed signal at lines 272/274). Cancellation rejects that operation. Its enclosing catch at lines 305–306 replaces the rejection with a fresh generic `Error("Function deployment incomplete; inspect the saved function receipt before resuming")`, without a cause.

**Effect:** The corrected coordinator recognizes only the abort reason itself, a timer `AbortError` carrying that reason, or its own tracked stale-revision error. The real release's replacement error matches none. Consequently, a normal cancellation is permanently retained as `Development update cleanup failed`, even if all resource cleanup succeeds. A successful successor clears `failure` but does not clear `drained`; a later clean stop still rejects. A stop during the polling stage also rejects directly, and the CLI reports development failure instead of a normal stop. This is a source-established control-flow defect, not a reviewer-executed reproduction or evidence of remote corruption.

The real release body is mocked in the correction tests, so direct abort-reason/timer/stale coordinator cases do not cover this integration. Other release-stage redaction catches also replace errors, but the function-polling path alone establishes the finding. The downstream file contains other-unit work; this finding concerns the changed coordinator's integration with its actual callee, not authorship of all callee changes.

**Minimal fix:** Preserve identifiable expected cancellation through the release-stage error-redaction boundaries and consume it as cancellation in the coordinator, while continuing to retain distinct cleanup failures (including `undefined` and `0`). Do not suppress all errors merely because a signal is aborted. Add a causal test joining the actual polling/release-stage body to the coordinator with resource boundaries mocked: cancel during polling and drain cleanly; supersede, complete a successor and stop cleanly; separately reject cleanup and verify stop still rejects. Preserve primary-error precedence.

## Response adjudication

### R1 F1 — resolved in reviewed source

The explicit expected target and candidate version now travel from development through the optional fifth `deployProjectRelease` argument. The project boundary checks preview status, version and operational configuration before credential resolution. Its copied primitive target is propagated separately from strict command validation and receipt hashing. Existing four-argument deployment callers retain their contract.

I traced actual privileged plumbing rather than relying on the mocked deploy test: managed credentials pass expected authority to the deployment connection before bootstrap, `ALTER ROLE` and secret writes; connection configuration and selected project/branch/endpoint are checked before obtaining a URI and checked again under the lock before the operation. Existing credential URI validation still binds endpoint, role and database and rejects overriding query parameters. Release input preserves expected authority through cloning; prepare-release checks it before Realtime setup, and release-database forwards it to the guarded connection before schema/release work. Activation uses the guarded borrowed connection. Function planning/application retain their binding/target checks. No signal-keyed authority registry was introduced.

Candidate-version checks and captured operational fields address the reviewed config reread windows; publication coordinates are intentionally excluded from source identity. I found no remaining concrete F1 bypass in these paths. This is source adjudication, not real-provider authority or race acceptance. The reported post-lock regression demonstrates message/control behavior rather than independently establishing a newly fixed provider race.

### R1 F2 — resolved in reviewed source

The watcher excludes only root `.env.local` and the exact root `..env.local-<UUID>.tmp` shape produced by the atomic receipt writer. The single-path-segment requirement leaves nested names observable; malformed/lookalike temp names and ordinary source edits remain invalidations. Unknown filenames remain conservative. Ordinary edits still abort an active revision immediately.

The relevant regression uses the real managed-environment writer while a mocked release is pending. It supports the root publication-event correction, with actual publication mocked in that watcher case. It does not establish every native filesystem ordering or real-provider behavior. The handoff explicitly discloses overwritten intermediate F2 logs; this review does not claim those artifacts were preserved.

### R1 F3 — partially resolved; revision required

The first non-cancellation drain failure is retained using an Error wrapper, preserving raw falsey causes. Successful successors cannot erase it. Watcher stop returns a cached promise; event listeners observe its rejection without replacing the promise returned to callers. CLI stop handling preserves an existing primary failure and can expose a falsey cleanup rejection. Those changes address the original swallowed-cleanup cases.

However, cancellation classification is narrower than the actual downstream release error surfaces. R2-F1 prevents approval of the complete F3 correction. Serial draining itself remains present; the defect is the false persistent failure classification.

## Actual reading coverage

All **38 present bodies** in the supplied freeze manifest were read in full, including all listed current regression bodies. This is not a claim to have read 60 current bodies: 22 entries are deletions. The exact fully read present inventory follows:

- `apps/docs/content/docs/operations/development.mdx`
- `apps/kello/README.md`
- `apps/kello-cli/src/cli.ts`
- `apps/kello-cli/src/commands/dev.ts`
- `apps/kello-cli/src/tooling/config/development.ts`
- `apps/kello-cli/src/tooling/deploy/neon/connection.ts`
- `apps/kello-cli/src/tooling/deploy/neon/credentials.ts`
- `apps/kello-cli/src/tooling/deploy/neon/managed-credentials.ts`
- `apps/kello-cli/src/tooling/deploy/neon/prepare-release.ts`
- `apps/kello-cli/src/tooling/deploy/neon/project.ts`
- `apps/kello-cli/src/tooling/deploy/neon/publish-client.ts`
- `apps/kello-cli/src/tooling/deploy/neon/release-database.ts`
- `apps/kello-cli/src/tooling/deploy/neon/schema-provision.ts`
- `apps/kello-cli/src/tooling/dev/coordinator.ts`
- `apps/kello-cli/src/tooling/dev/development.ts`
- `apps/kello-cli/src/tooling/dev/project.ts`
- `apps/kello-cli/src/tooling/dev/watcher.ts`
- `apps/kello-cli/src/tooling/index.ts`
- `docs/architecture/development.md`
- `packages/e2e/cloud/dev-component-watch.test.ts`
- `packages/e2e/fixtures/http-handler-server.ts`
- `packages/e2e/fixtures/integration-examples.ts`
- `packages/e2e/fixtures/local-jobs-storage.ts`
- `packages/e2e/fixtures/local-tasks.ts`
- `packages/e2e/integration/dev-cli.test.ts`
- `packages/e2e/integration/dev-component-http.test.ts`
- `packages/e2e/integration/diagnostics.test.ts`
- `packages/e2e/integration/example-lifecycle.test.ts`
- `packages/e2e/integration/rpc-runtime.test.ts`
- `packages/e2e/integration/search-full-text-callers.test.ts`
- `packages/tests/unit/deployment-connection.test.ts`
- `packages/tests/unit/deployment-project.test.ts`
- `packages/tests/unit/dev-command.test.ts`
- `packages/tests/unit/dev-coordinator.test.ts`
- `packages/tests/unit/dev-preview.test.ts`
- `packages/tests/unit/diagnostics-dev-command.test.ts`
- `packages/tests/unit/http-ordinary-stream.test.ts`
- `packages/tests/unit/neon-credentials.test.ts`

Additional full supporting bodies read: Neon `release`, `activation`, `target`, `apply`, `release-receipt`, `environment`, `plan`, `storage` and `ingress`; migration connection; codegen generate; environment-file and receipt-file writers; deploy command; project sources; core Neon `rpc-http` and `rpc-application`; unchanged `packages/e2e/integration/dev-watcher.test.ts`. These establish relevant callers and downstream operations beyond the immediate correction seam.

Partial supporting reads: project loader configuration/version/hash functions; trigger context/disable/activate paths; function-health operation and relevant catch boundaries. Other helpers in those files were not comprehensively reviewed.

Current-vs-HEAD causal diffs were inspected for the changed development/deployment flow, CLI/barrel/config, publication, schema provisioning and peripheral fixture/caller migration. Archived pre-correction source comparisons were read for the eight changed source copies available under `/tmp/kello-u3-r3-before`; command and publication copies were unchanged. These comparisons are distinct from full independent reading of every historical body.

Of deleted production APIs, the former development connection body was read from HEAD to assess credential relocation. **The other 21 deleted manifest bodies were not fully read.** Their deletion state and reference removal were checked; this is an explicit historical-body coverage limit, not inherited R1 or author credit. Searches across current CLI/package TypeScript found no references to the removed named development server/runtime/sync/connection/target/quarantine APIs. Shared README/barrel and prior jobs/crons hunks were considered for compatibility, not attributed wholesale to U3.

The HTTP fixtures now use the ordinary HTTP application without enabling local realtime. I read the actual HTTP handler/application and async-iterator regression: ordinary streaming responses and cancellation plumbing remain represented. No runtime verification was performed. Retained core live-engine code is the explicit U4 boundary, not a U3 finding.

## Evidence and limits

Parent-supplied acceptance evidence is attributed to the parent, not this reviewer: rebuilt core exit 0 (warnings retained); 66 unit tests across 12 files; app/test/e2e typecheck exits 0; 13 CLI/HTTP/filesystem cases; final correction hashes and diff-check success. I read the unit and e2e logs and typecheck logs; the typecheck exit statuses come from the parent's statement. I inspected the build log tail, which records completion and module-directive warnings, not its entire body.

Author evidence is attributed to the correction handoff: 49 unit cases/seven files plus four watcher cases, F1 12 red/12 green, F2 red timeout/15 green with the disclosed overwritten intermediate logs, and F3 five red/24 green. I additionally read the F3 red/green logs. I did not independently execute any of these checks. The actual `deployNeonRelease` body is mocked in the correction tests; writer-real/publication-mocked coverage is narrower than a real deployment. These passing results do not contradict R2-F1's uncovered real-stage error conversion.

No real provider, database, transport, runtime release, concurrency schedule or U6 acceptance is certified. This bounded review found one concrete defect; it does not claim exhaustive historical deletion coverage or clearance for later units.

## Closing identity and hashes

Opening and closing checks independently matched all **60 freeze entries: 38 SHA-256 file hashes and 22 absences**, with zero mismatches. All **14 correction-file hashes** independently matched the supplied final hash list. Branch and HEAD remained pinned as above. No reviewed source was written.

- Freeze manifest SHA-256: `c8d85686cc37f7c83d69bab7f18b4e4d8027ea3cf9b8d50ffdbcc45c46227ebf`
- Final hash-list SHA-256: `3a87d4848a3be7898b2f3d2d5999ea791f2a4fe0e092bfc74fa2599104e083e0`
- Immutable R1 report observed SHA-256: `781131f58b42e16f9e054b64ca3c3cd9ac822e9236bb627e9d864ab709724e65`

Closing correction-file hashes:

```text
3dcd3437a8f4a380d165e1adfbc1f98473ce93f1be4a0009e1652d8acbbd1797  apps/kello-cli/src/tooling/dev/development.ts
b2d9966c00ac778cd989a6ce4e7065115eb6713a61a0f27c5082fa85bfc11518  apps/kello-cli/src/tooling/dev/watcher.ts
e0fed59cb204d514976cf161e418fcf3503d785d3e901449771f9b539f66f452  apps/kello-cli/src/tooling/dev/coordinator.ts
0a47d9df11fba2884a02ba5638e9b76fdebc6fcfa969148d7c7e5c917ca668bc  apps/kello-cli/src/tooling/deploy/neon/project.ts
671cbc7856caa034995bfc412226d8ff2cb0fc419097a2023ce098ed3a188caa  apps/kello-cli/src/tooling/deploy/neon/managed-credentials.ts
bf28542e4ec990fc2e11b1ec156bc0894d0114caa764c15061a4af2b8ccfce79  apps/kello-cli/src/tooling/deploy/neon/connection.ts
e6c131264a2a331cd954600cab15ebc7c469d5d231cb6b84538e0f62dde34003  apps/kello-cli/src/tooling/deploy/neon/release-database.ts
2287db3487680a2a724f737bc3195c0e8239ca5e1847dc4bbef67e278a680042  apps/kello-cli/src/tooling/deploy/neon/prepare-release.ts
78a2b7bed87e4b339968edbb078f19f712cb0029163cbebd6ff91b95bb231d71  apps/kello-cli/src/tooling/deploy/neon/publish-client.ts
dce92edef286678e721555eb7477b7644d0949ea7e8e5b6ad0688c4a906c4c4f  apps/kello-cli/src/commands/dev.ts
ee274d62b288f733fb5f2a8f0fbea468003695d462f328370a2571b1a56d9135  packages/tests/unit/deployment-project.test.ts
fd6d49b2817f56d936b26123424d96fadcf541fb0fa9161e1082c4159b023832  packages/tests/unit/dev-preview.test.ts
0ee16fc3c25941f534deab6f513738e53df4702f5b5561e642cb4ac65d80b3ef  packages/tests/unit/dev-coordinator.test.ts
88f3b3e47a715c6e9587ff2fd41b789b76bf6145cbb704d0d766629023e5672b  packages/tests/unit/deployment-connection.test.ts
```

Terminal review state: **REVISE (1 P2)**.
