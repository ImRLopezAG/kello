# Deployment recovery

This document records the deployment implementation in stages. Statements that a capability is unfinished describe that stage, not a consolidated release status. Use the current [deployment guide](../../apps/docs/content/docs/operations/deployment.mdx), [migration guide](../../apps/docs/content/docs/operations/migrations.mdx), and [oRPC execution evidence](orpc-execution.md) for supported commands and verified behavior. Retained-code rollback and explicit active-version compatibility declarations are now implemented; provider-resource retirement and abandoned-lock recovery still have the limits documented below.

`deployNeonRelease` coordinates migration application, function deployment, runtime health checks, activation grants and trigger activation on an explicitly selected, already provisioned branch. `deployProjectRelease` reads a release declaration for the CLI; `planProjectRelease` inspects its proposed changes. These use the pinned Neon configuration runtime. Branch infrastructure creation is available separately; project/database/role provisioning, application compatibility/contraction gates and general migration recovery remain unfinished. Local fixture results do not establish live Neon acceptance.

## Branch infrastructure

Run `kello provision --branch provisioning/preview.json --dry-run --json` to inspect creation, then omit `--dry-run` to apply or resume. The project-relative strict JSON declaration contains `format: 1` and the options below. Authentication comes from `NEON_API_KEY`; credentials do not belong in the declaration. The command reads the declaration without evaluating project source modules. Success returns the plan or receipt; failure returns exit code 5 and preserves saved progress. SIGINT/SIGTERM request cancellation through the same acknowledgement-preserving API. Unrelated options and extra positional arguments return a usage error.

`planNeonBranchProvision(options)` observes an existing explicit PostgreSQL 18 project and parent branch, then reports branch creation without writing local or provider state. Options contain a stable 64-character lowercase hexadecimal `key`, `projectId`, `parentBranchId`, `branchName`, and `environment` (`development`, `preview`, or `production`). Production requests branch protection. An occupied name or ambiguous provider identity is refused; the parent never defaults implicitly.

`planProjectBranchProvision(root, file)` and `provisionProjectBranch(root, file)` expose the CLI's declaration flow to tooling consumers. The creation dry-run refuses an occupied name even when an earlier apply completed; apply resumes through its saved receipt. Keep the declaration and key stable for retries.

`provisionNeonBranch(root, options)` uses the pinned configuration runtime's typed `NeonApi.createBranch` operation with the explicit parent ID. It records `submitting`, `created`, and `complete` progress in `.kello/provision/<key>/branch.json`, using private atomic writes and a local `branch.lock`. Creation acknowledgement is saved before endpoint observation. If the endpoint is not yet visible, retry keeps the acknowledged branch ID and observes again without creating another branch. Completion requires the exact branch name, parent, protection and non-default status, plus one unambiguous read-write endpoint. Even completed receipts recheck provider identity on retry.

Cancellation before submission prevents creation. Once submitted, the call awaits the provider response and records its branch ID before honoring cancellation. A lost response leaves `submitting`; retry refuses to infer ownership from a matching name or submit again. Changed inputs, corrupt receipts, endpoint replacement and concurrent local writers are refused. Uncertain-create reconciliation and abandoned-lock recovery remain unfinished; keep the receipt for investigation. The lock coordinates one checkout, not independent machines.

This stage creates branch infrastructure only. It does not quarantine copied database work, configure environment secrets, create databases/roles, deploy functions or activate triggers. Bind the returned IDs to the project's explicit target and run the release sequence before using its runtime. Project/database/role provisioning and composition with the full release remain required work. The pinned SDK's typed API exposes branch/project creation and role/database observation, but does not expose role/database creation; that integration still needs a deliberate implementation path.

## Release command

Run `kello deploy --release releases/preview.json --json` from the project directory, or select it with `--cwd`. The command applies changes. Add `--dry-run` to inspect the plan without applying it. Unknown or unrelated options are refused. Failure returns exit code 5 with a fixed diagnostic and preserves saved progress. SIGINT/SIGTERM request cancellation; an in-flight provider mutation is awaited by the coordinator so its acknowledgement can be recorded.

The release file is strict JSON, contained within the project, with these fields:

| Field                                          | Value                                                                                                    |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `format`                                       | `1`                                                                                                      |
| `releaseKey`                                   | Unique 64-character lowercase hexadecimal release key, retained across retries                           |
| `deployment`                                   | Logical deployment name                                                                                  |
| `version`                                      | Exact source version reported by `kello doctor --json`                                                   |
| `environment`                                  | `preview` or `production`; resolves the explicit target in `kello.config.ts`                             |
| `databaseName`, `migrationRole`, `runtimeRole` | Existing selected database and its migration/runtime roles                                               |
| `quarantine`                                   | `clone` for a newly cloned preview, or `preserve` for an existing branch; production requires `preserve` |
| `migrationHashes`                              | Every committed migration's `plan.hash`, in application order                                            |
| `reviewedHashes`                               | Hashes of migrations reviewed for unsafe/custom changes                                                  |
| `schema`                                       | Explicit `minimum`, `maximum`, `target` schema hashes, plus migration anchors when needed                |
| `slugs`                                        | Distinct `service` and `worker` names, each 1–20 lowercase letters/digits                                |
| `activationTokenEnv`                           | Name of an environment variable containing a secret 64-character lowercase hexadecimal token             |
| `variables`                                    | Map of deployed variable names to local environment-variable names                                       |

