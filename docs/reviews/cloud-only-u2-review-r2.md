# Frozen U2 affected-source review R2

Status: **TERMINAL / noPending**. Verdict: **REVISE — bounded affected SOURCE**. Findings: P1 0, P2 1, P3 0.

One gpt-6-astra LOW reviewer context, applying correctness, implementation, API and security lenses. No delegates, multi-persona pipeline or cross-model proof claimed. Sole authored artifact is this report; no source/test/generated edits, Git writes, installs, DB/provider/browser operations or fixes.

## Scope and intent

Canonical workspace: `/Users/angel/.t3/worktrees/loom/release-kello-001-002-alpha`; branch `refactor/neon-cloud-tooling`; HEAD `586e87791735da2282d2dc120f8e084a13764dca`. The stale integration checkout was not reviewed.

Read root `/Users/angel/dev/loom/AGENTS.md`, the governing `docs/plans/2026-10-16-1919-refactor-neon-cloud-only-plan.md`, R1 finding/response and limits in `docs/reviews/cloud-only-u2-review-r1.md`, and current response in `docs/tasks/cloud-only-current.md`. Intent is R4/KTD2 runtime row validation fidelity and natural generated HTTP/React contracts, with R5 authority/revocation/replay/expiry and R6 ordinary HTTP streaming preserved. This correction does not alter those auth/HTTP implementations.

Personally read complete current bodies of all four pinned files and their HEAD-relative changes. The new type-proof file is untracked, so its complete body is its addition rather than a tracked HEAD diff. Supporting reads were limited to installed Zod conversion/check implementations and the jobs-storage generated type chain. Prior 69-path review coverage remains attributed to R1; no inherited personal body credit or renewed full-U2 clearance is claimed.

## U2-R2-1 — P2: Reject regex flags that JSON Schema drops

Location: `apps/kello/src/tooling/codegen/live-query.ts:27-40`, specifically the unconditional `string_format` check-kind acceptance at line 35. Confidence: high; independently reproduced against pinned source and installed Zod 4.6.5.

The positive allowlist accepts all `string_format` checks without inspecting their format or regex options. Zod's regex check is a `string_format` check. Installed `src/v4/core/checks.ts:780-784` executes the original RegExp, including its flags; `src/v4/core/json-schema-processors.ts:163-165` serializes only `pattern.source`; `src/v4/classic/from-json-schema.ts:575-577` reconstructs `new RegExp(schema.pattern)` with no flags. The existing restricted JSON Schema emitter permits `pattern`, so it cannot detect the already-lost flags.

Concrete causal scenario: a live contract declares `z.array(z.object({ text: z.string().regex(/^[^a]+$/i) }))`. Generation succeeds and emits pattern `^[^a]+$`. For SDK rows `[{ text: "A" }]`, the authored schema rejects the row but the generated browser validator accepts it. Thus the generated live client can publish rows forbidden by the declared contract, the same R4/KTD2 semantic weakening class as R1. This is a validator correctness issue; no separate authorization bypass is claimed.

Reviewer in-memory reproduction, exit 0, with no files/resources acquired:

```sh
bun -e 'import { z } from "./packages/examples/next/node_modules/zod/index.js"; import { liveRowsSource } from "./apps/kello/src/tooling/codegen/live-query.ts"; const rows=z.array(z.object({text:z.string().regex(/^[^a]+$/i)})); const generated=new Function("z","return "+liveRowsSource(rows))(z); console.log(JSON.stringify({original:rows.safeParse([{text:"A"}]).success,generated:generated.safeParse([{text:"A"}]).success}));'
```

Observed: `{"original":false,"generated":true}`. A separate `/abc/i` probe also showed the inverse compatibility failure: original accepts `ABC`, generated rejects it.

Required correction: validate actual regex/check options before conversion and refuse semantics the conversion cannot preserve, including unsupported flags, or explicitly preserve them through a supported representation. Include a regression for the rejection-widening negated-class case above. Do not infer fidelity solely from the check-kind name or converted JSON keys. Parent owns remediation.

## Correction and regression assessment

