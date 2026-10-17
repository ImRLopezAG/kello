# Contributing to Kello

Kello is under active development. Start with a focused issue or pull request that explains the intended behavior. Include relevant tests and documentation, and keep generated migration history under review. Never include provider credentials in an issue, commit, or test receipt.

## Development

Use Bun 1.4.2 and Node 24.

```sh
bun install --frozen-lockfile
bun run check
bun run dev
```

`bun run check` runs library builds, typechecks, unit tests, and Vite+ static checks through Turborepo. Vite+ 1.0.0 provides Oxlint, Oxfmt, Vitest, and the library packager; TypeScript is pinned to 7.0.2. Browser and deployed server code are checked separately from Bun tooling. All 15 generic anti-slop rules and the optional Effect rule are enabled.

Source imports are extensionless (`from "./module"`) with TypeScript bundler resolution. `vp pack` produces Node-compatible ESM and declarations. Use `bun run format` to format owned files; historical plans and vendored assets are excluded. Astro retains its framework build command, and integration tests run under Bun for the CLI bundling APIs.

Database integration requires a disposable PostgreSQL 18 database:

```sh
LOOM_TEST_DATABASE_URL=postgresql://user:password@localhost:5432/loom_test bun run test:integration
```

Tests create and clean up their own schemas, databases and roles. Missing database configuration is reported as skipped. Run browser checks with the same connection and `bun run test:browser` after installing Chromium with `bunx --no-install playwright install chromium` from `packages/e2e`.

## CI and release gates

The CI workflow runs a frozen Bun install, builds, TypeScript 7, unit tests, formatting/Oxlint, PostgreSQL 18 integration tests, packed Bun/Node 24 consumers and browser tests. It moves generated build outputs aside and restores them through Turbo before consumer tests. Pull requests receive no provider or publication credentials; checkout credentials are not persisted.

The manual **Neon backend acceptance** workflow runs only from the default branch and uses the `neon-acceptance` environment. Configure its `KELLO_CLOUD_PROJECT_ID` variable and `NEON_API_KEY` secret, and restrict environment deployment to the default branch with maintainer approval. Missing configuration fails required acceptance. Six serial profiles cover native tasks, jobs/storage, services, spread/hot-table live load and populated historical upgrades. Each creates an expiring disposable child branch, requires a fresh success receipt and verifies branch deletion after success or failure.

Actual Neon runs have exercised native Auth sign-up/sign-in, tasks, live subscriptions, signed Object Storage bytes, provider events, durable jobs, safe schema expansion and historical upgrades. The [acceptance record](docs/architecture/orpc-acceptance.md) links functional and performance receipts with their tested runtime versions. GitHub-hosted Neon execution remains unverified. To run locally, supply `LOOM_CLOUD_SUITE` (`tasks`, `jobs-storage`, `services`, `live` or `upgrade`), `KELLO_CLOUD_PROJECT_ID`, `LOOM_CLOUD_BRANCH_ID` and `NEON_API_KEY`, then run `bun run test:cloud` with Playwright Chromium installed. The branch must be unprotected and named `loom-acceptance-*`.

The **Publish alpha** workflow runs when a matching `v<package-version>` tag is pushed, with manual dispatch also available. It uses npm trusted publishing (GitHub OIDC), with `main` and `v*` release tags allowed through the `npm` environment. It requires successful main push CI for the exact commit and a reviewed alpha version before publishing. The initial release candidate is `0.1.0-alpha.0`; its first authenticated publication establishes package ownership before the npm trusted-publisher binding can be configured. See [npm publishing](docs/architecture/npm-publishing.md). No local publication is part of development verification.

## Documentation

The homepage and documentation live in `apps/docs`. Use `bun run dev` after building the local `kello` package. The root command starts only the docs; run an example's development script from its own directory. Keep examples on public `kello/...` imports, and prefer snippets rendered from the typechecked fixture.

If Astro reports an existing docs server, open its printed URL. From `apps/docs`, use `bunx astro dev --force` to replace it or `bunx astro dev stop` to stop it.

Run `bunx turbo run build typecheck --filter=@kello/docs` and `bunx vp lint apps/docs` for documentation changes. Check desktop and mobile layouts when changing UI.

For a deployed documentation site, set `KELLO_DOCS_SITE_URL` to its public origin when building. Astro uses this for canonical URLs and absolute social-preview image URLs. No production hostname is assumed in local builds.
