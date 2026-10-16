# Historical operating limits and cloud evidence

This records the pre-oRPC architecture and its September 23 acceptance. Its legacy client APIs, opt-in commands and polling measurements are historical, not instructions for the native runtime. Current acceptance uses `LOOM_CLOUD_SUITE` and the required runner described in the [README](../../README.md); see [native execution evidence](orpc-execution.md) for outstanding release gates.

Loom has a bounded local and Neon acceptance baseline, not a production capacity guarantee. Sequential cloud writes passed; burst writes can exhaust bounded transaction retries and return HTTP 409 `TRANSACTION_CONFLICT`, including at four concurrent writers. Measurements record successful and rejected operations separately. They do not promise sustained throughput, a subscriber ceiling or a workload cost.

## Neon burst measurements

On September 23, 2026, the tasks application ran on actual Neon Node 24 Functions in `aws-us-east-1`, project `late-moon-69483649`, against a disposable PostgreSQL 18 branch with 0.25 CU. Chromium pages connected through Loom's authenticated live-query client. Each workload ran three batches with one browser page per concurrent writer. Every successful task creation had to appear in every page. Administrative SQL checked persisted row counts and absence of rejected writes. HTTP calls used one attempt; runtime transactions retained their default bounded retry policy.

| Writers / browser pages | Successful / attempted writes | Transaction conflicts | Successful write p50 / p95 ms | Peak runtime connections |
| ----------------------- | ----------------------------- | --------------------- | ----------------------------- | ------------------------ |
| 1 / 1                   | 3 / 3                         | 0                     | 112.98 / 244.27               | 7                        |
| 4 / 4                   | 11 / 12                       | 1                     | 177.65 / 618.55               | 12                       |
| 8 / 8                   | 19 / 24                       | 5                     | 208.93 / 541.09               | 28                       |

All successful writes converged and rejected writes left no rows. The final run classified all six refusals as exhausted transaction conflicts. A real PostgreSQL test verifies that the public response omits SQLSTATE and private error contents; actions and unrelated failures retain their separate handling. Earlier runs returned generic `INTERNAL` errors; their cause was not independently proven. These short measurements do not establish reliable four- or eight-writer burst capacity. The [raw evidence](evidence/neon-capacity-2026-09-23.json) retains both the prior measurement and the final classified results.

No HTTP 429 was observed in the final workload. Eight concurrent browser pages held live subscriptions, but this does not measure the provider's account-wide ceiling or how those sockets are billed. Sampled lock waiters were zero at every level; the 100 ms sampler plus network delay can miss short waits. Connection counts are role-scoped and include the deployment's runtime pools, not an inferred isolate count. All three cloud tests passed in this measured run; branch absence and temporary API-key revocation were verified afterward, including after failed attempts.

Reproduce with `LOOM_CLOUD_FUNCTIONS=1 LOOM_CLOUD_EXAMPLE=tasks LOOM_CLOUD_CAPACITY=1 bun run test:cloud` and the disposable branch credentials described below. This is an opt-in characterization: rejected writes are reported, not relabeled as successful. Unknown INTERNAL responses, transport failures, missing successful rows, committed rejected writes, failed convergence and a failing sequential baseline still fail acceptance.

## Process loss and slow readers

`api-lifecycle.test.ts` starts two independent local Bun API processes using actual dispatch, snapshot evaluation, restricted PostgreSQL roles and durable revision tracking. It kills one with SIGKILL, commits a direct SQL write during downtime, restarts the process on its former port, and verifies both live clients converge to that write with a fresh reconnect ticket request. The fixture supplies a trusted identity; real JWT/ticket enforcement has separate integration and cloud tests. The existing Node 24 worker test verifies SIGKILL and expired-lease recovery. These checks do not simulate Neon microVM eviction.

`slow-client.test.ts` uses a real TCP/WebSocket peer that stops reading. With a 65,536-byte transport limit and 32 KiB results, the observed peak application socket buffer was 42,232 bytes before close code 1013 / `RESYNC_REQUIRED`. The subscription disposed once and ten subsequent poll rounds performed no further evaluation. This demonstrates bounded retained socket output and cleanup, not a whole-process RSS bound. The local transport is Bun; provider memory overhead remains unmeasured.

