# Rate limit retention maintenance

An operator runs the repository entrypoint with PostgreSQL 18 owner credentials.
The package must be built before invoking this command from the repository root:

```sh
bun scripts/rate-limits-maintenance.ts --metadata-namespace loom_meta --batch-size 500 --max-batches 20 --max-duration-ms 30000
```

Supply `LOOM_MIGRATION_DATABASE_URL` through the selected operator/CI secret store,
one owner secret per target. There is no runtime credential fallback. The metadata
namespace is explicit; replace the example with the target's namespace. Cleanup
is tooling only and must never be exposed through an application route.

`cleanupRateLimits` is exported by built `kello/tooling`. It accepts
`connectionString`, `metadataNamespace`, optional `batchSize` (default/max 500),
`maxBatches` (default/max 20), `maxDurationMs` (default/max 30000), and `signal`.
Budgets must be positive safe integers. The duration includes connecting, SQL,
cancellation, and closing the owned connection. Cancellation or a deadline reached
while connecting, executing SQL, or closing fails with a fixed error.
The useful-work cutoff reserves cancellation and close time within this budget.
An early voluntary stop between completed batches can return
`stoppedBy: "time-budget"` only if owned cleanup finishes before the absolute
deadline. Actual expiry, including expiry during close, returns failure after
cleanup settles. Required safety cleanup may finish late; it cannot report success.

The caller must own the metadata schema. Cleanup authenticates the entire current
framework ledger with the existing ordered-prefix/hash classifier and the current
framework migration definitions. It rejects incomplete, divergent, or unsupported
history before deletion; appended migrations work when both the package and target
are current. It does not bootstrap or repair metadata.

Each batch selects at most 500 eligible rows in expiry-index order with
`FOR UPDATE SKIP LOCKED`, reads a fresh database clock after locking, and deletes
only selected primary keys still eligible at that clock. Each batch commits
independently. A rollover that renews expiry under the same row lock survives.
The expiry-index existence and oldest-row probes include locked eligible rows;
zero deletions do not mean the backlog is empty. Empty locked batches consume the
batch budget, so they cannot spin indefinitely. Policy registrations remain intact.
No cleanup metric is published; atomic metrics integration awaits the reviewed 001
dependency.

The one JSON output contains `status`, `removed`, `batches`, `hasMore`,
`oldestExpiredAgeMs`, and `stoppedBy`. Counts include only confirmed commits.
`stoppedBy` is `empty`, `batch-budget`, or `time-budget`. Age and existence describe
the last confirmed batch's database snapshot, including locked backlog. They can
change immediately after that observation. Failure output contains the fixed
status and, when cleanup started, the confirmed `removed` and `batches` counters.
Input/credential validation failures contain only the fixed status. There is never
a URL, namespace, SQL, credential, or database cause in output. The tooling operation
keeps the initiating abort/deadline or first operation failure and cancellation/connect-drain/query-drain/close failures separately
in private error-associated storage; neither SQL details nor an Error `cause` cross
the public boundary. Its fixed failure Error carries only safe count properties.

| Exit | Status                       | Meaning                                                                                      |
| ---- | ---------------------------- | -------------------------------------------------------------------------------------------- |
| 0    | `RATE_LIMIT_CLEANUP_OK`      | No eligible backlog, or oldest eligible age at most one hour                                 |
| 2    | `RATE_LIMIT_CLEANUP_BACKLOG` | Oldest eligible age exceeds one hour                                                         |
| 1    | `RATE_LIMIT_CLEANUP_FAILED`  | Arguments, credentials, metadata, SQL, cancellation, close, or actual deadline expiry failed |

Younger backlog is visible through `hasMore` and `stoppedBy` even with exit 0.
An eligible bucket's expiry is window end plus 24 hours. Actual retention also
includes maintenance lag, which is unbounded during outages or sustained backlog.

Before production policy enablement, the deployment operator must select and
record the actual CI scheduled job or system timer identifier, its owner, target,
secret reference, 15-minute cadence, and alerts for nonzero exits and more than
30 minutes without a successful run. This feature configures no scheduler job;
operational acceptance remains pending until that real selection is recorded.

On an age alert, investigate locked rows, stalled transactions, incoming volume,
and missed runs. Resume with the same bounded command sequentially, at most four
runs per hour including scheduled runs. Never amplify concurrency or silently
increase budgets. Each successful run removes at most 10000 rows and fully settles
within 30 seconds. Failed runs still await required safety cleanup, which can finish
later while retaining the failure exit. If the
oldest eligible age still exceeds one hour after two scheduled runs, halt expansion
of enabled policies and require a capacity/retention decision. Do not truncate
buckets or reset live allowance. Prior confirmed batches survive cancellation or
failure; another bounded invocation resumes remaining work without repair.

For maintenance acceptance, the coordinator supplies `LOOM_TEST_DATABASE_URL`
and `LOOM_TEST_POOLED_DATABASE_URL` for the existing transaction pooler targeting
the same shared disposable PostgreSQL 18 database, including password authentication
when required, and grants a serialized database window. Native tests have no endpoint
default and fail before connecting when either required profile is absent. During that window,
after the host builds the current package, run:

```sh
bun test packages/e2e/integration/rate-limits-maintenance.test.ts
```

The native cases import source consistently and use distinct owner sessions for
locking and overlapping cleanup. The script case runs a separate Bun process
against the public built export. It proves exits 0, 1, and 2, younger and older
locked backlog, resumable deletion, and allowlisted output. The native cases also
cover bounds, indexed selection/probes, retained policies and renewed buckets,
ownership/history rejection, cancellation after a confirmed batch, and in-flight
timeout. Direct and transaction-pooler cancellation cases use actual backend
activity and lock observations; cancel-packet transmission is not a server
acknowledgement. These checks require actual database access; source parsing and argument
tests do not establish database or built-export acceptance.

The DB-independent argument/redaction check is:

```sh
bun run --cwd packages/tests test --maxWorkers=2 unit/rate-limits-maintenance.test.ts unit/rate-limits-maintenance-shutdown.test.ts
```

The harness has DB-free ownership fault checks that run without either profile:

```sh
env -u LOOM_TEST_DATABASE_URL -u LOOM_TEST_POOLED_DATABASE_URL bun test packages/e2e/integration/rate-limits-maintenance.test.ts --test-name-pattern 'offline maintenance harness'
```

These checks cover barrier-failure joining, independent teardown attempts, and
script kill-and-join on timeout or pipe failure. They do not execute the native
cases or establish database cancellation, pooler behavior, or the strict native
2000ms budget. The native controlled barrier-failure case retains backend and
lock observations after joining, before fixture destruction.
