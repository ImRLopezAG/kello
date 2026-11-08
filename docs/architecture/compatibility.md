# Compatibility baseline

Checked on 2026-09-22. This records dependency compatibility, not completed framework acceptance.

| Component                                   | Pinned version                                                                                     |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Bun                                         | 1.4.2                                                                                              |
| Node verification runtime                   | 24.21.0                                                                                            |
| Turbo                                       | 2.11.2                                                                                             |
| TypeScript                                  | 7.0.2                                                                                              |
| Oxlint and @oxlint/plugins                  | 1.85.0                                                                                             |
| Drizzle ORM and Kit                         | 1.0.0-rc.4; Kit patched for explicit renames and read-only introspection                           |
| PostgreSQL                                  | 18 container, image digest sha256:86c951e05bf56c93d95d397747fb8820ac76cc3bedb78f43abd83eedbe3666ae |
| Astro / React integration / MDX             | 7.3.3 / 6.0.6 / 8.0.1                                                                              |
| React and React DOM                         | 19.3.0                                                                                             |
| Fumadocs core and UI                        | 16.15.13                                                                                           |
| Tailwind and Vite plugin                    | 4.3.3                                                                                              |
| Hono                                        | 4.13.8                                                                                             |
| cron-parser (development calendar matching) | 5.10.1; MIT; Luxon 3.7.2 locked transitively                                                       |
| jose                                        | 6.2.12                                                                                             |
| Neon config-runtime / functions             | 1.6.2 / 0.11.0                                                                                     |
| AWS S3 client / request presigner           | 3.1138.0 / 3.1138.0                                                                                |
| Standard Schema specification               | 1.1.0 (v1 interface)                                                                               |
| Zod / Valibot / ArkType / Effect            | 4.6.5 / 1.5.0 / 2.2.3 / 3.22.2                                                                     |

TypeScript 7.0.2 is user-required. Astro check explicitly rejects its missing programmatic compiler API. Documentation verification therefore uses `astro sync && tsc --noEmit` for TS/TSX and generated collection types, plus `astro build` for page compilation/rendering. This does not supply all Astro-specific `.astro` semantic diagnostics; that remains an upstream compatibility limitation. TypeScript 6 was briefly verified during the probe, then removed from the workspace in response to the user requirement. Standard Schema success results may contain vendor-specific properties (Valibot includes `typed`); consumers must use the standard contract rather than exact object equality.

The Drizzle defect and narrow patch are documented in `patches/README.md`. The migration compatibility suite tests generated SQL without spawning the Drizzle CLI. PostgreSQL integration creates a unique namespace per test and drops only that namespace. Runtime and type fixtures cover RQB v2, nullable references, native UUIDv7, milliseconds, foreign keys, and data-preserving column rename.

The Astro/Fumadocs fixture builds. Its TS/TSX types are checked with TypeScript 7; the Astro-specific semantic-check limitation is described above. React Doctor reported 100/100 with no findings. It is an integration fixture, not the completed documentation site.

Neon connector access is available; read-only lookup found no project matching Kello. Regions were listed successfully. A disposable cloud target has not been selected or created, so Functions, storage, triggers, actual provider PostgreSQL version, and provider quotas remain unverified. Local PostgreSQL success is not cloud acceptance. Select an explicit disposable target before U14-U17 cloud tests; do not reuse unrelated projects.

Effect's optional anti-slop rule is enabled because Effect is a direct test dependency. It covers relative service imports; package-alias imports are not enforced by that rule.

The remote-auth integration fixture requires an `openssl` executable to create a temporary, self-signed test certificate (verified locally with LibreSSL 3.3.6). Only its isolated Node 24 child trusts that certificate through `NODE_EXTRA_CA_CERTS`; TLS verification remains enabled, and the fixture removes the certificate and private key afterward. It does not change machine trust or use a live Neon account.

### Vite+ and extensionless imports

Vite+ 1.0.0-rc.0 is pinned with its matching Vite core alias for Bun resolution. Root checks use bundled Oxlint 1.85.0 and Oxfmt 0.70.0; unit tests use bundled Vitest 5.0.1. Core and tooling build with Vite+ pack and the workspace TypeScript 7.0.2 compiler. Extensionless source imports use Preserve/Bundler resolution, while emitted ESM imports resolve under Node 24. The packager warns that its TypeScript 7 API support is experimental; emitted runtime and declaration consumer checks pass. Astro and Bun integration retain their framework/runtime-specific commands. See the [Vite+ migration rules](https://viteplus.dev/guide/migrate-rules), [lint configuration](https://viteplus.dev/guide/lint), and [pack guide](https://viteplus.dev/guide/pack).
