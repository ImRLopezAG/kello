# Frozen U2 review R1

Status: TERMINAL / noPending. Verdict: **REVISE — SOURCE**, one confirmed P2 finding; no P1 or additional P3 findings retained.

Reviewer: one gpt-6-astra LOW context, applying correctness, implementation/requirements, API and security lenses. No nested delegates or independent multi-persona/cross-model pipeline is claimed. Parent owns remediation, verification and canonical commit.

## Scope and integrity

Canonical checkout: `/Users/angel/.t3/worktrees/loom/release-kello-001-002-alpha`.
Branch: `refactor/neon-cloud-tooling`.
Base and current HEAD: `586e87791735da2282d2dc120f8e084a13764dca`.
Reviewed working-tree changes against that HEAD, including untracked new-file bodies, within the exact 69-path union `/tmp/kello-u2-review-paths.txt`. The supplied initial list actually contains 33 unique paths, the R2 list 52; their union is exactly 69. This count discrepancy does not alter the reviewed union.

The R2 manifest matched all 52 files on initial verification, intermediate verification and immediately before report creation. Manifest SHA256: `e310db44b1fd44939966ee7ae56b232a20ca55e31f6bc7a3165cd152421beafb`. No R2 source drift or HEAD drift was observed or adopted. The other 17 paths have observed hashes below, not a claim of comparison against a supplied historical content manifest.

Governing plan: `docs/plans/2026-10-16-1919-refactor-neon-cloud-only-plan.md`, SHA256 `00c9015fb3edb034a39e33346f29bd1f8e3fcaaf4c7379fb582679be3df87147`. Read its product requirements, KTDs and U2 scope, plus `/Users/angel/dev/loom/AGENTS.md` and both handoffs. The stale bound integration checkout was not inspected or edited. No source, tests, package/lock files, generated artifacts or unrelated WIP were changed. This report is the sole authored output.

Intent: generated ordinary RPC and live issuance/renewal use HTTP; official Neon SDK owns live delivery; declared function-folder live contracts retain typed inputs/rows, supported pagination, SQL authorization and trusted current session authority. U3/U4 legacy deletion and U6 actual cloud acceptance are separate gates.

## Finding

### U2-R1-1 — P2: Refuse Zod checks and transformations that JSON Schema silently drops

Location: `apps/kello-cli/src/tooling/codegen/live-query.ts:24-27`, especially line 27; generated reconstruction at line 119. Confidence: high, reproduced against the frozen source and installed Next Zod runtime.

The new Zod branch treats successful Standard JSON Schema output conversion as proof that all runtime semantics are representable. Zod silently omits custom `.refine()` checks and string transformations such as `.trim()` / `.toLowerCase()` from that output. The subsequent `emit()` allowlist sees only the already-weakened JSON Schema, so it cannot detect the lost behavior; `z.fromJSONSchema()` then builds a different validator. This violates the explicit fail-closed promise for unsupported refinements/codecs and the R4/KTD2 requirement to preserve runtime output validation.

Concrete scenario: declare live rows as `z.array(z.object({ text: z.string().refine(x => x === "allowed") }))`. Generation succeeds. The authored schema rejects `[{ text: "forbidden" }]`; the generated browser schema accepts it. `createNeonLiveClient` validates incoming SDK rows with this generated schema before publishing them, so the live UI receives data that its declared output contract rejects. Separately, a field declared with `.trim()` returns `"padded"` from the original schema but `" padded "` from the generated one; `.toLowerCase()` similarly returns `"upper"` versus `"UPPER"`. These transformations are accepted despite the stated arbitrary-transform refusal.

Smallest fix: restrict the Zod source-schema path to a positively supported, validation-preserving subset before accepting the converted JSON Schema, rejecting custom refinements and value-changing string actions that cannot be reproduced. Keep supported UUID/bounds checks and exact framework ID branding. Add regressions for field and row refinements and built-in string transformations, asserting refusal (or proven semantic preservation), alongside the existing explicit `.transform()` test. Do not merely expand the emitted JSON-key allowlist: the omitted checks are absent by then.

