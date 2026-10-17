# Next.js + Kello

See the [setup and integration matrix](../README.md). This application demonstrates App Router server prefetch, request isolation, native TanStack Query hydration and explicit live subscriptions.

The browser uses `kello/react/neon` with `proxy: true`. The frontend server mounts the official Neon Auth proxy at `/api/auth/*` and forwards `/api/kello/rpc/*` and `/api/kello/session` to the fixed hosted `LOOM_SERVICE_URL`. The HttpOnly provider cookie stays on the frontend host; only its server forwards Neon cookies to that backend. The backend separately verifies the bearer JWT and resolves the actual provider session on every live issuance or renewal.

SSR resolves the incoming provider cookie with the official Neon server SDK and forwards that cookie with its signed access JWT to the hosted backend. Each request owns its client and cache; credentials never enter hydration. Browser navigation uses the same frontend cookie through the same-origin RPC path. A direct browser call to the remote backend cannot carry a frontend-host cookie, even with `credentials: include`.

## Independent backend

This application owns [its contracts](./kello/contracts/examples.ts), [handlers](./kello/functions/examples.ts), [schema](./kello/schema.ts), [application config](./kello/app.config.ts), [auth config](./kello/auth.config.ts), and migrations under `kello/migrations`. It demonstrates Zod contracts and native Effect handlers/services. The frontend imports its own `kello/_generated/react`; no other example package is required.

Configure `.env.example` values for this example's own Neon preview branch and trusted issuer. This example owns database namespace `next_app`, metadata namespace `loom_next`, runtime role `loom_next_runtime`, and its own linked branch. The deployment name defaults to `preview`; link a separate branch for each example. Allow `http://localhost:3000` in `APP_ORIGINS`.

From this directory:

```sh
bun run generate
bun run deploy
# Set NEXT_PUBLIC_LOOM_SERVICE_URL to this deployment's URL, then:
bun run build
bun run start
```

Configure `NEON_*` and `APP_ORIGINS` on the Kello backend. Configure `NEON_AUTH_BASE_URL`, `NEON_AUTH_COOKIE_SECRET` and the fixed `LOOM_SERVICE_URL` on the frontend SSR server as well. These values are server-only; never put secrets in public environment variables. `bun run dev` regenerates this app's client before starting the frontend. `bun run dev:backend` starts the Kello development workflow independently.

Set `NEXT_PUBLIC_LOOM_SERVICE_URL` before building the frontend. Set `LOOM_SERVICE_URL` on the frontend SSR server to that same hosted backend. Neon supplies the backend branch auth URLs; configure the matching `NEON_AUTH_BASE_URL` on the frontend SSR server. External provider examples are not included.

Provider sign-in, SSR hydration, live delivery and revocation still require actual hosted acceptance. Local tests exercise the frontend proxy topology without provider requests; a passing build does not establish cloud acceptance. The service-host cookie topology has a historical multi-`Set-Cookie` delivery blocker. See [the hosted-auth validation record](../../../docs/validation/2026-09-28-hosted-auth-u5-blocker.md).

The browser subscribes to `examples.watch` through Neon Realtime for the initial snapshot and updates. Zod exposes its supported Standard JSON Schema output converter to generate the browser row validator; unrepresentable transforms still refuse generation. The finite `examples.notes` read remains available for SSR.

This example uses `api.examples.watch.useLiveQuery()` with a connecting state until the first snapshot.

Sign-in and sign-out update the provider through the Neon SDK without navigating or reloading. To run without authenticated SSR, render `NotesPanel` without hydration or initial notes; the provider handles browser session initialization.

## Client-only example

Open `/client` after starting the frontend. This route has no server loader, authentication helper, prefetch, or hydration payload. Authentication and data requests start in the browser against the same Kello backend.

[Client page](./app/client/page.tsx) uses Next dynamic loading with `ssr: false` for the notes panel and the generated live-query hook for notes. Next can still render the public page shell.

The root route `/` remains the optional authenticated SSR example. Both routes share the app's notes UI and its own generated client.
