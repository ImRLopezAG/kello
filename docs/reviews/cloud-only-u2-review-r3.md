# Frozen U2 affected-source review R3

Status: **TERMINAL / noPending**. Verdict: **REVISE — bounded affected SOURCE**. Findings: P1 0, P2 1, P3 0.

One gpt-6-astra LOW reviewer context. No delegates, independent persona pipeline, cross-model proof, fixes, source/test/generated writes, Git staging/commits, installs, DB/provider/browser operations. This report is the sole writable output.

## Scope and intent

Canonical checkout: `/Users/angel/.t3/worktrees/loom/release-kello-001-002-alpha`; branch `refactor/neon-cloud-tooling`; HEAD `586e87791735da2282d2dc120f8e084a13764dca`.

Read `/Users/angel/dev/loom/AGENTS.md`, the governing plan `docs/plans/2026-10-16-1919-refactor-neon-cloud-only-plan.md` (especially R4-R6, KTD2 and U2), both prior reports, and actual parent response in `docs/tasks/cloud-only-current.md`. Intent remains natural generated function/React contracts with faithful runtime row validation, authorized Neon issuance/renewal over HTTP, and ordinary HTTP streaming preserved. No new subsystem or arbitrary-handler conversion is requested.

Personally read complete current `apps/kello/src/tooling/codegen/live-query.ts` and `packages/tests/unit/live-procedure.test.ts`, their HEAD-relative diffs, relevant installed Zod 4.6.5 conversion/check/URL implementations, and the four current parent logs. No `.codegraph/` directory exists. The other two pinned branded-ID files match R2 byte-for-byte and were not reread; their public generated-client proof assessment remains attributed to R2. R1's 69-path coverage is historical, not this reviewer's personal coverage.

Compared R2's recorded guard/finding with current schema-level and check-level pattern flag refusal before conversion. Removing the new regex test in memory reconstructs R2's exact test hash `6b1a9f7496837c4ad80385f1b6e39830c533416ef7f5ebe03de43043f9ed0953`. A guessed in-memory reconstruction of the old guard formatting did not reproduce R2's source hash; no byte-exact historical source diff is claimed without that snapshot. Current complete source, actual HEAD diff, R2 report pin and guard description were inspected; no drift was silently adopted.

## U2-R3-1 — P2: URL format options still disappear during conversion

Location: `apps/kello/src/tooling/codegen/live-query.ts:25-49` (source/check option acceptance), with string acceptance at lines 67-74 and generated reconstruction at line 183. Confidence: high; independently reproduced against the pinned source and installed runtime.

The guard rejects `pattern.flags` but accepts URL format definitions and checks without validating their `protocol`, `hostname`, or `normalize` options. Installed Zod serializes these as only `type: "string", format: "uri"`; reconstruction uses plain `z.url()`. Consequently supported-looking flat scalar contracts can still produce weaker validators or different output values.

Exact scenario:

```ts
const rows = z.array(z.object({ text: z.url({ protocol: /^https$/ }) }));
const generated = new Function("z", "return " + liveRowsSource(rows))(z);
const input = [{ text: "http://example.com" }];
rows.safeParse(input).success;      // false
generated.safeParse(input).success; // true
```

The same mismatch reproduces for `z.string().check(z.url({ protocol: /^https$/ }))`, covering the check-definition path as well as the source-schema path. These regexes have no flags; the new flag guards cannot catch the lost option. A hostname restriction likewise rejects `https://other.example/path` in the authored validator but accepts it after generation. With `z.url({ normalize: true })`, authored output for `https://EXAMPLE.com:443/a/../b` is `https://example.com/b`, while generated output remains the original string.

Causal installed-source evidence: `packages/examples/next/node_modules/zod/src/v4/core/schemas.ts:510-513` declares those options; lines 623-648 enforce hostname/protocol and apply normalization. `src/v4/core/json-schema-processors.ts:129-174` maps URL to URI and emits format/pattern information without these options. `src/v4/classic/from-json-schema.ts:510-513` reconstructs URI using `z.url()` without the original options.

This is the same R4/KTD2 runtime contract fidelity class as the previous findings. It permits publishing a row rejected by its declared schema; no separate authorization bypass or provider failure is claimed.

Required parent correction: refuse unsupported URL options before conversion on both source and check definitions, or preserve them through the existing supported generation path with demonstrated equivalent semantics. Add a regression for the HTTPS-only rejection-widening case and normalization refusal/preservation. Keep the existing flat scalar subset and product; no generic validator framework is needed.