Read-only reproducer run by this reviewer from the canonical cwd, exit 0, no files or resources acquired:

```sh
bun -e 'import { z } from "./packages/examples/next/node_modules/zod/index.js"; import { liveRowsSource } from "./apps/kello-cli/src/tooling/codegen/live-query.ts"; for (const [name, field, input] of [["refine",z.string().refine(x=>x === "allowed"),"forbidden"],["trim",z.string().trim()," padded "],["lowercase",z.string().toLowerCase(),"UPPER"]]) {const rows=z.array(z.object({text:field}));try {const source=liveRowsSource(rows);const generated=new Function("z","return "+source)(z);console.log(JSON.stringify({name,original:rows.safeParse([{text:input}]),generated:generated.safeParse([{text:input}])}));}catch(e){console.log(name,"refused",String(e));}}'
```

Observed results: refine original `success:false`, generated `success:true`; trim original `padded`, generated `padded`; lowercase original `upper`, generated `UPPER`. An earlier single-case probe independently produced the same refinement mismatch. These are local decoder probes, not cloud acceptance.

## Prior correction observations challenged

| Parent observation                                 | Candidate evidence and disposition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No genuine trusted login                           | All six application configs now install `createNeonLoginResolver`. It uses installed SDK cookie extraction/name parsing, a fixed HTTPS provider get-session endpoint, cache/refresh disabling query flags, actual provider user/session ID and expiry, and `captureTrustedLogin` identity/expiry checks. No generated login ID or local registry. Native HTTP tests exercise actual JWT verification with a doubled provider response. Source correction supported; real provider acceptance unrun.                                                                                                     |
| Frontend-host cookie cannot cross hosts            | Next/Start browser service URL is frontend origin; explicit routes call a server bridge to configured HTTPS backend. The bridge filters cookies through the SDK, preserves bearer/protocol headers, rejects a present foreign Origin before fetch, disables redirects/cache and removes response Set-Cookie. Backend origin allowlist and JWT verification still apply. The topology test deliberately withholds cookies on direct backend calls and observes refusal. Missing Origin does not grant cookie-only authority: native RPC still requires bearer verification and protocol/version headers. |
| Next accidentally became ordinary query            | Next contract and function now use `.live()`, explicit owner+issuer SQL predicates, deterministic ordering and limit. UI imports generated React binding and uses `api.examples.watch.useLiveQuery()`. Finite `notes` stays available for SSR.                                                                                                                                                                                                                                                                                                                                                          |
| Zod and ID branding unsupported                    | Framework ID action recognition uses a WeakSet of exact framework-created actions; arbitrary Valibot transforms still refuse. Type proof retains distinct project/task brands. Zod scalar/UUID support is real, but semantic preservation is incomplete: finding U2-R1-1.                                                                                                                                                                                                                                                                                                                               |
| Secret rotation absent from release input identity | `releaseInputHash` includes sorted managed Realtime variables under the existing activation-token HMAC before release database/journal preparation. Deployment retrieves readiness/secret for selected project/branch, rejects pending/empty secret, injects through managed variables and checks selected target against locked database target. Rotation regression asserts identity changes without plaintext output. Source correction supported; deployed rotation acceptance unrun.                                                                                                               |
| HTTP stream deadline/finalization                  | Generated clients select the existing HTTP transport; its total 30-second deadline remains. Native iterator tests characterize early-break cleanup and deadline-triggered finalization. No timeout relaxation requested or inferred. Tests use cooperative generators; they do not prove arbitrary uncooperative generator teardown or hosted disconnect behavior.                                                                                                                                                                                                                                      |

## Requirements and security assessment

