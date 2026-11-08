# Historical client fixture

`client.js` is the actual pre-migration client from commit `b8ddb6a9d7bb398f8e2993ae6cafe7710ba1dafc`, bundled with Bun 1.4.2. Upgrade tests use it to verify terminal refusal without retaining a supported legacy client in `@kello/core`.

SHA-256: `8346b176dc200580a90e4d5dc4f4a063891ab7ae336db48ce8fb10a1caf4b241`.

To reproduce, archive that commit, run `bun install --frozen-lockfile`, and build `packages/core`. Create an entry file containing `export { createClient } from "<archive>/packages/core/dist/client/index.js";` and run `bun build <entry> --target browser --minify --outfile client.js`. The fixture includes its original validation dependency. Do not format or rewrite the bundle. The adjacent declarations describe only the historical methods exercised by these tests.

This artifact is test-only and excluded from lint/format transforms to preserve its hash. It is not included in the core package or generated application bundles.