For example, `"variables": { "KELLO_DATABASE_URL": "PREVIEW_RUNTIME_URL", "MAIL_TOKEN": "PREVIEW_MAIL_TOKEN" }` resolves two local values without putting them in the declaration. Include the project's configured runtime URL variable. Neon supplies its own reserved variables. The API key, migration URL and activation token cannot be mapped as application variables; raw secret fields and unknown declaration fields are rejected. Keep the activation token and referenced values stable for retry. Changed inputs conflict with the immutable release receipt.

The command does not infer a compatibility range from the current schema. Declare the range from reviewed application compatibility evidence. The coordinator checks structural lineage, live schema agreement and stored declarations for active grants and queued/running job versions. It does not establish application behavior or prove that old readers and writers have retired.

## Dry-run observations

`kello deploy --release releases/preview.json --dry-run --json` resolves the explicit target and obtains the migration connection through the provider. It holds the deployment/shared migration locks, makes the database session read-only and inspects history, live drift and structural schema bounds. It reads any saved release receipt without creating or changing it. The real Neon SDK planner supplies function create/update intent. Shared declarations supply the job wake schedule, application crons, private buckets and storage triggers.

The result identifies metadata bootstrap, pending migrations and required reviews, quarantine mode and observed work counts, bootstrap/final function passes, bucket/trigger changes, initial trigger disablement, and activation. Completed receipt stages are reported as acknowledgements; they do not replace live verification. The planner reports observed conflicts such as changed receipt identity, replaced functions, public buckets, mismatched prepared triggers, an active branch selected for clone quarantine, or copied work selected for preservation. Conflicts return a plan with `ok: false` and exit code 5. Invalid inputs or failed observations return the fixed deployment diagnostic.

Planning does not resolve the activation token or application secret values, probe health endpoints, upload archives, mutate provider resources, apply SQL, or write release acknowledgements. It may write immutable local generated entry files and module caches. Provider authentication and migration-role access are still needed for observation. Environment references appear in the plan; values do not.

An empty blocker list means no conflict was detected by these observations. It does not promise successful application. `checksAtApply` lists the remaining secret-bound receipt check, runtime credential authority, archive build, fresh live state, health and branch-specific activation checks. Apply repeats its own validation and never treats a dry-run result as authorization or proof of compatibility.

## Release journal

`withNeonReleaseReceipt` stores an ordered journal at `.kello/releases/<release-key>/release.json`. The caller supplies a stable hexadecimal key and the release identity: deployment, source version, input fingerprint, provider target, database/namespaces, migration hashes and declared minimum/maximum/target schema hashes. Identity is immutable once saved. The coordinator must compute the input fingerprint from all release inputs without persisting secrets.

Acknowledgements advance through metadata bootstrap, preview quarantine (zero counts for production), migrations, grant preparation, bootstrap functions, disabled trigger preparation, final functions, health, grant activation and final trigger activation. Function stages retain artifact hashes and service/worker provider IDs; trigger preparation retains disabled snapshots and runtime bindings. Final functions must retain the bootstrap function identities and final enabled IDs must match prepared triggers. Migration acknowledgement must match the declared target schema. The journal stores the schema range declaration; the coordinator must separately inspect its lineage and verify supported readers/writers.

Before final deployment and activation, the migration identity publishes the verified provider trigger bindings to `deployment_trigger_bindings`. The map is immutable for its deployment, source version, project and branch; a conflicting map refuses release recovery. Workers load it with runtime SELECT privileges after verifying their activation grant. Both bootstrap and final workers therefore use the same exact trigger IDs, names and bucket bindings even if Neon continues routing requests to the bootstrap after final health succeeds. Unknown IDs remain forbidden. Framework migration 21 adds the table; existing metadata migration hashes remain unchanged.

The journal refuses skipped stages, conflicting acknowledgements, changed identity, invalid references and corrupt files. Identical acknowledgements can be repeated. Reads return detached copies. A per-release local lock prevents concurrent writers and is not automatically stolen after interruption. Writes use the same private-file, atomic replacement and file/directory sync helper as function receipts. After a write error the current session refuses more work until reopened, because rename may already have succeeded. Callback failure leaves saved progress intact and releases the local lock; closed sessions cannot append.

This API records acknowledgements supplied by its caller. It does not execute stages or establish that remote resources still match the receipt. The whole-release coordinator must hold the database deployment lock, re-observe provider/database state on resume, verify health and compatibility, and reconcile unacknowledged mutations before proceeding. The release coordinator enforces this sequence for structural schema evidence; application compatibility and abandoned-lock recovery remain unfinished.

## Schema range inspection

`inspectReleaseSchema` reads and validates committed migration artifacts, requires the exact ordered migration hashes from the release inputs, checks namespace containment and requires the declared target to equal the committed schema head. It resolves minimum and maximum schema hashes in migration order and refuses absent, reversed or target-excluding bounds. The returned schema list and migration hashes are immutable; ordinals identify the resolved boundaries, with zero representing the empty baseline.