- R4/U2: one generated HTTP transport for ordinary calls and issuance; SDK live client only when declarations require it; discovered realtime URL fallback and clear missing-config refusal. Live capabilities are excluded from ordinary query utilities. Six examples have declared live surfaces and explicit deterministic SQL access predicates. Tasks membership is part of the live project join; ranked search remains an ordinary explicit read. Pagination input validation and changed-input query fingerprint are exercised by the live-procedure tests; hook input changes replace the subscription. Runtime row fidelity remains blocked by U2-R1-1.
- R5/U2: resolver binds provider session user/ID/expiry to separately verified issuer/subject, rejects tenant-bearing identities until mapping exists, forwards only the provider session token upstream, and observes invocation cancellation. Session endpoint requires trusted login when live configuration is active. Issuance recaptures identity/expiry; renewal re-enters HTTP authority and query construction. SQL predicates, rather than middleware or transaction-local identity alone, restrict live rows. Existing capability expiry, SDK renewal, disposal, receipt scope/authorization and confirmed/unknown checks were traced in supporting source; transaction/replay implementation is not replaced by U2. No new independently supported authorization bypass was found.
- R6/U2: ordinary calls, explicit reads and async iterators remain HTTP procedures. SSR cookies are request-scoped and absent from hydration; generated clients retain transport disposal. Proxy passes streaming bodies and the Request signal through native Fetch. No provider/browser execution was used to claim those deployment behaviors accepted.
- Managed secret names are reserved in application/release environment and entrypoint credential alias checks. Secret acquisition errors use fixed messages. No plaintext secret is emitted by the new public codegen or release identity code. No unrelated legacy-removal requirement is charged against U2.

## Coverage and command provenance

Source review covers all 69 union paths: actual HEAD-relative diffs and current complete bodies, including new files. Supporting reads followed native authority, SDK cookie parsing/get-session, live issuance/projection, client renewal/confirmation, React hook lifecycle and the component forwarding seam. This is complete scoped source coverage in one context, not exhaustive runtime verification or a complete independent audit of every unchanged dependency. No `.codegraph/` directory existed in the canonical checkout.

Reviewer commands were explicit-cwd read-only `git rev-parse`, `git branch`, scoped `git diff`, `git ls-files`, `git status` for the report path, `cat`/`sed`/`rg`, Python path-union/hash checks, `shasum -a 256 -c`, and two in-memory Bun decoder probes. A guessed supporting filename `core/react/live-functions.ts` did not exist; the actual `core/react/live-query.ts` was located and read. No builds, installs, broad suites, servers, provider calls, PG acquisition or browser runs were performed. All report-side hash checks passed.

Attributed author evidence, not reviewer execution: 63 unit tests / 13 files, 21 e2e / 110 assertions, all six examples generate+typecheck, Next+Start builds, core build/typecheck, tests typecheck and format/lint checks. Inspected the actual deciding test bodies and unit/e2e/lint log results. Five lint warnings are disclosed (two unbound-method, three no-implied-eval); no lint errors. Parent evidence: 30 focused unit tests, separate one release test, 21 e2e / 110 assertions; main unit/e2e logs were inspected, separate release result remains attributed to the handoff. Build/typecheck/generation results and RED logs are attributed to `/tmp/u2-r2-handoff.md`; those commands were not rerun and every build/RED log was not independently audited.

The Zod tests at `packages/tests/unit/live-procedure.test.ts:365-376` verify UUID, length bounds and explicit `.transform()` rejection. They do not cover the silently omitted refinement/string-action cases reproduced here. Green supplied suites therefore do not rebut the finding.

## Remaining U6 limits

Current-revision CI, actual disposable Neon Auth sign-in, cookie delivery, SSR, logout/revocation, Realtime initial/update/renewal, membership changes, external writers, receipt confirmation/replay orders, deployed secret rotation and mounted browser behavior remain unverified here. The handoff's historical service-host multiple-Set-Cookie constraint remains a provider gate, not a newly inferred U2 source defect. Real Neon query support for the example joins/projections must be accepted in U6. No DB skips or offline doubles count as those gates. This verdict does not authorize publish or claim U1-U6 completion.

