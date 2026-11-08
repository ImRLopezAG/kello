# Drizzle migration API patch

`drizzle-kit@1.0.0-rc.5.patch` modifies only the PostgreSQL API bundles (ESM/CommonJS) and their declarations. Bun applies it through root `patchedDependencies` and records its hash in the lockfile.

RC5 supplies the upstream `generateMigration(before, after, { hints })` API and structured `missing_hints` errors. Kello no longer patches rename resolution. SQL generation remains Drizzle-owned.

The remaining patch exposes `inspectSchema(database, schemaFilters)` through Drizzle's existing PostgreSQL introspector and snapshot serializer. Empty schema selection and unsupported introspection metadata fail closed. Queries run serially on the caller's dedicated session; the caller controls isolation and locking. Kello validates a single selected namespace and the returned entity vocabulary. ESM and CommonJS initialize the introspector before its first call.

RC5 returns version 9 snapshots. Kello validates the native envelope and its restricted entity vocabulary, then stores its existing version 8 envelope. Committed migration files, SQL, hashes and deployed ledger identifiers remain unchanged. Tests validate all eight committed example plans; unsupported native entities or extra properties are rejected rather than discarded. This conversion belongs to Kello's private artifact adapter; users should follow Drizzle's own upgrade instructions for standalone Drizzle Kit journals.

Current offline checks cover additive generation, ambiguous table/column rejection, explicit renames, invalid source rejection and snapshot conversion. Real PostgreSQL introspection, populated rename, packed consumers and Neon acceptance must pass again for RC5; previous-version runtime evidence is historical.

The published package declares MIT licensing, while the upstream repository root separately carries Apache-2.0. Preserve upstream package provenance and notices when distributing tooling. The API version and patch are part of Kello's compatibility baseline.

## Neon bucket privacy metadata patch

`@neon%2Fconfig@1.13.0.patch` changes only `normalizeBucketAccessLevel` and its explanatory comment in `dist/lib/neon-api-real.js`. The upstream package carries Apache-2.0 licensing. Preserve its license and notices with any distribution. The dependency is pinned directly and transitively through `@neon/config-runtime@1.12.0`, and Bun applies the exact patch from the root manifest and lockfile.

The original SDK converts missing and unrecognized `access_level` values into `private`. That default cannot prove that an existing remote bucket is private. The patch accepts exactly `private` and `public_read`; all other responses throw before a normalized snapshot reaches Kello. It does not change provider requests, known access values or API types.

A pre-patch integration regression accepted `public_write` metadata instead of rejecting it. The patched fixture rejects unknown and missing metadata, rejects public buckets through Kello's policy and still accepts explicit private buckets. A separate clean installation and frozen reinstall of the pinned SDK exercises the patch in Node. Removing/upgrading this patch requires these tests to pass against the replacement SDK. Consumer distribution must preserve the patch (or include an upstream equivalent); root workspace patch settings do not propagate automatically to published package consumers. Packed storage deployment acceptance remains a release gate until that packaging is established.

## Neon Realtime Drizzle parameter patch

`@neon%2Frealtime-drizzle@0.2.0.patch` changes `encodeDrizzleParameter` in `dist/adapter.js` and widens the `drizzle-orm` peer range in `package.json` to include `1.0.0-rc.5`. Drizzle RC leaves PostgreSQL arrays and JSON objects for the driver to encode. The patch encodes arrays (nested arrays, `NULL`, quoted strings and scalars) and plain objects as PostgreSQL text, and still rejects class instances such as unbound placeholders. Upstream 0.2.0 still rejects both and still declares only `>=0.45.2 <0.46.0`, so the patch carries forward unchanged from 0.1.0.

## Packed tooling delivery

Tooling now bundles the patched Drizzle PostgreSQL API, `@neon/config-runtime` and `@neon/config` in its JavaScript and declarations. Vite+ permits only these dependencies to be bundled; other runtime imports are explicit pinned dependencies, including platform-installed esbuild. This avoids relying on consumer patch settings or install scripts. The two SDK packages remain build-time dependencies so the bundle is produced from the frozen workspace installation.

The build writes `dist/third-party/` with exact package metadata, available upstream license files, patch diffs and SHA-256 records. Upstream comments and source-map source content are retained. The published Drizzle archive lacks a standalone LICENSE file; its package metadata says MIT while the repository root says Apache-2.0. The artifact records that discrepancy; publication still requires the pending license review.

The packed-consumer test installs core/tooling tarballs outside the workspace using Bun's isolated linker and performs a frozen reinstall. No consumer `patchedDependencies` or workspace aliases are supplied. A local tarball override resolves the unpublished `@kello/core@0.0.0` dependency. Bun and Node 24 both exercise explicit rename generation and ambiguity rejection plus real bundled SDK response parsing for private, public, unknown and missing bucket access levels. Provider HTTP is an in-process fixture; no cloud acceptance is claimed.

## oRPC Effect extension declaration patch

`@orpc%2Feffect@2.0.0-beta.49.patch` adds the missing `DecoratedProcedure` type import to `dist/extensions/effect.d.ts`. From beta.47, oRPC emits one declaration file per source module instead of bundled `.d.mts` files. The `@orpc/server` augmentation then references `DecoratedProcedure` without importing it, so every `.effect(...)` builder call returns an unresolved type. Router clients infer `never` as the initial context, and `createRouterClient` stops checking input and required services. Runtime JavaScript is unchanged.

`packages/tests/types/orpc-compatibility.test-d.ts` and `rpc-contracts.test-d.ts` catch the regression.

Root `patchedDependencies` never reaches published consumers, so the runtime build bundles `@orpc/effect` (`apps/kello/vite.config.ts`, `deps.alwaysBundle`). The patched declaration, including its `@orpc/server` augmentation and the restored import, is emitted into Kello's own `.d.ts` files, and `@orpc/effect` is a build-time dependency only. Its oRPC and Effect dependencies remain external, so the extension augments the application's single `@orpc/server`. `apps/kello/scripts/third-party.ts` records its MIT license, metadata and patch hash in `dist/third-party/`. A packed tarball installed outside the workspace, with no patch settings, type-checks `.effect()` outputs and rejects a missing invocation context. Reported upstream in middleapi/orpc#2446. Once a fixed release ships, drop the patch and decide whether to keep bundling.
