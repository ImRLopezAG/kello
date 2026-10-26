# Frozen U2 affected-source review R4

Status: **TERMINAL / noPending**. Verdict: **APPROVE — bounded URL correction and retained affected SOURCE behavior**. Findings: **P1 0, P2 0, P3 0**. This is not full U2 acceptance, exhaustive Zod representability proof, or U6/release clearance.

## Scope and intent

Canonical checkout: `/Users/angel/.t3/worktrees/loom/release-kello-001-002-alpha`; branch `refactor/neon-cloud-tooling`; HEAD `586e87791735da2282d2dc120f8e084a13764dca`.

One independent gpt-6-astra LOW reviewer context applied correctness, implementation and security lenses. No delegates, redundant review hierarchy or cross-model proof. Read root `/Users/angel/dev/loom/AGENTS.md`, governing `docs/plans/2026-10-16-1919-refactor-neon-cloud-only-plan.md` requirements R4-R6, KTD2 and U2, complete prior R1/R2/R3 reports and responses in actual `docs/tasks/cloud-only-current.md`.

Intent remains natural function-contract `.live()` authoring with inferred flat output, faithful runtime validation, HTTP issuance/renewal and official Neon delivery with trusted authority. This correction refuses unsupported decoder semantics through the existing generator; it introduces no framework or new transport.

Personally read complete current `apps/kello-cli/src/tooling/codegen/live-query.ts` and `packages/tests/unit/live-procedure.test.ts`, plus their actual HEAD-relative diffs. Inspected relevant installed Zod 4.6.5 schema/check definitions, conversion aggregation/string/number processors and reconstruction source. No `.codegraph/` directory exists. The jobs-storage contract and public Id proof were hash-verified only; their complete-body and generated-client type-chain review credit belongs to R2. R1's 69-path reading and wider authority conclusions are historical, not this reviewer's personal coverage. The inherited integration checkout supplied only the initial working-directory identification; no source there was reviewed or changed.

## Correction assessment

**U2-R3-1 is resolved within this bound.** `live-query.ts:25-30` shares `validateZodFormatOptions`; calls at lines 34 and 49 inspect both source schema definitions and each check definition before JSON conversion at lines 93-94. Every nonundefined `protocol`, `hostname` or `normalize` refuses. This includes `normalize: false`, a conservative explicit-option refusal consistent with the requested supported subset. Undefined options and ordinary `z.url()` remain supported.

The causal chain is supported by installed source, not just green tests: Zod `src/v4/core/schemas.ts:510-513` declares the three URL options; lines 623-648 enforce hostname/protocol and choose normalized output. `src/v4/core/json-schema-processors.ts:129-174` converts URL to URI without those options. `src/v4/classic/from-json-schema.ts:510-513` reconstructs URI as plain `z.url()`. Refusing the authored options on both routes before that lossy conversion closes R3's HTTPS-only/hostname widening and normalization mismatch.

The five new cases at `live-procedure.test.ts:402-420` separately exercise schema protocol, check protocol, hostname, schema normalization and check normalization. Restriction cases first establish authored rejection; normalization cases establish changed authored output; each then requires generation to refuse. The inspected RED log shows each of the five independently reached and failed the refusal assertion. Unlike the earlier six-case loop, no first failure hides the remaining URL cases.

**U2-R2-1 remains resolved.** The shared helper retains the RegExp flag check for source and check definitions. Installed check execution uses the original RegExp, while JSON conversion writes only `.source` and reconstruction uses flagless `new RegExp`. The retained negated-class regression at lines 392-400 demonstrates authored rejection, flagged refusal and both acceptance/rejection for an unflagged pattern. Independent probes additionally verified flagged source-format and check-pattern refusal.

**U2-R1-1 concrete cases remain resolved.** The recursive source subset and check-kind allowlist are intact. Field/row/array refinements, trim/lowercase, coercion and explicit transforms refuse; an optional-wrapped refinement also refuses in the reviewer probe. UUID, string/numeric bounds and unflagged regex accept/reject behavior survived generated reconstruction in bounded probes. Plain URL schema/check forms also retained success and parsed values, including ordinary whitespace trimming.