## Observed source SHA256

The following hashes identify the exact 69-path source surface at report creation. R2's 52 supplied hashes were revalidated immediately before this capture.

```text
805057ec7b64751d59de1149c3bc2974a79047cd36182e2eaebbcdde87565367  apps/kello/src/core/adapters/neon/index.ts
8463532fa7fd1d5748d0b2854c30f87beab6ad296e30831b9f25bea8e1e1f9c9  apps/kello/src/core/adapters/neon/neon-login.ts
40fd7d39fbcb0c5fc4d5ede13058ef131ffd3583c14fb04db69e340f0e293464  apps/kello/src/core/adapters/neon/rpc-http.ts
cfdefb5fc38b071ff418cdbf0347640145b9fe7ac7f71266d689103821a1348b  apps/kello/src/core/client/auth-lifecycle.ts
1e66e70295164ba44b8d4dc214516f9ab071c1e57136a134f648f6a19c9d0887  apps/kello/src/core/client/rpc-http-transport.ts
162a54e2a351a1fb67a29322c50fe8a3cce292b7cf9b3edb2addcefe3c056ab7  apps/kello/src/core/client/rpc-transport.ts
0e8c1ef5ec1fab2944d15a78b796e1531def5a529f09db54e1abb4c427bff303  apps/kello/src/core/client/server-session.ts
180de5d62154be9dd8475f358f9db56216c5951865ad9a3ab272c134fbef1e7d  apps/kello/src/core/client/verified-session.ts
28a0ce768c94ce06e359ce56b04aaeeb0e2db0f0576e73237513b66286b6cac2  apps/kello/src/core/next/server.ts
9877f6c96d7eab6e97df01abd8fdd998fdc2d1b6abcd923c0482c123ef0b98d9  apps/kello/src/core/schema/define-schema.ts
50d59fc2e6e9d5046753685a77889cf1f727cb019e09208c4301bee443311709  apps/kello/src/core/server/application/definition.ts
0d7cb8f4f27971414a005783577d3aafd0871e41750441a53810cc9524818e46  apps/kello/src/core/server/auth/login.ts
2526c34f34d6f183337d00423270279d5854b798496c0e69de6de9b63d3afbb3  apps/kello/src/core/server/auth/neon-rpc.ts
394faffefd6579a80ea68ce2a73029881b781a48dc1e0842d48c09a384340b76  apps/kello/src/core/server/rpc-runtime.ts
76c3590db1b91117f5d2b8c1daf32ba8f9e7059ed557b17525b28e0a10d422cf  apps/kello/src/core/start/server.ts
4ae9b9d503b4ef5ea28ad9dd737039d4edf1900b08e7e349d3569f4d39a8c7f0  apps/kello-cli/src/tooling/codegen/application.ts
f1131d1bec7be89a38cf1173a90d9589ec95c694d89546c89206009736ebe334  apps/kello-cli/src/tooling/codegen/live-query.ts
3548395ff44028a49b1777008b5b498ccd563b49bcad6196c6ed1e74e05ee2e4  apps/kello-cli/src/tooling/deploy/neon/entrypoints.ts
97572ea184a0d4fcf2e64f4f0698848c793e759b254df762fb51f8ee79c8b473  apps/kello-cli/src/tooling/deploy/neon/environment.ts
bec263b3142ea2205c0bd6beb9007d82975042179e5971e914209b2a35f5fc25  apps/kello-cli/src/tooling/deploy/neon/prepare-release.ts
76e4146b93d615562acddad3a44185c86ee6f31499d6a91c4267721a1eab2dc6  apps/kello-cli/src/tooling/neon/api.ts
c67254ec0035a205020af9acdbfe59169385f14071e69a2cb96e5c86a9adb795  packages/e2e/integration/live-functions-codegen.test.ts
84e0ae973ebffcafba604b7cb75b9720eb4b129c0eec36767cbca6dd8fd822d0  packages/e2e/integration/realtime-cli.test.ts
94570ee1e0cb0f18fbc16154633420451a14c02331622065c47130edaebab003  packages/e2e/integration/server-client.test.ts
6f05ced3bd468c6868c712e9f0c669793497ff2f1121947f52d0ffba159ab5fc  packages/examples/components/kello/app.config.ts
c7da297130e33518be446569f5ddecb87b9ac1b2fe7b03bc5b9ad686f632fdb6  packages/examples/components/kello/components/journal/contracts/entries.ts
8efd0bfc5586593a456d026c9d5d660f5ba7228d201b89eb711bfb8ab2d077ea  packages/examples/components/kello/components/journal/functions/entries.ts
13d91c167fd94b0625b2781c7973a270c185bb08f903fb0b514e4128a62782d8  packages/examples/components/kello/contracts/journal.ts
b85c716860ecbda25fd6eaea60f79bf67b56b755187feab8c9bef47c260fb4b1  packages/examples/components/src/main.tsx
e9631bc4f181eb9b56726df7bfba2e02d0f597b1b27066f92e5edceba83aca10  packages/examples/integrations/kello/app.config.ts
dd9f405cf3daf5dfde2586cda0c83345975d873704f5b0a91189d81aa4657fd2  packages/examples/integrations/kello/contracts/examples.ts
f35b46160c27b8873ec21bbf8edb7ffdf723fda0ba2d31aa185af31766a94205  packages/examples/integrations/kello/functions/examples.ts
b3ea8117965494c84f3c0124a80ba7040e7615f7278e5d0cc339bab754d0c4eb  packages/examples/jobs-storage/kello/app.config.ts
dd0e297b46777ae4a819194c31acf09754d890aa60c59a28afad947945691310  packages/examples/jobs-storage/kello/contracts/files.ts
f35cd272a94f59e88405325d24e3e98d5cd513f62bc5f8a590ffff0cc62d9580  packages/examples/jobs-storage/kello/functions/files.ts
702aa850c86173ac2e843a121b05fb0179a7ba7d4012f255a783656392ddf008  packages/examples/jobs-storage/src/main.tsx
cbf22c6517baaaa66681501d317aa9d7a04fd9b158a87956a274377639102a43  packages/examples/next/.env.example
9ddf952a44e2d5045cf5529318c216ff73dfe229aae4d72bc1d46e2909e26c94  packages/examples/next/README.md
10fe097e7d4b0dd1e051d4e8b8abdd9822e2c71557083b330e25754aa7a498dd  packages/examples/next/app/api/auth/[...path]/route.ts
e76653cfaabb1f7f8f6bd59248b51e86c94b5177fdb515cf745e03d5c3e367ef  packages/examples/next/app/api/kello/[...path]/route.ts
bbd8d002668b0a993e13bfb5fdea012a8ebbcd2811722283cf8b621f9c2acb22  packages/examples/next/auth.ts
d1fbc6b99622aa8ca13fdbea322a1023e48df5c1e3ab939b73964b96402dc09c  packages/examples/next/components/notes.tsx
7c948be87317344bc31a903de4aa798e6944603bfa0eb785f8333626d4c6986e  packages/examples/next/kello/app.config.ts
2e07c67bcfea37c22c8c677ec0bfa1c928dca7de769f66a43df0d1c568051f5b  packages/examples/next/kello/contracts/examples.ts
7c7b5472036662afb07e4f1aefe8f14c30db0c6802cec88fa6289b88d88f2e81  packages/examples/next/kello/functions/examples.ts
6cb232ef51a1a0b8ddfcc5d029dd2a25b4dff4f229d446e5a75f1600876455cb  packages/examples/next/lib/kello.ts
c5de28803940044da4b7a376348ac9059f18e3ec85a04593ffc7d9373742255c  packages/examples/next/types/client.test-d.ts
404e1335959801940d75ff6bbfc8dadcd4a1356015d0911b272a5cc827d33ca7  packages/examples/start/.env.example
4c7c2c60ea9d0236b496624ff307554e00d98c2dd50799c70f52e7b0351b47d4  packages/examples/start/README.md
c5e6cf8ca4cf07767a2662fda55c011871a0099e4454d80e5d5a081c2daae9a2  packages/examples/start/kello/app.config.ts
c2f38f5a9b3e56cbbaca5ea029290c1d65864dbae9591faf0ccbc3134df88e10  packages/examples/start/kello/contracts/examples.ts
8845ceba7b0013b4af21ce50ab701cc84edd386366d88734d83b11a4f4aa601b  packages/examples/start/kello/functions/examples.ts
a1ab28c4a390bd61193c63f340600fc3f99611b25c49d704e1f267ee1abc681c  packages/examples/start/src/auth.ts
20244bce6a0075e56c247537f00211c86a940d2e4e4859afa262505e4dbe2d97  packages/examples/start/src/components/notes.tsx
67268d9f3827c51bf6663ae6ca655dfd5eff79b64f3b25bd23c96409868c5c9b  packages/examples/start/src/lib/kello.ts
05e2c476a98bb14e65f71cd5403bca6376479f15f32c84b7b751a5c6b2bbb559  packages/examples/start/src/routes/api.auth.$.ts
841b48028463392626e90077d3543884f96a5ded4dbbe526f96d99017744378d  packages/examples/start/src/routes/api.kello.$.ts
5fd6306615a1ec8089cffd955744130d3fe19b9d087e351b327c37c89fd5b1c6  packages/examples/start/types/client.test-d.ts
02bc372917fea55dcfaf141d76ba55b975e57e34bbf01fe47c3587b72b7085f9  packages/examples/tasks/kello/app.config.ts
9c23844fe6ba52535f6e9e2b759ce7a2e5d57e1b57fa1ab679f5b7280b83dcab  packages/examples/tasks/kello/contracts/projects.ts
f269feb576cb9bc4a5d687ee3846908add4a016f6185476fc32909c8f0221b3c  packages/examples/tasks/kello/contracts/tasks.ts
bee7793362339e2b7c22da9746ef3be1ba2a3d6d96212f90405b5ffa146fef51  packages/examples/tasks/kello/functions/projects.ts
5a8ab60d1e69d630cfffd1e629c476b270292490865572ea69807a848c1a2aba  packages/examples/tasks/kello/functions/tasks.ts
ae041cdca0c1911ae589c93addac509081449c9158710108f4f11d4ca1292d03  packages/examples/tasks/src/main.tsx
703f052fe93bbab849c1961f23b45739c1c58c4630bc3d16d2de183b0ac9bc5f  packages/examples/tasks/types/live.test-d.ts
f9eb3c9c0035d82b0de56d18c1ed784dce602a27329c9d0225022d8317d0e442  packages/tests/unit/live-procedure.test.ts
71aa833539fc240fb75bc28718efebf5e5c774a86f8c03461680c94e81194ceb  packages/tests/unit/neon-realtime-http.test.ts
03feeb28b42acd7bae3258f17a6f682e59ba70b25e26839158955578bb5ebadc  packages/tests/unit/release-live-environment.test.ts
9f89ea1b4bc75070c385edc2dc1b81bb7a8be31eed6af726a10fcb429bd7e3fd  packages/tests/unit/server-session.test.ts
```

Terminal receipt: `{"status":"TERMINAL","noPending":true,"verdict":"REVISE","bound":"SOURCE","findings":{"P1":0,"P2":1,"P3":0},"report":"docs/reviews/cloud-only-u2-review-r1.md"}`