Consecutive data-only migrations can keep the same schema hash. If a schema disappears and later returns, its hash alone cannot identify a boundary. Optional `minimumMigration` and `maximumMigration` anchors select the exact migration hash; `null` selects the empty baseline. An anchor must exist and produce the stated schema. These anchors are also retained in the release journal identity. Unanchored bounds are accepted only when their occurrences form one contiguous interval.

This is a structural, offline check. It does not prove that application code supports every schema in the declared range, that the live database matches it, or that old jobs/readers have drained before contraction. Live database evidence requires the separate inspection below; full contraction enforcement remains unfinished.

## Rolling back to retained code

Create a new release declaration with `retainedReleaseKey` naming a completed earlier release, a fresh `releaseKey`, and `quarantine: "preserve"`. Restore that release's exact source version, service/worker names, runtime credentials, application variables and activation token. Keep the current committed migration artifacts and declare a reviewed compatibility range covering the older source and the current applied schema. Run the normal `kello deploy --release <file> --dry-run --json` and apply commands.

The retained release must belong to the same deployment, branch, database and source version, and its migration history must be a prefix of the new declaration's history. Its activation grant must still be active; revoked or removed runtimes are outside this path. Planning reports `RETAINED_RUNTIME_INACTIVE` when that grant is unavailable. Pending migrations are refused: apply any separately reviewed expansion before attempting code rollback.

Preparation adopts only the retained bootstrap, trigger and final-function acknowledgements. It verifies local function receipts, archived bundle hashes, original inputs and live provider identities without redeploying those completed functions. Missing receipts, changed variables, replaced deployments, incomplete releases and different function names are refused. Preserve `.kello/releases` and `.kello/deploy` artifacts for releases you intend to retain.

Health, database and runtime-role inspection run again; old health and activation observations are never copied. A failed health check leaves ingress unchanged. Successful apply performs the normal ingress handoff under the new release key, enables the retained worker's ingress and keeps other retained workers available for their queued jobs. Repeating the new declaration resumes safely; retrying the superseded original declaration remains refused. Use the retained service's URL when routing clients to the restored code.

Rollback does not reverse migrations or delete expanded data. Local tests cover populated nullable-column preservation, retained function preparation, public-API health failure/retry and unchanged provider deployment IDs. Full two-version live cloud acceptance and retirement of old services/sockets remain outstanding.

## Runtime compatibility declarations

The project's source schema must occur within its declared release range; it need not equal the target head. This permits an older source schema to run against a reviewed compatible expansion while retaining the current committed migration artifacts. The declared target still must equal the committed head.

Framework metadata version 15 stores the source schema, ordinal bounds and ordered migration hashes for each namespace/deployment/source version. Runtime credentials cannot modify these records. A replacement declaration must preserve its source schema and existing migration-hash prefix. When that version has an active grant, its range must include the currently applied database ordinal.

Before applying pending migrations, the runner checks dependencies from active activation grants, pending/running jobs and unexpired client-session records. Each version needs a declaration covering the pending migration interval with the exact ordered artifact hashes. Active versions must also cover the current database. Missing job versions fail closed. Ordinals and artifact hashes distinguish a later contraction from an earlier expansion even when both produce the same schema hash. Direct migration application uses the same gate as releases.

Release planning reports `INCOMPATIBLE_RUNTIME` when these declarations are missing or insufficient. It evaluates the incoming version's proposed declaration without persisting it. Fresh clone quarantine removes copied active grants and queued work before application checks; planning accounts for that sequence. Metadata upgrades can defer dependency observation until apply, which always repeats the check.

Framework metadata version 19 binds new connection tickets to their schema namespace and source version. Redemption atomically consumes the ticket and inserts a client-session record through the authenticated session expiration. It takes a nonblocking shared migration lock and rechecks runtime activation inside an explicit READ COMMITTED transaction. The migration runner holds the matching exclusive lock, so it observes admitted redemptions before checking compatibility. A migration already holding the lock makes redemption fail without consuming the ticket; clients may retry while it remains valid.

Session records contain a ticket hash and runtime identity, not the authentication identity or bearer token. The runtime can insert and read records but cannot shorten their expiration or delete them. Records conservatively remain dependencies even if a socket closes early or its upgrade fails. Expired records no longer block migrations; automatic pruning is not yet implemented. Metadata owners may remove expired rows. Tickets issued before this metadata upgrade lack namespace/version bindings and cannot be redeemed by the new runtime. Earlier runtime binaries still depend on the active-grant guard; this ledger alone does not prove those binaries have drained.