Framework Id handling is unchanged in the affected source: only `isIdBrandAction` bypasses the Valibot conversion action refusal. The retained test at lines 341-363 checks valid ID output, invalid UUID rejection and refusal of an additional arbitrary transform. The jobs-storage contract and public `Id<"files">` inference proof hashes equal R2/R3; R2's body review and attributed type-proof result are carried forward, not newly executed compiler evidence.

No new independently supported correctness, implementation or security defect was retained in this bounded correction. The guard fails before emitting browser validation rather than accepting known-weaker URL contracts. This is validation fidelity evidence, not a renewed audit of identity, SQL authorization, replay, HTTP transport or secret handling.

## Verification provenance and limits

Reviewer execution consisted of read-only Git/source/log inspection, initial/closing SHA256 verification, and one bounded in-memory Bun decoder probe command, exit 0. That command asserted 18 refusals (URL options on both routes including hostname and explicit false normalization; flagged patterns; refinement/transformation/coercion cases) and 15 original-versus-generated comparisons covering ordinary URLs, unflagged regex, UUID and string/numeric bounds. For successful parses it compared output values as well as success. No files or external resources were acquired by the probe. These probes supplement source analysis; they are not a full test-suite run.

Inspected parent logs:

- `/private/tmp/kello-u2-url-red.log`: 14 passed / 5 failed; all five new URL refusal assertions failed independently.
- `/private/tmp/kello-u2-url-green.log`: 19 passed / 0 failed after correction.
- `/private/tmp/kello-u2-url-types.log`: the three app tsconfig commands, no diagnostics. Exit 0 is parent-attributed; the text does not independently encode the exit status.
- `/private/tmp/kello-u2-url-lint.log`: four test-only `typescript(no-implied-eval)` warnings at lines 198, 345, 368 and 397, no errors. No zero-warning claim; command success remains parent-attributed.

No build, generation, compiler, lint or suite was rerun by this reviewer. The previous core build and Next generation/typecheck greens predate the URL correction; they are historical and cannot establish current acceptance. Parent owns a rebuild outside this frozen-source review. The existing generated-module test writes temporary generated files and was read, not executed here.

All prior representability and provider limits remain. This bounded pass does not prove every combination of Zod formats/options/checks, third-party extensions or future versions. R1-R3's broader source/test evidence stays attributed. Current CI, actual Neon Auth sign-in/cookies/SSR/logout/revocation, Realtime initial/update/renewal, membership/external writers, receipt confirmation/replay orders, secret rotation, deployed streaming/disconnect behavior, mounted browser behavior and provider SQL support remain unverified here. Historical multiple-Set-Cookie constraints remain provider gates. No full U2/U1-U6 completion, deployment, publish or release acceptance is claimed.

## Integrity

All four pins in `/private/tmp/kello-u2-url-correction-pins.json` matched on initial verification and closing verification immediately before writing this report. Branch and HEAD also matched at closing. No pin drift was adopted. Sole writable output: this report. No source/test/generated writes, fixes, Git writes, installs, external runtime, DB/provider or browser operations. A lightweight memory registry search supplied no current-task evidence and was not used for the verdict.

```text
9dcd12c527676b02844607f654848cbb545fa881308975f1acb211c0b0bee197  apps/kello-cli/src/tooling/codegen/live-query.ts
a0479110867125acc5099f6c209f6bba91db8a445d486ee72a434a0e783f3d9e  packages/tests/unit/live-procedure.test.ts
e4bdd1b45f37eb8a93a9b3f64e30369adffc8e9d040987d5c9e937182a21cc5b  packages/examples/jobs-storage/kello/contracts/files.ts
b0b0568084c946783de9078fcafeab361fae565062a0fc556eebb99b53226c69  packages/examples/jobs-storage/types/live.test-d.ts
```

Terminal receipt: `{"status":"TERMINAL","noPending":true,"verdict":"APPROVE","bound":"URL correction and retained affected SOURCE behavior only","findings":{"P1":0,"P2":0,"P3":0},"report":"docs/reviews/cloud-only-u2-review-r4.md"}`
