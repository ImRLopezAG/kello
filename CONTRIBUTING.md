# Contributing to Kello

Kello is under active development. Start with a focused issue or pull request that explains the intended behavior. Include relevant tests and documentation, and keep generated migration history under review. Never include provider credentials in an issue, commit, or test receipt.

## Development

Use Bun 1.4.4 and Node 24.

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

### Required local pre-commit gate

`bun install` installs the versioned `.githooks/pre-commit` hook through the workspace
`prepare` script. Existing checkouts can run `bun run hooks:install`. The installer
refuses to overwrite a different hooks configuration.

Before committing, stage your source changes, authenticate with the Neon CLI (or supply `NEON_API_KEY`), and set
`KELLO_CLOUD_PROJECT_ID=late-moon-69483649` and `LOOM_CLOUD_BRANCH_ID` privately in
your shell. The branch must be an explicitly selected disposable, unprotected
`loom-acceptance-*` child. Install Playwright Chromium beforehand. The hook builds
Kello, runs hosted tasks/Auth/RPC acceptance, then the real SDK, generated live
browser, Function/job/storage and cloud preview fixtures. Other example profiles
remain available locally through `LOOM_CLOUD_SUITE` and `bun run test:cloud`;
use a separate disposable branch for each profile. These use disposable
Neon resources and can take several minutes. The Realtime fixtures use their
existing admitted disposable branch with UUID-isolated resources; coordinate
access with other contributors. The hook stops at the first failure.

Missing credentials, failed tests, unstaged tracked changes, untracked source, or
tracked changes during verification block the commit. There is no cached pass. Without an API key, the existing Neon tooling uses
the authenticated CLI profile. `bun run test:precommit` tests the gate with command doubles;
it does not establish actual Neon acceptance. Git hooks are local controls and
can be bypassed through Git configuration; contributors must keep them installed.

CI runs PostgreSQL/PgBouncer, Collector and packed Bun/Node integration tests,
plus typechecking, formatting and lint checks. It builds required package
prerequisites and retains the verified package artifact. It does not run Neon
provider acceptance or require Neon secrets. Provider acceptance runs locally
before commit; the GitHub Neon acceptance workflow has been removed.

The **Publish alpha** workflow checks successful main push CI for the exact
release commit, tag/version/license/package identity and the CI tarball checksum.
It publishes that artifact to npm's `alpha` tag through trusted GitHub OIDC.
CD does not run tests, deploy acceptance resources or rebuild the package.
See [npm publishing](docs/architecture/npm-publishing.md).

## Documentation

The homepage and documentation live in `apps/docs`. Use `bun run dev` after building the local `kello` package. The root command starts only the docs; run an example's development script from its own directory. Keep examples on public `kello/...` imports, and prefer snippets rendered from the typechecked fixture.

If Astro reports an existing docs server, open its printed URL. From `apps/docs`, use `bunx astro dev --force` to replace it or `bunx astro dev stop` to stop it.

Run `bunx turbo run build typecheck --filter=@kello/docs` and `bunx vp lint apps/docs` for documentation changes. Check desktop and mobile layouts when changing UI.

For a deployed documentation site, set `KELLO_DOCS_SITE_URL` to its public origin when building. Astro uses this for canonical URLs and absolute social-preview image URLs. No production hostname is assumed in local builds.
