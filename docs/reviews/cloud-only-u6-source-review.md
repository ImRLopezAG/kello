## Code Review Results

**Scope:** U6 working-tree delta against `da39c78d`, 12 paths: cloud acceptance workflow, ordinary HTTP browser regression, generated live browser fixture, four cloud fixtures plus their deployed entry, runtime assertions and status journal.
**Intent:** Make the cloud-only contract executable against actual Neon and preserve ordinary user-authored HTTP streaming.
**Mode:** sequential inline source/security review within implementation. The user's current Task mapping requires main-thread work. This is not independent Astra or cross-provider approval.

Lenses applied sequentially: correctness, security, testing, maintainability, project standards, reliability and adversarial failure scenarios. Workflow credentials and UUID resource deletion require security inspection; cleanup and actual-frame barriers require reliability inspection. No public production API or migration changes occur in this delta.

### Applied

- **#1:** `packages/e2e/fixtures/neon-realtime-smoke.ts`, final cleanup: a dispose/relay/pool exception could skip remaining cleanup and the safe report. Each known cleanup now records a fixed category independently; cleanup failure makes the command fail. Production code is unchanged. This was found by source inspection, not a causal failure test. Final actual-provider rerun passed 12 checks, with relay/pool closed, schema dropped and `cleanupErrors: []`; e2e typing, focused lint and formatting passed. The initially dirty tree keeps this correction in the implementation commit.

### Requirements Completeness

- Met for this checkpoint: durable actual Neon transaction/installed-progress checks; automated generated `.live()` React validation/pagination/update/outage/logout; real Node24 Function bundle, hosted worker and object-storage fixtures; ordinary HTTP streaming browser regression; explicit provider CI jobs that fail without credentials.
- Partial U6: these local/provider checks do not establish current-revision Linux CI, full example matrix or publication. Protected provider CI configuration and exact-revision workflow results remain required. U1-U5 commits retain their own reviews and evidence; this review does not replace them.
- No unrequested production behavior was found. Local loopback servers, JWT/session fixtures and the unmodified-frame relay are test instruments, not restored local backend support.

### Actionable Findings

No unresolved source finding in the inspected delta. Release gates remain open as stated below.

### Coverage

Read complete new provider/Function/jobs/storage fixture bodies and affected generated-browser changes; inspected full workflow and ordinary HTTP browser/test diffs, cleanup and existing HTTP fixture. Earlier reads in the same continuous implementation session are retained rather than claimed as independent rereads. Reviewed target guards, trusted identity refusal, secret-safe report fields, exact owned resource cleanup, failure exits and frame-barrier assertions. No capability, database URI or storage credential is intentionally included in reports.

Actual evidence: final provider run `9d3c2f2c-0fb6-47d0-a450-dfc0f36dc78b` passed 12 checks; generated-browser run `b8551d26-f38f-4e90-8863-abcfd9ca98fa` passed DOM verification and cleanup. Function/jobs/storage runs and broader unit/package results are attributed in `docs/tasks/cloud-only-current.md`; overlapping results are not added together. Latest e2e typing, focused source lint/format and whitespace checks exited zero.

Cross-model outcome: not performed, per sequential-main override. No claim of independent validation. Validator batch: empty after the applied source correction; no unresolved finding was sent to a validator. No suppressed findings or demotions. No worthwhile behavior-preserving abstraction was identified; combining unrelated fixture lifecycles would add machinery without improving their contracts.

Limits: no exhaustive transitive dependency review, forced cleanup-failure runtime proof or universal physical closure guarantee. Local unit workers used Node26, so their pass is not Node24 Linux CI evidence. Protected `neon-acceptance` configuration is absent; no local profile secret was uploaded. Full example CI, scheduled provider wakes, production identity-provider configuration and publication are not established by these fixtures. Historical broad artifact formatting failures remain recorded separately from focused source checks.

---

### Verdict

**U6 implementation checkpoint source-reviewed; full plan not ready for release.** The inspected source has no unresolved actionable defect after #1. Commit the tested fixtures, then require exact-revision CI/provider results before closing U6 or publishing.

Actionable source findings: none. Remaining release action: provision protected GitHub provider configuration and obtain current-revision CI results.

## Provider coverage follow-up

Reviewed the single-fixture delta against `b965fd30` through the ce-code-review lite path. Intent: make the existing CI fixture reproduce required external-writer, filtered/unchanged progress, overlapping receipts, pending logout and actual scheduled renewal cases. Production APIs, authorization and transport are unchanged. Assertions fail locally through the fixture's recorded failing exit; no new acceptance bypass or compatibility mechanism is introduced.

### Actionable Findings

None in the final delta. A conditional empty-object spread was replaced with explicit property assignment after lint rejected it; the final typecheck, lint, format and whitespace checks passed.