## Local revision-contention characterization

On September 23, 2026, `packages/e2e/integration/capacity.test.ts` passed three burst workloads against local PostgreSQL 18. The client was Bun 1.4.2 on macOS arm64 / Apple M5. One process hosted two independent runtime pools, dispatchers and subscription pollers, with four connections and four concurrent evaluations per instance. These are not separate provider isolates. Each writer incremented its own application row ten times, sharing the table's transactional revision row. Readers queried the sum under separate authenticated identities. The test allowed up to ten transaction attempts, polled after a five-millisecond delay, and sampled role-scoped `pg_stat_activity` with the same delay. Query and sampling time add to those delays.

| Writers / subscribers | Completed writes | Burst duration ms | Writes/s | Write p95 ms | Evaluation p95 ms | Retries | Peak pooled connections / sampled waiting |
| --------------------- | ---------------- | ----------------- | -------- | ------------ | ----------------- | ------- | ----------------------------------------- |
| 1 / 2                 | 10               | 25.84             | 386.94   | 3.71         | 1.25              | 0       | 3 / 1                                     |
| 4 / 16                | 40               | 184.28            | 217.06   | 36.11        | 2.77              | 9       | 8 / 2                                     |
| 8 / 64                | 80               | 879.19            | 90.99    | 76.41        | 3.23              | 29      | 8 / 7                                     |

All subscribers converged to the exact committed sum without an error close, and no pool waiters remained. The middle workload sampled two simultaneous PostgreSQL lock waiters; the larger workload sampled zero despite recording 29 serialization retries. Sampling can miss short lock waits, and zero samples do not establish absence of contention. The largest workload made 1,191 acquisitions, 850 evaluations and 1,082 revision reads after warmup. The largest single write took 832.97 ms, including retries. This illustrates retry tail cost; it is not a latency promise.

The [raw measurements](evidence/local-capacity-2026-09-23.json) retain counts, p50/p95/max durations and activity samples. Warmup is excluded; elapsed time includes final subscriber convergence. Connections exclude the single administrative/sampling connection. These short, single-run bursts do not establish sustained throughput, a supported subscriber maximum, memory bounds, multi-process scaling, Node 24 behavior or Neon capacity. Reproduce with `LOOM_TEST_DATABASE_URL=<disposable-postgres-18-url> bun test packages/e2e/integration/capacity.test.ts`. The test removes its uniquely named schemas and runtime role after each run.

## Verified Neon database baseline

On September 23, 2026, `packages/e2e/cloud/database.test.ts` passed against a disposable schema-only branch of project `late-moon-69483649` (`loom`):

| Property           | Observed value                                                                                               |
| ------------------ | ------------------------------------------------------------------------------------------------------------ |
| Region             | AWS `us-east-1`                                                                                              |
| PostgreSQL         | 18                                                                                                           |
| Compute            | Fixed 0.25 CU, 300-second inactivity suspension                                                              |
| Transport          | Direct connection with TLS `verify-full`, using `pg` 8.23.0                                                  |
| Authentication     | Neon CLI 6.0.0 authenticated local profile; connection URI held in process memory                            |
| Metadata           | Versions 1–20 installed; second bootstrap preserved every version and hash                                   |
| Runtime authority  | Separate runtime-role login; no superuser, BYPASSRLS or CREATEDB                                             |
| Allowed operation  | Read the job queue                                                                                           |
| Refused operations | Create a metadata table, update activation grants, delete migration history; SQLSTATE 42501                  |
| Cleanup            | Test schemas and role removed; branch deletion acknowledged and subsequent branch list contained only `main` |

The tested branch was `br-lingering-glitter-awtmj1g6`, named `loom-acceptance-20260923-bootstrap`, with expiration set before creation. It no longer exists. The test took approximately 13 seconds, including CLI and network setup; this is not a latency benchmark. The default branch was also supplied deliberately to verify refusal before database connection or mutation.

