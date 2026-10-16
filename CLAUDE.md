# Kello development

Use Bun for installation, scripts, the CLI, and unit tests. Pin dependencies and keep one root bun.lock. Use Oxlint with all bundled anti-slop rules enabled; fix violations instead of suppressing rules.

This is a Bun/Turborepo workspace. apps/kello owns the public kello package: the compiled CLI, runtime, and build/migration/deployment implementation. Consumers use kello/... exports. Unit tests belong in packages/tests; database, browser, and cloud checks belong in packages/e2e. packages/examples is a grouping directory, not a package.

Runtime libraries target Node 24 and browsers. Do not introduce Bun globals into deployed server or browser exports. Use the Node PostgreSQL adapter at that boundary. Astro's supported Vite, React, and MDX integration is required for apps/docs. Keep browser exports isolated from server code and credentials.

Use strict runtime-specific TypeScript presets from packages/ts-config. Export compiled ESM and declarations from libraries. Do not use workspace source aliases in consumers.

Run build, typecheck, lint, and relevant tests before committing. Database checks require PostgreSQL 18; report missing cloud credentials as skipped, never passed. Side-effecting tasks must not be cached. Never run migrations on request startup or expose migration credentials to the runtime.

The framework plan in docs/plans defines implementation and acceptance. Track execution evidence outside the plan body. Preserve unrelated work and stage explicit paths.