### Coverage

Read the entire added delta, surrounding issuer/relay/cleanup code, root CLAUDE.md and the plan's requirements/DoD. Compared the ported cases with retained real-provider fixtures. The final clocked renewal checks assert same authorization and expiry with a different fingerprint outside the SDK callback catch. In-flight renewal cleanup releases its gate and refuses further database work when stopping. Existing independent cleanup categories remain intact. No new abstraction offered a useful simplification.

Actual run `aa6793e6-5253-4ccf-951f-4ba627164199` passed all16 checks on the admitted Neon PG180006 target; report records relay CLOSED, own schema dropped, pool CLOSED and no cleanup errors. Raw log: `/tmp/kello-cloud-u6-required-provider.log`. The run precedes only the behavior-equivalent lint rewrite of observation object construction; final source typing/lint/format passed afterward. No independent or cross-model reviewer ran for this follow-up under the user's sequential-main mapping. No learnings, agent-native, deployment or exhaustive dependency assessment is claimed.

### Verdict

The scoped test addition is ready to commit. U6 and release remain open pending exact-revision Linux CI and protected provider-workflow execution; the provider run above is actual local execution, not a GitHub Actions pass.

## Preview and current CI fixture follow-up

Sequential inline correctness/security/implementation review of the current U6 delta against `080e81fe`, under the user's main-thread Task mapping; no independent Astra review is claimed. Inspected all changed hunks, the complete RPC-call helper, packed-consumer call/cleanup boundaries, and the preview compatibility/last-good assertions. No production API or authorization changes occur.

The native helper creates its own signing key and trusted fixture login, validates the issued version/database/deployment and decrypts only its own capability with fixed algorithms/audience. It admits only SELECT and the pinned adapter's context-inferred OID0 parameters, then executes the exact SQL through the existing restricted-role pool. It preserves ordinary HTTP calls/iterators and the original ownership/forgery assertions. This is issuance/SQL parity evidence, not provider delivery or general decoder support. The upload pool is closed independently of runtime.stop failure. No capability, credential or query is intentionally added to reports.

Preview acceptance explicitly declares reviewed compatibility for a nullable column using the existing public API, proves that declaration applies no DDL, then verifies schema-save migration preserves rows. Invalid source must report failure while the last deployed version remains usable. No production compatibility guard is weakened. The manual workflow requires protected provider configuration and successful preview, database and realtime jobs; missing credentials cannot produce acceptance. The additional vite-plus dev dependency belongs only to the fresh test consumer.

Stale schema migration and CLI-bin assertions follow current authoritative outputs without removing replay/history checks. The cursor hash was checked against the historical finite implementation with the same installed dependencies; actual cursor PG execution remains deferred to CI. The targeted CLI timeout covers two bundles plus real compiler work and preserves assertions; other timeouts are unchanged.

Actual evidence: six PG18.6 native cases passed with exact owned-container removal; all 11 CLI/packed cases passed with Node24.16.0/Bun1.4.3; e2e typing and targeted lint/format passed. The initial OID-schema and ambient-Node26 failures remain recorded separately. Earlier actual packaged preview passed all ten checks and its owned branch was independently absent. No new unresolved source finding was established in this test/workflow delta. Exact-head Linux CI and protected provider-workflow execution remain open; this checkpoint does not close U6 or authorize publication.

## Exact-release acceptance guard follow-up

Sequential main-thread correctness/security/testing review of the release workflow guard, its complete new integration test and the control-plane endpoint type pruning. No independent or cross-model review is claimed. The guard queries the fixed cloud workflow, exact checked-out commit and manual event, accepts only completed/success, and fails closed on missing evidence or GitHub CLI failure. Existing main-push CI, permissions, npm OIDC identity and version guards remain unchanged. No secret upload or publication was performed. The cloud workflow requires successful database, realtime and preview jobs; skipped or failed jobs cannot satisfy its required job.

Actual focused RED: the new test failed because the guard was absent. GREEN: it executes the shipped shell block with a mock `gh` and checks success, refusal, absent result and CLI failure. This validates argument binding and shell behavior, not GitHub's own query evaluator. An initial TS7022 subprocess inference error was corrected with the public `Bun.Subprocess` type and explicit ignored stdin; final e2e and app typing passed. The two affected control-plane/storage unit files passed 12 tests. Final targeted lint/format passed. Temporary test resources are removed in finally after the direct child exit and both streams settle.

The storage control plane has only a storage caller; deleting unused type alternatives changes no executable transport expression or ordinary user HTTP streaming. No new actionable finding remains in the inspected delta. Exact-revision Linux CI and protected provider-workflow execution remain outstanding; the repository lacks that protected environment configuration.
