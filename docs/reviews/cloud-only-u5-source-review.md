# U5 package and source review

Result: no blocking issue found in the inspected U5 changes. Sequential main-thread review under the current AGENTS mapping; not independent model approval or a completed multi-agent CE receipt.

Kello deploys with Vite+/Rolldown through a lazy optional peer, disables application build-config loading, bundles dependencies into the Node 24 archive, and retains fflate for ZIP creation. Ordinary runtime exports do not eagerly import Vite+. The actual bundle test executes CJS and dynamic-import dependencies after removing the source node_modules. Deployment admission, credential handling, archive hashing and provider upload remain in their existing owners. No new auth policy or provider setting is introduced. Local cron/job execution and its exclusive tests are removed; remote job definitions and workers remain.

Documentation and compiled examples now separate declared Neon SELECT subscriptions from finite queries and ordinary HTTP iterators. SQL identity predicates, trusted login generation, expiry, renewal, unknown confirmation and explicit disposal remain documented. The packed full-text consumer retains private-field, runtime descriptor, browser exclusion and positive/negative typing checks using Vite+.

Main verification:

- Build, app three-config types, tests types, e2e types and docs types pass.
- Docs generation and production build pass (39 pages).
- Focused CLI plus real Node archive integration: 10 tests pass, 123 assertions.
- Packed full-text consumer: 1 case passes; 2 positive compiles, 18 negative cases in both optional-property modes, runtime projection/OpenAPI and browser boundary checks, 44 commands settled.
- Targeted lint, formatter and whitespace checks pass.

Logs: `/tmp/kello-u5-{build,final-build,app-types,tests-types,e2e-types,docs-types,docs-build,cli-bundle,packed-consumer,lint,format}.log`. Build warnings remain in the logs. No new provider/browser acceptance is inferred; hosted caller edits were source/typechecked, not deployed here.

## Package measurement

Published baseline: 4,070,763 compressed bytes, 19,458,273 unpacked bytes, 116 files, 27 direct runtime dependencies. Current candidate: 4,005,142 compressed bytes, 19,169,905 unpacked bytes, 115 files, 24 direct runtime dependencies. Direct removals: @vercel/nft, esbuild, cron-parser. Vite+ is an optional peer supplied by the author project as a dev dependency. Candidate identity and archive location are recorded in `/tmp/kello-u5-final-pack.json`.

The lock graph no longer contains cron-parser/luxon. The retained official Neon CLI and bundled config-runtime still require transitive esbuild/NFT: there is no claim of a zero-bundler production dependency closure or a measured installed-size reduction. pg, libpg-query and fflate retain real cloud/migration/archive consumers.

One initial npm pack used the baseline filename in /private/tmp and overwrote it. The candidate was moved to a separate preview path and the original public tarball restored with its exact expected SHA1 fc9e8f4996b541a129cc61306cd5d97e5bc4b144. Final packing uses a unique directory. No published artifact was modified.

U6 real cloud deployment/browser/job/storage, current integrated checks and CI/release acceptance remain open.
