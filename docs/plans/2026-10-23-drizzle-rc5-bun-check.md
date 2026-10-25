# Drizzle RC5, oRPC beta.46 and Bun typechecking

Status: implemented candidate on `chore/drizzle-rc5-bun-check`, based on main `052a9a5599a8eab5489f2ea320c030971c9d6f05`. Not committed, merged or published. Real database and Neon acceptance remain required before commit.

## Versions

| Package | Before | Candidate |
| --- | --- | --- |
| drizzle-orm / drizzle-kit | 1.0.0-rc.4 | 1.0.0-rc.5 |
| @neon/realtime | 0.1.0 | 0.1.2 |
| @neon/realtime-drizzle | patched 0.1.0 | patched 0.1.0, RC5 peer |
| effect | 4.0.5 | 4.0.6 |
| @orpc package family | 2.0.0-beta.43 | 2.0.0-beta.46 |
| Effect integration | @orpc/experimental-effect | @orpc/effect |
| Bun / @types/bun | 1.4.2 | 1.4.4 |
| TypeScript | 7.0.2 | unchanged |

Keep coordinated pins across package, peers, examples, project templates and tests. The oRPC Effect integration is now stable under `@orpc/effect`; oRPC v2 itself remains beta. Keep every oRPC package on beta.46; its stable `latest` tag belongs to a different major. Other dependency families are outside this compatibility update.

## Compatibility decisions

- Use upstream `generateMigration(before, after, { hints })`. Delete the custom rename-resolution patch and assert the upstream structured `missing_hints` code.
- Retain the smaller PostgreSQL schema-introspection patch. Explicit schemas, serialized queries, metadata errors and both module formats remain part of its contract.
- Validate Kit's native snapshot v9 envelope before converting to Kello's existing restricted v8 artifact envelope. Do not rewrite committed migrations, hashes, SQL or deployed ledger IDs. Reject unsupported entities and extra properties.
- RC5 relation helpers return SQL chunks, renamed reversal metadata and an optimized query strategy. Assemble SQL chunks explicitly and select `basic` for Kello's nested authorization predicates, which depend on joined aliases. A junction without a join condition fails closed.
- Supply concrete single-statement result types where RC5's raw `execute` now also admits multi-result arrays. Preserve existing runtime row validation.
- Keep the Neon Drizzle adapter's array/JSON parameter patch. RC5's peer range alone does not prove result-decoder parity. SDK 0.1.2's sealed row phantom is a scalar brand containing `__type`; its inference regression now exercises that contract.
- Use `bun check --no-script -p <config>` in typecheck scripts and pin CI to Bun 1.4.4. Preserve root `check` orchestration, build/declaration generation, negative type tests and integration tests. Bun check does not emit declarations.

- Adapt JSON serialization to `serializeJson`/`deserializeJson`, including SSR consumer fixtures. Preserve the persisted RPC protocol identity: a captured beta.43 golden verifies exact bytes and old replay decoding.
- Replace the removed singular iterator schema helper with the public plural helper on each individual schema, preserving any-iterator detection and yield projection.
- Keep native Effect invocation/context/error behavior; beta.46 also changes serialized query keys and type-aware structural sharing, so current cache and hydration regressions remain required.

## Verification

Completed locally on Bun 1.4.4 / Node 26.12.1:

- Final full unit suite: 108 files, 751 tests passed after the compatibility and type corrections.
- Additional migration compatibility: two tests validate all eight committed example plans and reject unsupported native snapshots.
- Programmatic Drizzle migration compatibility: five Bun tests passed.
- Drizzle/Neon adapter compatibility: 12 Node tests passed, including typed seal inference, aliases, parameters, arrays and unsupported inputs.
- Eight workspace builds passed with CI's static example URL settings; package declaration output retained.
- All 19 workspace build/typecheck tasks passed uncached with Bun, including docs and examples. Formatting, lint (existing warnings retained) and diff checks passed.
- Frozen install with lifecycle scripts disabled passed; no install-script execution claimed.
- One same-config comparison (376 test files): Bun 0.350s, tsc 2.081s, both exit 0. This is one local measurement, not a CI performance guarantee.
- Astra low source correctness review and scoped follow-up: no P1/P2 findings. Native/provider behavior was not reviewed as runtime evidence.

oRPC beta.46 follow-up: full workspace build and all 19 build/typecheck tasks passed; full 108-file/751-test unit run passed before adding the persisted replay golden. The affected RPC contract suite then passed with the golden. Separate Bun native Effect/validation and HTTP SSR hydration tests passed (3 tests). Frozen install with lifecycle scripts disabled, changed-file formatting, lint (warnings retained), and diff checks passed. Repository-wide formatting still reports two unchanged historical review documents (`cloud-only-u2-review-r1.md` and `cloud-only-u2-review-r3.md`); those files were not modified. Independent Astra low beta.46 source/API/security review completed with no P1/P2 findings; source-only, no independent runtime rerun or provider acceptance.

Required before commit/merge:

1. Current native PostgreSQL 18 schema-scoped introspection, nested/junction authorization, rename and migration round trips; Node 24 packed consumer coverage. Local configured ports 55432/56432 were unavailable during this check; no infrastructure was started.
2. Existing real Neon precommit gate on the staged candidate using the admitted disposable target and authorized CLI profile. No hook bypass is allowed. The October 25 first gate passed actual Neon auth/RPC/PG18 bootstrap and transaction-progress checks, then blocked commit on generated browser live delivery. The fixture had not admitted its temporary browser origin after the auth fixture changed the provider allowlist. A narrow rerun with exact-origin admission passed all existing browser controls and restored the prior origins; schemas and pool cleaned with no reported errors. Full staged precommit rerun remains required.
3. Exact-head CI after a reviewed commit. The user authorized acceptance and release on October 25. Candidate package version is 0.0.1-alpha.2; publish only after real precommit acceptance and exact main CI pass.

## Sources

- [Drizzle RC4 to RC5 migration checklist](https://notes.drizzle.run/articles/upgrade-rc4-rc5/): undefined/empty relation filters, query strategy, native snapshot 9 and migration hint API. Kello's raw authorized predicates are explicit SQL; ordinary caller-owned Drizzle queries still need the upstream migration rules.
- [Drizzle RC5 release](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-rc.5).
- [Bun check](https://bun.com/docs/runtime/check): built-in checker, `--no-script`, project selection and no emit.
- [Bun 1.4.4](https://bun.sh/blog/bun-v1.4.4).

- [oRPC beta.46 release](https://github.com/middleapi/orpc/releases/tag/v2.0.0-beta.46).
- [Official Effect integration](https://orpc.dev/docs/integrations/effect).

The browser fixture now reads the current provider origin configuration immediately before its temporary admission, preserves all prior entries, and checks current ownership before restoration. Cleanup failures make the fixture fail. Diagnostic output is capped and restricted to fixed stages/error classes and HTTP/WebSocket status numbers; no capabilities, URLs, headers or bodies are emitted. The provider has no atomic compare-and-set here; this disposable branch must remain serialized during acceptance.

A second staged gate stopped on `HISTORY_DIVERGED` before auth deployment: the first successful tasks acceptance had retained its schema-expansion migration, while a new fixture copied the original example history. Tasks acceptance now generates its initial migration only in a UUID-scoped disposable copy and uses that scope throughout expansion checks. Committed example migration artifacts and production migration guards remain unchanged. Successful deployed acceptance resources remain retained under existing fixture behavior; receipts identify the application namespace, metadata namespace and runtime role.
