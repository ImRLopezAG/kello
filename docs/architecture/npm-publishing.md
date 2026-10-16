# npm publishing

Kello uses the same GitHub Actions OIDC approach as cvx-kit. The publish workflow uses short-lived npm credentials issued for the trusted workflow; no npm token belongs in GitHub secrets or repository files.

## Identities

- Repository: `ImRLopezAG/kello`
- Package: `kello`, from `apps/kello`
- Workflow: `release.yml`
- GitHub environment: `npm`, restricted to the `main` branch
- Distribution tag: `alpha`
- Project license: MIT

The package repository metadata must match the renamed repository. The current `0.0.0` version is deliberately not publishable by this workflow. A reviewed `x.y.z-alpha.n` version must be committed first.

## npm account setup

Authenticate locally with `npm login --registry=https://registry.npmjs.org`, then verify `npm whoami`. Do not paste tokens into chat or commit them. Existing local credentials returned HTTP 401 during setup and were left unchanged.

The registry returned 404 for `kello` during setup; this is not a reservation or a guarantee of publish permission. Establish package ownership under the intended npm profile before relying on CI publication. If a first authenticated publication is required to establish ownership, review the built artifact and authorize that initial publication separately.

In the package's npm settings, configure a GitHub Actions trusted publisher with owner `ImRLopezAG`, repository `kello`, workflow `release.yml`, and environment `npm`. Allow direct `npm publish` for this workflow. Alternatively, after authentication, use the current npm CLI's `npm trust` command with those exact bindings. Do not create a trust binding to the former `loom` repository name.

Complete the first successful trusted publication within npm's current configuration expiry period. After confirming trusted publication works, require 2FA and disallow token-based publishing for this package. This does not disable OIDC publishing.

## Release

After the reviewed alpha version and publishing configuration reach main, require successful push CI for that exact commit. Manually dispatch **Publish alpha** on main. The workflow checks the exact commit's newest main push CI, validates package identity/version/license, performs a frozen Bun install, builds only Kello, inspects the package with a dry run, and publishes with OIDC to `alpha`.

After publication, independently verify `npm view kello@<version> version dist-tags dist --registry=https://registry.npmjs.org --prefer-online`, download the published archive, and verify its exports, license, dependency notices, and clean-consumer behavior. A successful workflow configuration or dry run is not a completed publication.

References: [npm trusted publishers](https://docs.npmjs.com/trusted-publishers/) and [npm trust](https://docs.npmjs.com/cli/v11/commands/npm-trust/).
