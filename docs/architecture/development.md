# Cloud preview development

`kello dev` runs author tooling locally and publishes application handlers to the linked Neon preview branch. See the [development guide](../../apps/docs/content/docs/operations/development.mdx) for commands.

`startProjectDevelopment(root, file?, provider?, signal?)` loads watch pacing and calls `startDevelopment({root, file, debounceMs, signal}, provider?)`. Setup validates the release declaration, requires preview, inspects the current provider target and matches it to the saved link. The target must be unprotected and nondefault. No local handler server, application WebSocket listener, job worker or cron scheduler is created.

The filesystem watcher ignores generated output and build directories. Its coordinator serializes revisions, debounces saves, aborts superseded work and coalesces pending saves. Each revision generates the project, skips an unchanged source version, rechecks the preview link and invokes `deployProjectRelease` with its cancellation signal. Successful deployment publishes remote coordinates through the release path; a failed revision retains the prior active release. Schema edits require migration artifacts and use ordinary release admission.

The returned `active` contains source version and branch ID; `url` identifies the remote service. `failure` and `watchError` expose update and watcher failures. `flush()` runs pending debounce and awaits known work; `settled()` awaits known work without forcing debounce. `stop()` closes the watcher, aborts pending/running work and awaits release cleanup. The external signal remains effective during asynchronous setup and after return; stop removes its listener. Neither cancellation nor stop deletes the preview branch or tears down the remote release.

The command observes SIGINT/SIGTERM before setup, reports safe lifecycle messages, and releases its signal handlers on every exit. Dev-local diagnostics attachment and its output-file watcher exclusion have been removed. Standalone deployment/cloud diagnostics remain available through `startDiagnostics` in the process being observed.

The local server, generation replacement, development runtime, development history/synchronization, local target/connection and development quarantine APIs are removed in this alpha. The schema-provisioning credential validator now lives in `deploy/neon/credentials.ts`; endpoint, direct connection, database, role and query-override checks retain their prior behavior. Deployment activation still uses release quarantine with clone/preserve semantics.

Offline tests exercise preview guards, serialization/coalescing, failed-edit recovery, unchanged-version suppression, sticky cancellation, publication cancellation, HTTP component access policies and diagnostics. PostgreSQL/cloud execution and final release acceptance are separate gates; no offline result establishes provider acceptance.
