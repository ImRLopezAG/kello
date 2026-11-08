# Native oRPC Neon acceptance — in progress

This is an execution record, not a completed acceptance claim. U12's cross-runtime, performance, upgrade and cleanup gates remain open.

## Verified target

Authenticated CLI inspection on 2026-09-24 confirmed project `late-moon-69483649`, name `kello`, region `aws-us-east-1`, PostgreSQL 18. The older shortened project ID in conversation is not used. Current [Neon Functions documentation](https://neon.com/docs/compute/functions/overview) confirms this region supports Functions; the installed skill's Ohio-only restriction is stale.

Acceptance uses a project-scoped temporary API key and disposable branches. Credentials are kept outside the repository and are not included here. Existing branches are not modified.

## Tasks: real Neon Auth and Functions

- Branch: `br-nameless-cloud-aw8zphwm`, `kello-acceptance-orpc-tasks`; expires 2026-09-25 22:07 UTC.
- Compute: 1 CU; idle suspend 300 seconds. Function runtime: Node.js 24, 2048 MiB.
- Service function: `sabbe1794c9059cbbfc6`, deployment 2. Worker: `wabbe1794c9059cbbfc6`, deployment 2.
- Protocol: `kello-orpc-2`; realtime: default polling. This run makes no notification latency claim.
- Executed: actual frontend signup, authenticated project/task writes, live results, sign-out and subsequent sign-in, retained task visible.
- Result: one hosted test passed, zero skips; about 50 seconds. Evidence: `/tmp/kello-u12-neon-auth.log`.

Provider prerequisite found during setup: Auth enablement failed with `permission denied for database neondb`. Inspection showed the managed `neon_service` role lacked database CREATE authority on the disposable schema-only branch. Granting CREATE on that branch's `neondb` to `neon_service` allowed Auth provisioning. Kello's runtime role remains restricted; no public grant was added.

## Storage: real bytes, events and durable processing

- Branch: `br-orange-brook-awq4kx1v`, `kello-acceptance-orpc-storage`; an owned data child of main, because the project's root-branch limit prevented another schema-only root.
- Release: `2a019129355c1992ed5210de4531a67be8011c17443f69345de8d86d0a4fb3fc`.
- Service: `s2a019129355c1992ed5`, deployment 2; worker: `w2a019129355c1992ed5`, deployment 2. Same region, compute and runtime settings as Tasks.
- Actual Neon Auth signup, signed uploads to all three example buckets, provider object-created delivery, scheduled worker delivery, successful processing after one attempt, retry success after two attempts and terminal failure after three attempts all passed. No manual worker invocation substitutes for provider delivery.
- Downloaded bytes matched the uploaded text. Sign-out/sign-in retained the authenticated catalog.
- Result: one hosted test passed, zero skips, 185 seconds. Evidence: `/tmp/kello-u12-neon-storage.log` and `/tmp/kello-u12-neon-storage-receipt.json`; completed 2026-09-24 22:17 UTC.

Both runs used oRPC `2.0.0-beta.40`, Effect `4.0.0-rc.117`, Drizzle `1.0.0-rc.4` with the reviewed rename patch, Neon SDK `6.1.0`, config `1.7.3`, config-runtime `1.6.3`, and Functions `0.11.0` from the workspace lockfile. These results establish application behavior, not the latency or resource gates below.

## Local baseline measurements

An isolated archive of pre-redesign commit `b8ddb6a` was installed with its frozen lockfile and built on the same machine as native commit `c4a859a`. Measurements use each example's normal production build and three invocations of its typecheck command. This is local tooling evidence, not hosted runtime performance.

| Example        | Baseline JS / gzip bytes | Native JS / gzip bytes | Baseline generated declarations | Native generated declarations | Baseline typecheck ms | Native typecheck ms |
| -------------- | ------------------------ | ---------------------- | ------------------------------- | ----------------------------- | --------------------- | ------------------- |
| Tasks          | 290,104 / 88,376         | 313,550 / 94,564       | 3,307                           | 2,399                         | 613, 382, 463         | 413, 423, 452       |
| Upload Catalog | 289,164 / 88,659         | 321,470 / 97,706       | 2,582                           | 2,162                         | 470, 494, 343         | 388, 359, 353       |

Declaration measurements include the current generation's API, internal, service and worker declarations; tiny stable re-export wrappers are counted separately in `/tmp/kello-u12-size-typecheck.json`. Browser totals include all emitted JavaScript assets. The changed client surface replaces the custom live client with native oRPC WebSocket framing and TanStack ownership; Upload Catalog also retains its storage control-plane client. These are aggregate deltas, not a module-by-module size attribution. Raw JS increases are 8.1% and 11.2%; gzip increases are 7.0% and 10.2%. Typecheck medians are 463→423 ms and 470→359 ms. None exceeds the 20% acceptance threshold in this initial comparison. Final cleanup still requires a refreshed measurement of the shipped surface.

## Cross-instance measurement correction

The first short test connected all 100 subscriptions without client errors but failed its separate HTTP metric assertions: those reads showed idle state. [Neon's runtime model](https://neon.com/docs/compute/functions/reference/runtime-limits#concurrency) permits separate isolates for concurrent requests, each with independent module state. The fixture now reads test-only, authenticated diagnostic procedures over each subscription's existing WebSocket peer. The failed attempts are not counted as passing acceptance; notification latency, listener recovery and cleanup remain under test.

The corrected short run passed on 2026-09-24 at 22:32 UTC: one test, zero skips, 53 seconds including deployment. Release `e7383637955ef404d048434e3768aa0e63b216361373c849d6086f16c2ac0151`, Functions `kellolivea` and `kelloliveb`, deployment 1 each, on the owned Tasks branch. Their authenticated metric responses identified two distinct isolate UUIDs, each with 50 subscriptions, one listener, at most four concurrent evaluations and a batch no larger than 50. Both recovered after terminating their restricted-role PostgreSQL LISTEN backends. All 100 direct SQL writes became visible. After unsubscribe both reported zero subscriptions/evaluations/queued entries and idle listeners; PostgreSQL confirmed zero LISTEN backends. Pools reported four clients with no waiters; idle-pool reporting still needs database-side confirmation in the full run. The database reported 20 connections against `max_connections=450` after the test.

The ten-second sample had p95 lower/upper commit-to-observer bounds of 255/320 ms (maximum 542/605 ms). One monotonic coordinator clock brackets SQL commit acknowledgement and Playwright's browser-observation callback; the upper bound includes SQL request time and callback delivery. This is explicitly a smoke sample, not the required ten-minute workload, warmup, hot-table comparison or three-run performance gate. Evidence: `/tmp/kello-u12-live-smoke3.log` and `/tmp/kello-u12-live-smoke-receipt.json`. Cloud resources remain owned by this run and pending cleanup.

## Remaining acceptance

- Two independent service instances, direct SQL invalidation, listener interruption and reconnect.
- Matched baseline/new performance and resource measurements required by the plan.
- Populated legacy branch upgrade and deliberate stale-client outcome.
- Removal of this run's branches and revocation of its temporary API key; cleanup is not yet performed.

## Full notification workload, first successful run

On 2026-09-24, the owned Tasks branch ran 100 subscriptions across `kellolivea` and `kelloliveb`, with 30 seconds of write warmup followed by 6,000 direct SQL updates in 600,164 ms. Release `c5f8efb1fdb4de285b09d73b7d314316530ee4be66bfacfe7432a0d26d5e8024` passed the hosted harness with one test and no skips. This precedes the subsequently committed OpenAPI/storage-scope corrections and is not final-release acceptance.

Commit-to-browser bounds use one coordinator monotonic clock, bracketing the SQL acknowledgement. Lower/upper p50: 123/215 ms; p95: 291/378 ms; p99: 448/556 ms; maximum: 810/883 ms. The p95 upper bound satisfies the 500 ms absolute gate. The 50% improvement comparison and repeated timing runs remain pending.

Both listeners recovered after forced disconnection. At unsubscribe, active/evaluating/queued counters were zero, listeners were idle, no listener backend remained, and eight attributed runtime pool clients were idle with no open idle transactions. Database-wide occupancy was 19 of 450 available connections. Sampled heap peaks were approximately 55/56 MB; initial samples were 28/24 MB and final samples 35/43 MB. The full sample series remains available for the repeated-run growth analysis; these endpoints alone do not establish a leak or its absence.

Raw receipt: `/tmp/kello-u12-notify-spread-3.json`; summarized sample series: `/tmp/kello-u12-notify-spread-3-summary.json`. Earlier full attempt failed a role-wide eight-client assertion because that role also serves other deployed functions; it is retained as failed. The corrected harness attributes measured service connections with PostgreSQL `application_name` and independently checks each runtime's pool metrics. A separate rerun failed before workload startup because the issuer URL briefly served a previous public key; the fixture now waits, under its existing 90-second deadline, until the deployed key is actually served.

## Hosted OpenAPI and invocation storage — September 24

The dedicated REST fixture passed on project `late-moon-69483649`, branch `br-orange-brook-awq4kx1v`, `aws-us-east-1`, release `65ac99ac6abc9f11c37b213fac4c664eae077d13fc10f542b457512bb3e45117`. It uses the real Functions/storage runtime and a test issuer; real Neon Auth and uploaded bytes are covered by the separate example acceptance above.

Verified assembled OpenAPI, Promise storage creation, Effect status lookup, 403 for another owner, 401 for invalid credentials, 409 for a stale release and 404 for an internal route. The accompanying PostgreSQL 18 check verified all 23 metadata migrations, replayed bootstrap and denied runtime DDL/control-plane mutations. Combined result: two tests passed, zero failures/skips, 78.78 seconds. Artifacts: `/tmp/kello-u12-services-2.log` and `/tmp/kello-u12-services-2.json`.

The first attempt failed because its Effect handler used `Effect.promise` for a fallible operation, yielding a redacted 500. Switching the fixture to `Effect.tryPromise` preserved the declared 403; local regression and corrected hosted execution both passed. The initial failed result remains `/tmp/kello-u12-services.json`. The owned branch and temporary key are retained pending the remaining acceptance work; cleanup is not yet complete.