Application query, mutation and subscription-evaluation transactions now take ACCESS SHARE on the activation table before their first SELECT, then recheck activation using that transaction. The lock remains held through commit or rollback. An owner-held ACCESS EXCLUSIVE lock cannot pass an admitted handler; after an owner commits revocation under that lock, a subsequent handler sees the revoked grant before application work. Admission uses NOWAIT, so it fails promptly during the exclusive barrier. This preserves read-only repeatable-read queries and serializable mutations, without requiring a second pool connection. PostgreSQL documents why the explicit lock must precede snapshot creation in its [application consistency guidance](https://www.postgresql.org/docs/18/applevel-consistency.html).

The database retirement stage below uses this transaction boundary. The barrier covers database function handlers and storage operations. Storage intent creation, status, signing and finalization now run under the same activation lock; cleanup retains it through object removal and its SQL commit. Storage event receipt admission, final dispatch and reconciliation each hold it through their database transaction. Signing/finalization use the transaction database for activation reads, including with a one-connection pool. Already issued presigned URLs retain their provider expiration; taking this barrier does not revoke them. Action side effects and full service/socket shutdown still need coordinated lifecycle handling. It is shared by all versions using that metadata table, so an exclusive barrier briefly affects their database admissions. Earlier binaries lack this boundary and must not be treated as drained by acquiring it. Neon entrypoint format 5 distinguishes newly prepared entrypoint artifacts from the earlier format.

These are reviewed declarations, not inferred compatibility guarantees. Rehearse application reads and writes against every supported schema. The gate does not retain old function handlers, retire already admitted requests or live sockets, or provide a complete code rollback workflow. Those lifecycle mechanisms and full contraction proof remain required work.

`inspectReleaseDatabase` combines that artifact/range inspection with live migration status on the existing deployment connection. The application and metadata namespaces come from the connection's captured configuration; a different application namespace is refused. The check takes the shared migration lock and reads framework/application/ORM history and catalog evidence in a read-only, repeatable-read transaction. It requires initialized metadata, consistent histories/catalog, no pending artifacts, the expected schema head and the exact applied migration hashes. It returns target/database identity and catalog evidence without modifying schema or grants. Cancellation is checked between stages and after observation; in-flight SQL uses the connection's existing statement timeout.

The shared status implementation is also exposed as `migrationStatusOnConnection`; ordinary `migrationStatus` delegates to it. Both use Kello-owned dedicated connections, and session locks remain until the owning connection closes. Finish any direct SQL transaction before invoking these stages. The live inspection is point-in-time evidence, not proof of application compatibility or drained old readers/jobs. The release coordinator repeats this inspection before activation, including on resume.

## Function name ownership

Framework metadata version 16 reserves service and worker names for a deployment/source version within the selected project and branch. Release preparation records both names before mutating functions or triggers. A later release with a different version, deployment or role cannot reuse a reserved name; retries of the same owner remain allowed. Reservations live in PostgreSQL and are not removed when local receipts disappear or releases fail. Runtime credentials cannot change them. Planning reports `FUNCTION_NAMES_RESERVED` without writing reservations; apply checks again under the deployment lock.

This prevents coordinated releases using the same metadata namespace from overwriting registered older endpoints. It does not import ownership for pre-existing provider functions, protect changes made through the lower-level code-only deployment API or provider console, or coordinate separate metadata namespaces/databases. Reservations are not garbage-collected. Choose distinct names for a new version. The ordered trigger handoff below retains older worker wakeups; runtime retirement, complete draining and rollback remain unfinished.

## Trigger handoff and retained workers

Release-managed trigger names include the worker name: `kello:<worker>:jobs`, `kello:<worker>:cron:<declaration>` and `kello:<worker>:storage:<bucket>`. The application cron name remains unchanged in its runtime binding. Distinct workers can be prepared side by side with independent disabled triggers; preparing a candidate does not overwrite or disable the older worker's triggers.

Framework metadata version 17 records candidate/current/retired release ingress claims per project, branch and logical deployment. After new function health and live database checks, the coordinator atomically claims ingress for the incoming release and retires previous claims. It then disables cron/storage triggers attached to older active workers of that logical deployment. Their enabled once-per-minute job wake schedules and activation grants remain intact. A missing or altered retained wake schedule refuses handoff. Other logical deployments are not selected.

Only after this disablement succeeds does the existing activation stage enable the new worker's triggers. Provider failure leaves the durable claim available for retry; retries repeat observation and disablement before enabling new ingress. Superseded release keys cannot resume and re-enable old ingress. Planning reports `RELEASE_SUPERSEDED`, retained worker names and the old trigger IDs to disable without writing the claim. Runtime credentials cannot mutate claims.

This sequence is not an atomic provider cutover. Events not delivered during disable/enable gaps are not reconstructed. Old-handler execution and retained-code rollback across a complete two-version cloud deployment, plus safe worker retirement, remain required evidence/work. Local tests prove side-by-side preparation, preserved old resources and grants, interrupted handoff recovery and superseded-release refusal; they do not establish live Neon delivery behavior. Existing unscoped triggers require deliberate migration; the handoff refuses to infer a missing worker-scoped wake schedule.

## Transactional ingress fencing

Generated Neon entrypoints pass a separate ingress verifier to the runtime. It checks the activation grant and current ingress claim for the bound project/branch/deployment/version. Cron enqueue transactions and storage event enqueue transactions hold a shared advisory transaction lock; handoff takes the corresponding exclusive lock before changing the claim. Work admitted before handoff commits or rolls back before cutover. Later old-version ingress is refused, while ordinary activation and old queued-job execution remain authorized.

The verifier requires an explicit READ COMMITTED transaction so the claim read observes a completed cutover after lock acquisition. Shared-lock acquisition polls nonblocking calls for at most five seconds, honoring cancellation between attempts. Handoff retains the deployment connection's lock timeout. Runtime credentials receive SELECT on ingress claims; preflight requires that access and continues to reject writes. Direct users of `createNeonIngressVerifier` must supply the transaction database, not an autocommit connection.

Storage checks ingress before object verification and again inside the final enqueue transaction. Object I/O admitted before handoff can finish afterward, but an old version cannot then enqueue its callback. A refused final check leaves the durable receipt pending for reconciliation. Activation reads inside that transaction use its database rather than opening another pool connection. Wake triggers bypass ingress fencing so retained workers can process their version's queued jobs.

The local concurrency rehearsal observes the exclusive handoff lock waiting on an admitted cron transaction, rejects later old-version cron work and executes the previously queued old handler. It also verifies cancellation while another session owns the lock and refusal of repeatable-read isolation. These results do not prove live provider delivery/retry behavior or implement retirement of old services and sockets.

## Pending storage receipts

Framework metadata version 18 adds a durable retry time to storage receipts. `runtime.storage.events.reconcile(limit, signal)` claims up to 25 due pending receipts by default (valid limits are 1–1000), scoped to the runtime's project, branch, deployment and configured buckets. Concurrent reconcilers use row locks with `SKIP LOCKED`; claims defer another attempt for one minute. A crashed attempt becomes eligible again after that delay.

Reconciliation reuses provider delivery's object verification, saved uploader ownership and atomic job/receipt updates. Already queued effects are not duplicated. Unavailable objects remain pending; invalid objects become failed. Results report claimed, dispatched, failed and pending counts. Cancellation propagates. Removed bucket handlers leave their receipts pending for explicit operator handling; reconciliation does not invent a replacement callback.

Neon schedule invocations first run queued jobs, then reconcile receipts, then run storage cleanup. Running jobs first prevents slow object verification from starving existing work. Jobs created by reconciliation are available to a later worker run. A positively observed different current ingress version returns `inactive: true` without claiming receipts, so retained workers can keep draining their queues. Missing authority, database failures and revoked activation are errors, not evidence of retirement. A cutover during a batch leaves affected receipts pending for the new worker.

This recovers receipts already saved in PostgreSQL. It does not reconstruct storage events never delivered or persisted during a provider cutover gap, and it does not complete old-worker retirement.

## Function receipt

Each prepared entry artifact has a receipt at `.kello/deploy/<artifact-hash>/functions.json`. It records the provider target, build version, artifact hash, archive hashes, function IDs, acknowledged deployment IDs and verified invocation URLs. Every acknowledgement is written before advancing to another function. Receipt writes sync a temporary file, atomically replace the prior file and sync the directory. Archives are published atomically and their hashes are checked before use.

Application environment values are never written to the receipt or archives by the deploy adapter. An HMAC keyed by the activation token binds the original environment, activation binding and slugs to the receipt. A resume with changed inputs fails instead of silently changing a partially applied deployment. Runtime and migration credentials remain separate. Caller-supplied overrides of Neon's identity variables are refused; the outgoing deployment clears old overrides of `DATABASE_URL`, `DATABASE_URL_UNPOOLED` and `NEON_BRANCH` so provider-injected defaults can take effect. Neon documents its [environment merging and deletion behavior](https://neon.com/docs/compute/functions/environment-variables).

| Function state | Evidence                                                    | Resume behavior                                                                                                                 |
| -------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `ready`        | Archive is saved; no submission has started.                | Submit the saved archive.                                                                                                       |
| `submitting`   | Submission began; no acknowledgement is durably recorded.   | Retry only if the function identity and latest deployment still match the recorded baseline. Otherwise stop for reconciliation. |
| `submitted`    | Provider returned a deployment ID.                          | Observe that ID without uploading again.                                                                                        |
| `failed`       | The recorded deployment reached provider failure.           | Retry only if it has not been replaced, retaining prior acknowledged IDs.                                                       |
| `completed`    | Provider reports the exact deployment completed and active. | Verify the same function and deployment still exist, then skip it.                                                              |

Resume by calling `applyNeonFunctions` again with the same prepared entries, slugs and variables. It uses the saved archives even if local entry source changes afterward. It refuses corrupt archives, changed targets, altered inputs, replaced functions and superseding deployments. A failed worker submission does not redeploy an already verified service.

A completed function receipt proves provider deployment completion. It does not prove application health, schema compatibility, correct runtime-role privileges or active scheduling. Those checks belong to the release coordinator before grant and trigger activation.

`inspectRuntimeDatabase` provides the read-only credential authority check for that coordinator. Given the database identity from the verified target, it connects using the exact runtime credentials, checks PostgreSQL 18 and the actual session role/database, and refuses administrative flags, role memberships, database/schema creation privileges and owned objects in the current database or shared catalogs. Both application and metadata schemas must be usable. The activation table must be readable; activation and migration history tables must have no runtime write privileges, including column grants. PostgreSQL's [privilege inquiry functions](https://www.postgresql.org/docs/18/functions-info.html#FUNCTIONS-INFO-ACCESS-TABLE) inspect effective grants, and [shared ownership dependencies](https://www.postgresql.org/docs/18/catalog-pg-shdepend.html) cover types as well as relations and routines.

The check issues no DDL, grants or activation writes and returns only database/role/schema identity. Connection, validation and permission failures share a fixed redacted error. Connection and statement timeouts remain bounded by the dedicated session helper; cancellation is checked before connection and after inspection, not used to interrupt an in-flight query. This is a point-in-time authority check, not a complete audit of trusted SQL functions, application DML grants or schema compatibility. The release coordinator runs it before function preparation and again after health verification; this inspection alone does not activate a release.

Generated service and worker entries also expose `POST /_kello/deployment/health` to the deployment coordinator. It requires `Authorization: Bearer <KELLO_ACTIVATION_TOKEN>` and returns 404 for missing or invalid authorization. An authenticated probe creates a separate runtime using the exact prepared grant: project, branch, database, deployment, version and token still have to match, but the grant may be quarantined or active. The probe never calls that runtime's request dispatcher. It stops the runtime before returning the build version, entry artifact hash and service/worker role, with `Cache-Control: no-store`. Concurrent probes share one startup; shutdown drains it. Startup and cleanup failures return a fixed 503 and may be retried.

Health also reports `databaseDrainProtocol`: the assembled Neon service and worker advertise `1` after successful startup and shutdown of the probe runtime. This identifies the activation-table barrier used by database handlers and storage. Custom or older runtimes without the capability report `0`; older health responses that omit the field are also interpreted as `0`. The health inspector validates and returns each role independently and rejects unknown protocol values. This is evidence of database-drain support, not evidence that requests have drained or that actions, sockets or provider artifacts can already be retired.

Normal requests use a separate runtime whose verifier still requires an active grant. The probe does not run pending jobs, activate grants or validate arbitrary application behavior. Its success proves bundled startup and configured adapter construction, including injected storage configuration; schema compatibility, runtime authority, real storage access and provider resource identity require their separate checks. Generated entry artifacts use epoch 5.

`inspectNeonFunctionHealth` supplies the coordinator-side observation stage. It reads the saved function receipt, requires completed service/worker deployments, and checks current project/branch/endpoint identity plus both provider function IDs, active deployment IDs, completion states and invocation URLs before sending the token. HTTPS requests refuse redirects, use one bounded deadline and accept only a small strict JSON response matching each expected build, entry artifact and role. The provider observations are repeated after both probes. Failed observations use one redacted error; neither success nor failure mutates the receipt or activates resources. A timed-out SDK read cannot continue to a later token-bearing request. The returned identity proof remains a point-in-time observation; the release coordinator repeats these checks on every retry and records the health stage only after subsequent database and runtime-role checks.

`activateNeonTriggers` provides the final provider mutation stage. Its caller must hold the release lock, supply the healthy final worker's function/deployment IDs and the original disabled trigger snapshots, and provide an `assertActive` callback that rechecks the branch-specific database grant. Before each update and at completion, the stage verifies the target, worker identity, exact trigger IDs/names/routes/schedule or storage scope, private storage buckets and the callback. An unexpected enabled trigger on that worker is refused. Other workers are left untouched. Updates change only `enabled`; already-enabled matching triggers are accepted on retry.

Activation is not atomic across triggers. A failed or lost response leaves provider progress intact; a retry rereads every prepared trigger and skips completed updates. The stage never reports success merely from an update acknowledgement: its final provider read must show all selected triggers enabled. Cancellation prevents subsequent writes once observed; an in-flight SDK mutation is awaited. The full coordinator must save these observations in its release receipt and enforce the health/grant/trigger order; this adapter alone is not a complete release command.

`withDeploymentActivationSession` holds the verified database deployment lock while its callback coordinates stages. The callback receives the same owner connection and a frozen session with `quarantinePreview`, `prepare`, `activate`, and `assertActive` methods. Await each method sequentially; do not call connection-owning helpers inside this callback, and complete any direct SQL transaction before invoking a session method. Session methods reject concurrent use, cancellation and use after the callback has ended. Cleanup waits for an already-started method before releasing the connection.

`quarantinePreview` shares the existing atomic revocation and copied-job cancellation implementation. It requires an explicit preview session, rechecks metadata ownership and uses the already-locked connection. Quarantine cancels pending/running jobs and increments their fencing tokens; it is the initial cloned-preview stage, not a harmless resume check after activation. The coordinator must use its release receipt to distinguish those stages. Provider triggers still require separate disablement.

Framework metadata version 20 adds a `retired` activation state. Normal grant preparation and inspection refuse it; activation uses an atomic state predicate that can only activate quarantined or already-active grants. Runtime startup also refuses retired grants. Release planning reports `RUNTIME_RETIRED` for the matching deployment/source version, including when a new release key is used. Retirement state belongs to the grant and is separate from a retired ingress claim, which deliberately leaves an older worker available for queued jobs. The database retirement stage below sets this state after dependency checks and drainage; provider cleanup remains separate. An owner manually changing the state is not proof of safe retirement.

`retireNeonReleaseDatabase(root, options, provider?)` accepts a completed `releaseKey`, its original `activationToken`, and the deployment connection options (`config`, `environment`, `databaseName`, `migrationRole`, optional `signal`). It uses the receipt's deployment/version and requires the same provider target, endpoint, database and namespaces. It owns the deployment lock and requires metadata ownership. No current project-source match is required when retiring an older saved release.

Before changing an active grant, retirement takes the namespace migration lock and verifies both saved function identities through fresh HTTPS health probes. Both must advertise database-drain protocol 1. It then starts a read-committed transaction and acquires the activation table's exclusive lock with NOWAIT. If a handler or storage operation holds the shared barrier, retirement rolls back and asks the caller to retry. Under that barrier it requires retired ingress claims with no current/candidate claim for the same version, no pending/running jobs for that version (or jobs lacking a version), and no unexpired client sessions. Only then does it atomically mark the exact target/token-bound grant retired. An update failure or cancellation before commit rolls back. The migration lock serializes session redemption and migration compatibility checks with this transition.

Retry after a committed retirement verifies the target, token, ingress and dependency state again, without requiring a health probe that the retired grant can no longer authorize. The database grant is the durable acknowledgement; the operation does not rewrite the deployment receipt. It retains all provider functions, triggers, archives and job/session records. This is database-authority retirement, not provider deletion, action-side-effect drainage or forced socket shutdown. Existing presigned URLs retain their provider expiration. Complete provider/service retirement remains unfinished; do not use this result as permission to delete artifacts.

Use `kello retire database --retirement retirement.json --json` to invoke this stage. The strict declaration contains only target identifiers and the activation token's environment variable name:

```json
{
  "format": 1,
  "releaseKey": "<64-character release key from the saved receipt>",
  "environment": "preview",
  "databaseName": "neondb",
  "migrationRole": "migration_owner",
  "activationTokenEnv": "KELLO_ACTIVATION_TOKEN"
}
```

`retireProjectReleaseDatabase(root, file, provider?, signal?)` is the corresponding tooling entrypoint. It loads `kello.config.ts` without compiling the current application schema or functions, so an older saved release remains retireable during source changes. The declaration cannot use `NEON_API_KEY` or the configured migration URL variable as its token source. The command accepts `--cwd` and `--json`; it has no dry-run mode. Usage errors exit 2; retirement failures exit 5 with a redacted `RETIREMENT_FAILED` diagnostic. Success returns the release key, deployment, version and retired state. SIGINT/SIGTERM cancel pending work through the operation's existing abort boundary.

The session's `assertActive` can be supplied directly to trigger activation. It reads the actual grant on the locked connection and requires the exact deployment, version, project, branch, endpoint, database and token hash with active state. This is a fresh observation on each call, not cached authorization. It does not re-observe provider identity or establish code health; the provider stages retain those checks. The existing one-shot preparation and activation helpers use this session internally. The release coordinator uses this session under its release journal and database locks.

`applyMigrationsOnConnection` runs the existing ORM migration pipeline on an active connection owned by Kello, including a connection supplied by `withDeploymentConnection`. Arbitrary clients and clients whose owning callback has ended are refused. The migration advisory lock remains held for the entire connection lifetime, including after this stage returns or a migration fails. Await this stage before other database work and finish any direct SQL transaction before invoking it. The owner closes the dedicated connection and releases all its session locks; callers must not return it to a pool. `applyMigrations` delegates to this same pipeline while owning its own connection.

The shared stage retains generated-version checks, namespace containment, history/catalog drift checks, reviewed-hash requirements and transactional ORM migrations. A failed artifact rolls back and can be retried on the same session after the data is corrected. Pending nontransactional migrations require the explicit recovery path below before release application can continue. The coordinator must still validate project schema state and schema compatibility before activation.

`withDeploymentActivationSessionOnConnection` borrows the connection supplied by `withDeploymentConnection` after migrations have bootstrapped metadata. It accepts release identity/token inputs and derives the target, database, metadata namespace and environment from the connection's verified context. Arbitrary clients and connections outside their owning callback are rejected. The inner session checks metadata ownership, inherits the outer cancellation signal, also honors its own optional signal, and retains the existing session lifecycle guards. It neither opens another connection nor releases the outer lock. The ordinary activation session wrapper delegates to this path while retaining token validation before provider access.

This permits the first release to acquire one deployment lock, apply migrations and create its activation session in order. The session primitives still do not enforce health, runtime credential authority or trigger order; the release coordinator enforces those checks around the session calls.

## Interruption and concurrency

A local lock serializes function applies in a checkout. It does not replace the database deployment lock required by the full release coordinator across machines. An abandoned local lock is not automatically stolen.

Timeouts bound provider status reads, including the SDK's post-deployment inspection. Cancellation does not detach a mutation already in flight: its eventual acknowledgement is recorded before the apply exits and releases its lock. A lost response with a changed remote deployment remains uncertain. The adapter does not guess that the new remote deployment contains its archive or overwrite it automatically. Explicit reconciliation and abandoned-lock recovery remain work for the release coordinator.

## Verification

Integration tests execute the real pinned SDK planner, bundler and apply engine with a controlled provider interface. They cover partial failure, resume, terminal build failure, target drift, replaced deployments, corrupt archives, changed secret inputs, stalled status reads, concurrent applies and cancellation during submission. No live Neon resources were changed by these tests. The release activation fixture additionally exercises database/function recovery with packed runtimes over local HTTPS. Cloud acceptance remains outstanding.

## Disabled trigger preparation

`disableNeonTriggers` disables every schedule or storage trigger attached to the selected worker slugs and verifies the observed result. It does not cancel already-running work or revoke database grants. Preview database quarantine remains a separate operation and must precede activation of copied work.

`prepareNeonScheduleTriggers` creates or reconciles named schedules with `enabled: false`. It requires an existing completed worker deployment and returns the provider trigger IDs and validated runtime bindings. A retry resolves already-created schedules by name; a name attached to another worker or trigger type is refused. The returned bindings must be included in the final worker artifact before any later trigger activation. A completed preparation result proves the schedules were observed disabled, not that a release is active. The release coordinator connects initial worker creation, binding-aware worker deployment, health checks, grant activation and trigger activation in that order.

## Concurrent index recovery

Generate a custom nontransactional artifact whose SQL contains only `CREATE [UNIQUE] INDEX CONCURRENTLY` statements and whose declared schema adds exactly those indexes. Review its hash, then run:

```sh
kello migrations apply --runtime-role app_runtime --reviewed-hash <artifact-hash> --recover-nontransactional
```

The supported subset is ascending column B-tree indexes with default null ordering. Expressions, predicates, included columns, custom operator classes, storage parameters and other nontransactional operations are refused. Both the SQL and snapshot must describe the same index-only expansion over an already applied baseline. The flag does not waive artifact review, source generation or drift checks.

Framework metadata version 13 records the artifact hash, ordinal and baseline catalog fingerprint before DDL starts. PostgreSQL can leave an invalid index after a failed concurrent build; its [CREATE INDEX reference](https://www.postgresql.org/docs/18/sql-createindex.html) documents dropping and rebuilding it. Kello checks ownership and the exact definition before reusing a valid index or dropping and recreating an invalid one. It refuses unrelated catalog drift and mismatched existing indexes. Fix the reported data problem and rerun the same reviewed artifact.

Status reports `NONTRANSACTIONAL_IN_PROGRESS` while the journal exists. Successful DDL followed by a failed history transaction remains recoverable: retry preserves valid indexes and atomically records both ORM and Kello histories with journal removal. Runtime credentials cannot modify the journal. Deployment refuses pending nontransactional work and incomplete recovery; already applied nontransactional artifacts do not block later releases.

Migration and deployment advisory-lock acquisition polls outside SQL transactions, with a five-second wait limit. This avoids a waiting lock statement retaining a virtual transaction that a concurrent index operation needs to finish. Session ownership still bounds lock lifetime; losing the connection releases its locks but preserves committed recovery evidence.

Other nontransactional operations, code rollback, old-handler retention and contraction safety remain unfinished. This path does not establish those broader U16 guarantees.

## Checkpointed row backfills

Write a reviewed SQL file with one update of a Kello table. `$1` is the current batch of UUID row IDs, and the statement must return exactly those IDs as `_id`:

```sql
UPDATE app.tasks
SET description = COALESCE(description, title)
WHERE "_id" = ANY($1::uuid[])
RETURNING "_id"
```

Generate and commit its immutable plan, then apply it with migration credentials:

```sh
kello backfill generate --name task_descriptions --table tasks --sql backfill.sql --batch-size 500
kello backfill apply --backfill backfills/task_descriptions.json --runtime-role app_runtime --reviewed-hash <plan-hash>
kello backfill status --backfill backfills/task_descriptions.json
```

Generation binds the SQL, namespace, table, batch size and committed migration hash. It refuses to overwrite an existing plan. Application verifies the plan hash, explicit review, generated source, applied migration head and catalog evidence. The SQL uses the migration identity and is trusted reviewed code, not a sandbox. Transaction control, multiple top-level writes, writable CTEs, another target table and direct system-field changes are refused. Returned IDs are checked against the locked batch; missing or extra IDs roll the transaction back.

Framework metadata version 14 captures a durable work list of all row IDs visible when a backfill starts. Batches consume this list in UUID order. Each batch locks remaining target rows and atomically commits its data changes, work-list removal and progress counters. A retry does not repeat committed updates, including after a lost commit response. Rows deleted before their batch are counted as `deleted`; they are not silently reported as updated. `processed + deleted` equals `total` at completion. Rows inserted after capture are outside this finite backfill. Deploy compatible writers before starting, so new writes maintain the expanded representation; the runner does not establish that application contract for you.

`--max-batches <count>` stops after that many committed batches and leaves a resumable receipt. SIGINT/SIGTERM drain the current database request and roll back an uncommitted batch; they do not detach a background mutation. Statement timeouts still bound database work. Status reads checkpoint evidence without applying migrations or starting work. Reusing a name with a different reviewed plan is refused, and runtime credentials cannot edit either progress or captured row IDs.

Further schema migrations are blocked while any backfill in that namespace remains running. The existing backfill can resume with a later migration already generated, as long as its applied baseline remains unchanged. Planning or applying a release exposes that block. Completion releases this particular gate; proving old readers/writers are gone remains separate contraction work. Abandoning a partially applied backfill, retiring old services/sockets and general contraction preconditions remain unfinished. Do not edit its ledger to imply completion.