The first isolation attempt used owner-session `SET ROLE`, which Neon refused with SQLSTATE 42501. The final test opens a real runtime-role connection with a temporary random password. It does not grant the migration owner membership in the runtime role or widen runtime privileges. A requested 60-second suspend interval was rejected by the account plan before branch creation; 300 seconds was accepted.

Current [Neon region documentation](https://neon.com/docs/introduction/regions) lists Functions and Object Storage in `aws-us-east-1`, alongside Ohio, Frankfurt and Singapore. The installed Neon skill's Ohio-only statement is stale. A live Functions list on this project's default branch succeeded and returned no functions; that does not prove deployment or invocation.

## Reproduce the database check

Authenticate Neon CLI locally or supply its supported API-key credentials. Create a disposable branch with a name beginning `loom-acceptance-`, an explicit parent, and a future expiration:

```sh
bunx neon@6.0.0 branches create \
  --project-id <project-id> --parent <parent-branch-id> \
  --name loom-acceptance-database --schema-only \
  --cu 0.25 --suspend-timeout 300 \
  --expires-at <future-ISO-8601-timestamp> --no-secrets --output json

LOOM_CLOUD_PROJECT_ID=<project-id> LOOM_CLOUD_BRANCH_ID=<created-branch-id> \
  bun run --cwd packages/e2e test:cloud

bunx neon@6.0.0 branches delete <created-branch-id> --project-id <project-id>
bunx neon@6.0.0 branches list --project-id <project-id> --output json
```

The suite skips when `LOOM_CLOUD_PROJECT_ID` is absent. When it is present, an explicit branch ID is required. Default, protected, unrelated and ambiguously resolved branches are refused. The suite creates uniquely named metadata and runtime roles and removes them in `finally`; the caller owns branch deletion and must verify its absence even when the test fails. CLI diagnostics and credentials are not printed. Database failures report the operation stage and a validated SQLSTATE when available.

## Acceptance boundary

U17's bounded characterization includes local contention, API/worker process loss, actual slow-reader disposal, simulated throttling and the cloud workload above. Remaining provider uncertainties are sustained capacity, whole-isolate memory, forced provider eviction, account-wide quota accounting and billed workload cost. These are explicit limits on release claims. They are not measured by the correctness suites.

## Runtime measurements

Node diagnostics subscribers can collect `kello.runtime.metric` events, typed by `RuntimeMetric` from `kello/server`. The opt-in `startDiagnostics` adapter from `kello/tooling` observes this channel and `kello.deployment.metric` in its own process. In `kello dev`, the runtime generations, jobs and HTTP/WebSocket listener run inside the CLI process, so one session observes them across replacements. It does not observe credential/link helper children, their output, separately launched applications or remote isolates. Events have no project, generation or pool identity; they cannot establish fleet totals, provider health or an end-user SLA. The names and semantics here apply to this section, not every historical acceptance entry in this document. See [diagnostics and exporter usage](../../apps/docs/content/docs/operations/development.mdx#local-diagnostics).

A `transaction.retry` event contains only `kind` (`query` or `mutation`) and `attempt` (2–10, counting the original attempt). Count these events to measure additional transaction attempts, rather than summing attempt numbers. Each event is published after backoff and cancellation checks, immediately before starting the next transaction; exhausted attempts and cancelled backoffs produce no extra event. It does not count action or durable job retries.

`revision.read` reports `status` (`success` or `error`), `durationMs` and the number of distinct tracked tables (`tableCount`). Its monotonic wall time includes the database read and result validation, plus pool acquisition when the reader runs outside a transaction. It covers both polling reads and revisions captured during query evaluation; it is not a count of poll cycles. Missing revision rows and database failures produce error measurements while preserving the original rejection.

`rpc.procedure` reports `mode` (`finite`, `live` or `mutation`), `status` (`success` or `error`) and monotonic `durationMs` around the native RPC error boundary's downstream execution, output validation and error normalization. It excludes HTTP transport and encoding outside that boundary. A live success/duration ends when the initial iterator is constructed; later iteration errors and stream lifetime are excluded. Nested procedure boundaries are suppressed within the same observed execution. This is not a complete request or stream success rate. RPC, revision-read and database-acquisition durations can overlap and must not be summed. Calls that bypass the boundary produce no RPC measurement.

`realtime.listener` reports `connected`, `degraded` or `idle` transitions. `realtime.coordinator` samples active `subscriptions`, `evaluating` work and remaining `queued` entries in the current bounded evaluation batch. These are local observations without coordinator identity, not continuous or fleet-wide gauges.

`job.claim` reports the database-clock age since initial creation (`ageMs`), lateness against the current due time (`dueLagMs`), attempt number and whether the claim recovered an expired running lease (`recovered`). Durations are clamped to zero for backward clock adjustments. These are samples of claimed jobs, not a gauge of every pending job. Creation age includes prior attempts and replay history; due lag uses the current scheduled/retry time. Each successful claim emits once; an empty claim emits nothing.

`job.lease.reaped` reports how many expired running attempts a claim sweep changed to failed or cancelled (1–100). Recoverable expired leases appear as `job.claim` with `recovered: true`, so they are distinct from terminal cleanup. These events observe SQL statement results; if callers supply an enclosing transaction, its later commit or rollback is not represented. They contain no job IDs, lease owners, fencing tokens, arguments or results.

`job.lease.lost` records the first worker-side reason for aborting lease execution: `deadline` when its local lease budget expires, `ownership` when renewal returns false (including requested cancellation), `activation` when deployment authority fails, or `queue` when renewal throws. It emits at most once per claimed execution and does not emit for ordinary shutdown cancellation. A local deadline event does not prove that PostgreSQL has already expired or reassigned the lease. These events do not count failed acknowledgements, and they do not imply that a handler has stopped immediately; handlers must observe cancellation. Queue recovery/cleanup measurements above describe separate database transitions.

`database.acquire` reports `status`, monotonic `durationMs`, and pool `total`, `idle` and `waiting` counts when acquisition completes or fails. Duration includes waiting for a free slot and establishing a new connection when necessary; it excludes SQL execution and is not exclusively queue time. Both promise and callback acquisition APIs are measured, covering Drizzle transactions and ordinary pooled queries. Counts are per-pool samples at acquisition completion, not continuous gauges or fleet-wide totals; they do not record every release or shutdown transition. Capacity runs must identify their pool/isolate configuration and sample separately when they need an idle-time or peak-queue gauge.

The channels retain no history and configure no exporter themselves. Direct subscribers must follow Node diagnostics-channel requirements, including not throwing from callbacks. The owned adapter copies only approved primitive fields, strips extras and rejects unknown variants or malformed fields without forwarding raw payloads. Records contain no function/job/table names, identities, arguments, SQL, credentials, paths, endpoint URLs or error messages. Operational timing data still deserves appropriate access and retention controls.

Deployment tooling publishes `release.acknowledgement` on the separate `kello.deployment.metric` channel, typed by `DeploymentMetric` from `kello/tooling`. Stages are `metadata`, `quarantine`, `migrations`, `prepared`, `bootstrap`, `triggers`, `functions`, `health`, `activated` and `complete`. Status is `recorded` after a successful receipt write, `replayed` for an identical existing acknowledgement, or `write-error` when writing leaves the journal uncertain. Invalid/conflicting acknowledgements emit no progress event. Events contain no receipt identity, resource names, hashes, variables or error contents. A saved acknowledgement is not proof of current provider health; recovery must still observe live state. These events provide stage progress, not provider operation durations or a deployment success rate. Consumers can miss events across process exits and must use the receipt for durable progress. A dev session sees only acknowledgements published in its own process, not those from a separate deployment CLI.

Local text and JSONL use `DiagnosticsRecord` from `kello/tooling`: `schemaVersion: 1`, `scope: "local-process"`, a session-monotonic `sequence`, a UTC ISO `timestamp`, and `source` (`runtime`, `deployment` or `diagnostics`) with its approved `event`. Sequence and timestamp are correlation fields, never metric attributes. `diagnostics.loss` carries cumulative `accepted`, `invalid`, `dropped`, `outputFailures` and `exportFailures` statistics; `snapshot()` exposes the same counters. Accepted means admitted to ingress, not delivered. Dropped includes ingress/output queue loss and refused metric accumulation, so it is not a count of unique lost events. Loss lines are emitted at most once per second when counters change and remain subject to queue/output loss; shutdown does not write a final loss line.

Ingress holds at most 1,024 records, the independent output queue 256, and each formatted line 2 KiB. Queue overflow drops the newest observation; numeric overflow refuses accumulation. The drain yields after at most 64 records. A writer failure disables local output, while enabled metrics continue independently. Output is best effort: stopping discards queued local output, and abrupt process loss can lose observations. Neither the adapter nor CLI rotates, uploads or durably spools records. Users own file retention/deletion and collector retention, access and resource relabeling.

OTLP export uses a private per-session registry, cumulative monotonic counters and explicit millisecond histograms. The initial mapping has 68 instrument/attribute tuples (54 counter and 14 histogram series), within ceilings of 128 series and 128 KiB per request:

| Instrument (`kello.` prefix)                            | Mapping and attributes                                                                            |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `rpc.procedure.count`, `rpc.procedure.duration`         | One event / duration; `mode`, `status`                                                            |
| `revision.read.count`, `revision.read.duration`         | One read / duration; `status`                                                                     |
| `database.acquire.count`, `database.acquire.duration`   | One acquisition / duration; `status`                                                              |
| `transaction.retry.count`                               | One additional attempt; `kind`                                                                    |
| `job.claim.count`, `job.claim.age`, `job.claim.due_lag` | One claim / age / lateness; `recovered`                                                           |
| `job.lease.reaped.count`                                | Add terminally cleaned jobs; no attributes                                                        |
| `job.lease.lost.count`                                  | One lease-loss event; `reason`                                                                    |
| `deployment.acknowledgement.count`                      | One receipt event; `stage`, `status`                                                              |
| `diagnostics.loss.count`                                | Loss/failure increments; `reason`: `invalid`, `ingress_queue`, `output_queue`, `output`, `export` |

Counters use `{event}`, except reaped jobs use `{job}`. Histograms use bounds `[1, 5, 10, 25, 50, 100, 250, 500, 1000, 5000, 30000, 60000]` ms plus an implicit infinity bucket. A histogram counts as one adapter series; a collector that flattens buckets can create more series. Realtime state, pool counts, revision table counts and attempt numbers stay local and are not exported as gauges or labels. Pair observed counters with loss metrics; drops can cause undercounting. Session resource identities are not a global cardinality limit.

Resource attributes are exactly `service.name="kello-dev"`, `service.version` (package version), `deployment.environment.name="development"` and a random per-session `service.instance.id`. Ambient Effect metrics and generic `OTEL_*` configuration are excluded. No logs, traces, auto-instrumentation or remote-isolate collection is provided.

Export attempts run every 10 seconds, with one request in flight, no catch-up queue and no per-batch retry. Each attempt has a 1-second deadline including serialization and response consumption, with a 16 KiB response ceiling. Redirects, rejected/invalid responses and error-bearing OTLP partial success count as export failures without printing remote contents. A later cumulative snapshot retains admitted observations after failure; it does not recover dropped events or guarantee delivery across process exit. Collector parsing is separate from retained/queryable provider data.

`stop()` is idempotent: it synchronously unsubscribes, forbids new writer calls and aborts the writer signal. Remaining ingress may update metrics, with a final export attempted within the shared 2-second diagnostics cleanup budget. This does not bound development/database shutdown or blocking caller code. Cancellation is cooperative and cannot revoke writes already submitted to the OS. Pending work in a caller-owned writer remains caller-owned; omitting the CLI flags or removing the owning adapter opts out without a migration or provider-resource cleanup.

## Verified example acceptance

The tasks example passed the public deployment coordinator, health/activation, authenticated operations, mutation replay, owner isolation, invalid JWT rejection, two-browser subscriptions, socket reconnect and account switching. A fresh run after the durable binding and metadata-version-21 changes passed all three cloud tests in approximately 88 seconds.

On September 23, 2026, the jobs-storage selection passed all three cloud tests in approximately 245 seconds, including its application scenario in 228 seconds. It used actual browser PUTs, provider storage events and scheduled worker wakes; the harness did not invoke workers manually. Checks covered all three ready catalog entries, normal completion in one attempt, retry completion in two attempts, exhausted failure after three attempts, exact downloaded bytes, foreign-owner upload/download signing denial and an empty catalog after switching users. This run also passed database bootstrap through metadata version 21 and exercised the durable trigger-binding fix on Neon. It is correctness evidence, not a throughput or latency benchmark.

Run either selection with `LOOM_CLOUD_FUNCTIONS=1 LOOM_CLOUD_EXAMPLE=tasks bun run test:cloud` or `LOOM_CLOUD_FUNCTIONS=1 LOOM_CLOUD_EXAMPLE=jobs-storage bun run test:cloud`, supplying the disposable project/branch variables above and a project-scoped `NEON_API_KEY`. The pinned SDK does not read the local CLI profile. These rehearsals used temporary keys, deleted the branch and revoked the key afterward, and verified both absences. The CI matrix covers both selections, but hosted CI has not yet run.

## HTTP throttling

The client retries HTTP 429, 502, 503 and 504 within its configured attempt budget (default three, maximum five). Retry-After accepts integer seconds or an HTTP date, following [HTTP semantics](https://www.rfc-editor.org/rfc/rfc9110.html#name-retry-after); 429 is defined by [RFC 6585](https://www.rfc-editor.org/rfc/rfc6585.html#section-4). The wait is at least the provider delay or the existing exponential backoff, plus up to 100 ms of jitter. Invalid timing falls back to backoff. Very long waits end at the original request deadline (default 30 seconds, maximum 120 seconds), rather than retrying early. Caller cancellation also interrupts the wait.

Mutations reuse their captured body and idempotency key. Actions retain one attempt. Exhausted throttling returns RATE_LIMITED with a fixed message; provider response bodies are not exposed. Four concurrent clients against a real local HTTP server each respected a one-second 429 delay and made exactly two identical requests. Unit coverage includes HTTP dates, malformed values, huge delays, cancellation, exhaustion and action non-replay. This limits each call's retries and adds jitter; it does not provide a shared cross-client rate limiter or establish the provider's actual quota behavior.

## Provider constraints checked September 23, 2026

[Neon's runtime limits](https://neon.com/docs/compute/functions/reference/runtime-limits) specify Node 24, 2048 MiB per isolate, a default account-wide 100 concurrent invocations, and HTTP 429 with Retry-After when that concurrency limit is exceeded. The effective ceiling may be modestly higher. First-byte, silent-connection heartbeat and waitUntil limits are each 15 minutes. Shutdown sends SIGINT with five seconds before forced termination. Isolate memory is neither shared nor durable; each isolate's database pool contributes to the total connection count.

[Neon's WebSocket guidance](https://neon.com/docs/compute/functions/websockets) says connections keep the function running while data flows, and eviction can drop connections without a clean close frame. Loom's 25-second heartbeat and reconnect protocol fit the documented lifecycle, but local reconnect tests do not establish provider eviction behavior or socket quota accounting.

The [pricing page](https://neon.com/pricing) lists Launch active/waiting compute at $0.10/$0.025 per Capacity-Hour, Scale at $0.12/$0.03, and invocations at $0.60 per million on both. Free allowances are 10 active Capacity-Hours, 400 waiting Capacity-Hours and one million invocations monthly. These are documented rates, not a Loom workload cost estimate. Actual active/waiting capacity consumption, persistent-socket invocation accounting, database compute and network transfer must be measured together before publishing a cost envelope. No account-wide saturation experiment or billing observation has been performed for this acceptance increment.
