# Authoring and Neon acceptance — 2026-09-24

## Delivered behavior

- Projects default to `kello/`, with committed migration history in `kello/migrations`.
- `_generated` exposes stable current imports. Immutable build artifacts live in `.kello/generations`, retaining the active build and one prior cached build. Deployment entries carry their own runtime files and survive generation pruning.
- Generated server builders bind project relations once. Handler outputs infer automatically when `returns` is omitted. Explicit public validators remain where they strip private fields.
- `schema.id("projects")` validates UUID syntax and supplies a table-branded type. It does not assert row existence; database constraints and authorized queries enforce that separately.
- `kello dev` and `kello deploy` read `kello.config.ts`. Environment variable references separate migration and runtime credentials. Development and preview targets use separate branch settings.
- Example setup scripts moved into e2e fixtures. Normal example frontends use Neon Auth; fixture identities are restricted to acceptance builds.
- Storage bytes use Neon Object Storage. PostgreSQL holds ownership, metadata, upload intents, event receipts and durable jobs. Provider credentials remain server-side.

## Real Neon acceptance

Project: `late-moon-69483649` (`kello`). The main branch was not modified. These isolated acceptance branches expire on 2026-09-25 at 18:00 UTC:

| Branch                      | Purpose                                             | Result                                   |
| --------------------------- | --------------------------------------------------- | ---------------------------------------- |
| `br-purple-meadow-awprgkgk` | Tasks and actual Neon Auth frontend                 | Passed                                   |
| `br-morning-dawn-aw1g7qcz`  | Jobs and Object Storage                             | Passed                                   |
| `br-falling-moon-awrymaws`  | Initial storage attempt before shared-relations fix | Superseded by the passing storage branch |

`cloud/functions.test.ts` passed for tasks (63 seconds) and jobs-storage (221 seconds). Storage acceptance exercised signed direct uploads, exact downloaded bytes, owner isolation, provider object-created delivery, successful processing, retry and terminal failure.

`cloud/neon-auth.test.ts` passed in 45 seconds against actual Neon Auth and deployed Neon Functions. It used the normal tasks frontend for sign-up, project/task mutations, live updates, sign-out and sign-in with persisted data. The Neon SDK supplies its refreshed JWT through `getSession().data.session.token`.

The temporary acceptance API key was revoked and local credential response files removed. Application releases use separate restricted runtime roles; acceptance did not deploy migration credentials to functions.

## Verification and review

`bun run check` passed all 15 tasks: builds, TypeScript 7 checks, Vite+/Oxlint anti-slop checks and 173 unit tests across 42 files.

The isolated PostgreSQL 18 integration run passed all 111 tests across 67 files (941 assertions, 131 seconds). The browser regression suite passed all five tests, including packed-package consumption, tasks, documentation, live hooks and uploads (32 seconds). An earlier integration run had one five-second runtime timeout during concurrent cloud testing; both the focused rerun and this full isolated rerun passed.

The code review ran sequentially in the main thread, following the workspace instruction. It covered correctness, repository standards, tests, maintainability, security, API contracts, migration moves, reliability, adversarial failure cases and React races. This was not independent or cross-model review. One remaining manual project-list return declaration was removed; ID runtime coverage was added. Explicit output filtering on create operations was preserved.

React Doctor scanned the entire workspace rather than recognizing the changed-file scope and reported 49/100. Its two errors classify server adapter sourcemaps as browser artifacts; those adapters are server exports. Other warnings refer to acceptance bundles, deliberate fail-fast config URL parsing, an abort-guarded polling effect, an object URL revoked in `finally`, default submit buttons and pre-existing server execution code. These reports were inspected; they do not establish credential exposure or a new React defect.

Local PostgreSQL 18 and fixture S3 tests provide injected-failure regression coverage. They are recorded separately from real Neon acceptance. Provider deletion after the 24-hour cleanup window and late-upload behavior were not exercised by this cloud run.