- R1's concrete custom field/row/array refinements, trim/lowercase and coercion now fail closed. Independently executed in-memory probes confirm refusal. Optional-wrapped refinement and nullable-wrapped trim also refuse, demonstrating recursive inspection. Unsupported nested object output refuses at the flat-row emitter. Optional scalar output accepts an omitted/undefined value in the probe; plain nullable string currently refuses at the restricted emitter, a conservative unsupported mapping rather than silent weakening.
- The installed Zod conversion folds numeric bounds and formats; independent probes retained safe-integer rejection and numeric-bound/invalid-UUID rejection. The actual regression body executes generated Zod validators for valid UUID/length input, bad UUID, too-short and too-long strings, and explicit transform refusal. This is meaningful behavioral coverage, but does not exercise regex flags/options. The six-case refusal loop stops at its first failing case in RED; that RED proves sensitivity to at least the first unsupported case, not six independent pre-fix failures.
- Jobs-storage restores `_id: validators.id("files")`. The generated registry resolves the actual declaration with generated validators; generated `api.d.ts` derives `Client` through `RouterContractClient<PublicContract, RpcCallContext>`; generated React returns `LiveQueryHooks<Client>`, whose live leaf carries inferred rows. The new proof consumes `connection.api.files.list.useLiveQuery({}).data`, assigns `_id` to `Id<"files">`, and requires the wrong-table assignment to error. There is no cast/assertion in that proof or correction to manufacture the brand. The existing generic hook implementation has a router-shape cast, not a new field-brand assertion. The proof guards the full generated public React API rather than a hand-authored substitute. No additional brand defect found.

## Verification provenance and limits

Reviewer performed read-only source/diff/log inspection, installed Zod source inspection and bounded in-memory decoder probes. No full test suite, compiler, generation or build was rerun. No source fixture was modified to demonstrate RED.

Inspected parent logs: `/private/tmp/kello-u2-zod-review-red.log` records 12 pass/1 fail; `/private/tmp/kello-u2-zod-review-green-final.log` records 13 pass. `/private/tmp/kello-cloud-u2-jobs-id-probe/red.log` records TS2322 string versus `Id<"files">`; `/private/tmp/kello-u2-jobs-generate.log` records four generated procedure contracts; `/private/tmp/kello-u2-jobs-types.log` records the compiler command without diagnostics. Main three-tsconfig and lint logs were inspected; lint has three test-only no-implied-eval warnings. Parent reports exit 0 for generation/types/lint; these text logs do not themselves encode every process exit. Build log records successful completion, but predates the type-only helper adjustment as disclosed by the parent. These are attributed results, not reviewer execution or rebuttal of U2-R2-1.

No additional P1/P2/P3 finding retained in the bounded correction. R1's wider source conclusions and all cloud/browser/CI/provider/release limits remain unchanged. No new auth/HTTP audit, real SDK delivery, revocation, replay, expiry, hosted streaming or U6 acceptance is claimed. Supported-subset probes are not exhaustive proof for every installed Zod option or future version.

## Closing source integrity

All four supplied SHA256 pins matched on initial successful verification and closing verification immediately before writing this report; HEAD remained unchanged. No drift was adopted. Manifest: `/private/tmp/kello-u2-review-correction-pins.json`.

```text
899e6d5d72c392f19f7b4cd8ee800cc7e1ce36b853d24556c0ac44594f4cbaed  apps/kello/src/tooling/codegen/live-query.ts
6b1a9f7496837c4ad80385f1b6e39830c533416ef7f5ebe03de43043f9ed0953  packages/tests/unit/live-procedure.test.ts
e4bdd1b45f37eb8a93a9b3f64e30369adffc8e9d040987d5c9e937182a21cc5b  packages/examples/jobs-storage/kello/contracts/files.ts
b0b0568084c946783de9078fcafeab361fae565062a0fc556eebb99b53226c69  packages/examples/jobs-storage/types/live.test-d.ts
```

Terminal receipt: `{"status":"TERMINAL","noPending":true,"verdict":"REVISE","bound":"affected SOURCE","findings":{"P1":0,"P2":1,"P3":0},"report":"docs/reviews/cloud-only-u2-review-r2.md"}`