## Prior findings, responses and regression assessment

- **U2-R1-1:** Original field/row/array refinements, trim/lowercase, coercion and explicit transforms were silently omitted. Parent added recursive positive schema/check validation. Current source rejects them; reviewer in-memory probes independently confirmed field/row/array refinement, trim, lowercase and coercion refusal. The original concrete cases are resolved. The broader representability promise remains blocked by U2-R3-1.
- **U2-R2-1:** Original `/^[^a]+$/i` rejected `A`, while generated validation accepted it because flags disappeared. Parent now refuses flags on both source definitions and check patterns before JSON conversion. Reviewer independently confirmed flagged generation refuses and unflagged `A` is accepted. The actual new regression additionally asserts original rejection and unflagged `a` rejection. This finding is resolved with meaningful behavioral regression coverage.
- The new guards target unrepresentable options at generation and do not alter `.live()` function authoring, SQL query behavior, HTTP authority or streaming. No arbitrary new product narrowing was found beyond refusing unsupported mappings. Existing UUID/bounds and framework-ID tests remain intact.
- R2's jobs-storage restoration to `Id<"files">` and public generated React inference proof remain unchanged by matching hashes. R2's no-new-brand-defect assessment is carried forward as attributed evidence, not newly executed type proof.
- R1's source observations about genuine trusted provider login, frontend cookie bridge, restored Next live declaration, managed-secret release identity, HTTP streaming deadline/finalization, SQL authorization, renewal and replay remain historical source conclusions. This correction does not reopen or independently reapprove those implementations.

## Execution and evidence limits

Reviewer executed read-only Git/source/log/hash inspection and two bounded in-memory Bun probe commands (both exit 0). The probes evaluated actual `liveRowsSource` output using installed Zod; no files or external resources were acquired. No test suite, build, generation, compiler or lint was rerun. A lightweight memory registry search yielded no current R3 evidence and was not used for the verdict.

Inspected parent logs:

- `/private/tmp/kello-u2-regex-red.log`: 13 passed / 1 failed, specifically the new flagged-pattern generation-refusal assertion.
- `/private/tmp/kello-u2-regex-green.log`: all 14 passed.
- `/private/tmp/kello-u2-regex-types.log`: three app tsconfig commands, no diagnostics; exit 0 is parent-attributed.
- `/private/tmp/kello-u2-regex-lint.log`: four test-only Function-constructor warnings, no errors; exit 0 is parent-attributed.

Those checks meaningfully cover the regex correction, but contain no URL-option regression and do not rebut this finding. Earlier R1/R2 unit/integration/build/generation/type evidence remains attributed to those reports and parent execution. The prior six-case refusal RED demonstrated at least its first failure, not six independent RED cases.

All prior U6 limits remain: current CI, real Neon Auth sign-in/cookies/SSR/logout/revocation, Realtime initial/update/renewal, membership/external writers, receipt confirmation/replay orders, secret rotation, deployed streaming/disconnect behavior, mounted browser behavior and provider SQL support are unverified here. Historical multiple-Set-Cookie constraints remain provider gates. No full U2/U1-U6 completion, publish, deployment or release acceptance is claimed. This is not exhaustive proof for all Zod options or future versions.

## Initial and closing integrity

All four pins in `/private/tmp/kello-u2-regex-correction-pins.json` matched on initial verification and closing verification immediately before writing this report. HEAD remained the specified commit. The last two hashes also equal R2's pins.

```text
bb82ea42c0ad908218be11c8f78d7a34af9c913108b78d2f9cf85571a8180ed2  apps/kello/src/tooling/codegen/live-query.ts
9a1a192673898d7df90ef21fe0426d83da251b1991a417fbc417b33b2b1475e0  packages/tests/unit/live-procedure.test.ts
e4bdd1b45f37eb8a93a9b3f64e30369adffc8e9d040987d5c9e937182a21cc5b  packages/examples/jobs-storage/kello/contracts/files.ts
b0b0568084c946783de9078fcafeab361fae565062a0fc556eebb99b53226c69  packages/examples/jobs-storage/types/live.test-d.ts
```

Terminal receipt: `{"status":"TERMINAL","noPending":true,"verdict":"REVISE","bound":"affected SOURCE","findings":{"P1":0,"P2":1,"P3":0},"report":"docs/reviews/cloud-only-u2-review-r3.md"}`
