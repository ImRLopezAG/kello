# Kello

A contract-first reactive TypeScript backend framework for Neon and PostgreSQL.

Kello combines typed functions, schemas, authorization, generated clients, React bindings, and explicitly declared Neon live queries. Applications provide their own trusted login-session resolver for authenticated HTTP live queries.

This package is in development. Alpha releases are experimental. Live queries support explicitly declared flat projections with validated scalar decoding; confirmation means installed transaction progress, and a timeout or disconnect leaves confirmation unknown. Ordinary calls and live issuance use HTTP; Neon’s SDK owns live delivery. Kello does not provide a local backend, custom WebSocket transport or polling fallback.

See the [repository](https://github.com/ImRLopezAG/kello), [examples](https://github.com/ImRLopezAG/kello/tree/main/packages/examples), and [current limitations](https://github.com/ImRLopezAG/kello/blob/main/apps/docs/content/docs/operations/limits.mdx).

Install the runtime separately from development and deployment tools:

```sh
bun add kello
bun add --dev kello-cli vite-plus
```

Use matching Kello and Kello CLI release versions. Import configuration and migration APIs from `kello-cli`; this replaces `kello/tooling`. The `kello` executable belongs to `kello-cli`.

Deployment builds Neon function archives with Vite+ (Rolldown). The deployed functions do not need `kello-cli` or `vite-plus`. `kello dev` watches source and deploys to the linked Neon preview branch. Handlers, jobs and cron schedules execute there; no local backend runs. Stop ends watching and leaves the preview release available.

## Validators and upstream dependencies

Public contracts accept Standard Schema validators, including Valibot and Zod. Standard Schema defines how to call a validator; it does not implement validation itself. Zod is not a required application validator. Kello CLI bundles a patched Zod version for its migration/config tooling. Generated live-query output schemas currently support the verified Valibot and Zod shapes, rather than every Standard Schema implementation.

Neon's current CLI and Auth packages still pin older transitive dependencies. Updating Kello alone does not override those pins in a consuming application. Until upstream releases remove them, Bun applications can add the following to their **root** `package.json`, reinstall, and run their integration checks:

```json
{
  "overrides": {
    "zod@^4": "4.6.7",
    "neon": {
      "@hono/node-server": "2.1.5",
      "diff": "5.2.2"
    }
  }
}
```

The Zod rule applies only to version 4; it does not force dependencies using Zod 3 across a major-version boundary. These overrides are also used in Kello's workspace. Package managers do not inherit a library's root overrides, and this is not a claim that the entire dependency graph is audit-clean. React Email is pulled in by Neon Auth's UI dependencies; Kello does not render email or import React Email directly.

Licensed under MIT. Bundled dependency notices and patches are included in `dist/third-party`.
