# U4 source and security review

Scope: U4 against `7083f8c4`, excluding the pending U5 bundler, dependency and documentation changes. Intent: delete Kello's revision/LISTEN/polling, snapshot reevaluation, custom socket/ticket and generated search-watch engine; preserve Neon `.live()`, finite search, ordinary HTTP streaming and transaction authorization.

Result: no blocking defect found in the inspected U4 production changes. This is a sequential main-thread review under the current AGENTS tool mapping, not an independent model approval or a completed multi-agent CE review receipt.

Checks covered:

- Correctness/API: removed transport routes return 404 before verification; ordinary HTTP retains version, origin, JWT, login expiry, body-size, deadline and rate-limit controls. Native ordinary iteration still cancels and finalizes. Official Neon declaration, issuance and client paths remain separate.
- Security/transactions: transaction-local authorization and replay remain; deleting snapshot instrumentation does not remove per-attempt permission checks. Finite search retains SQL scope, relation policy, cursor binding and private projection handling. Removed live configuration fails validation instead of falling back to polling.
- Migration: version 29 is appended, with versions 1–28 hashes unchanged. Trigger retirement requires both the historical trigger name and the selected metadata function OID; identifiers are validated/quoted. No CASCADE; foreign function dependencies refuse removal. Current baseline/grants stop referencing removed ticket/revision tables. Native upgrade tests preserve unrelated triggers, application data and jobs.
- Tests/maintainability: legacy-only suites are removed with their APIs; mixed HTTP, search, transaction, component and packed consumer suites retain their remaining contracts. Retired listener/coordinator metrics are removed from the bounded oracle rather than replaced by an unbounded label.

Main verification: 151 tests across 16 files passed in `/tmp/kello-u4-review-focused.log`; final retirement/cloud-only/ordinary-stream selection passed 9 tests across 3 files in `/tmp/kello-u4-commit-check.log`. Earlier phase verification includes app build, app/tests/e2e typing, actual ordinary browser streaming, generated packed search/full-text, and native Neon retirement (1 case/10 assertions) and bootstrap (3 cases/121 assertions). The initial bootstrap timeout and intermediate failing expectations remain recorded in the phase checklist and raw logs.

Limits: removed historical file bodies and every edited test body were not reread exhaustively during this final review. Hosted fixture changes are source/typechecked, not hosted runtime acceptance. The changed full collector oracle has not been rerun against Docker. Final integrated CI, U5 packaging and U6 cloud/browser acceptance remain open. No universal process/physical closure or release readiness is inferred.
