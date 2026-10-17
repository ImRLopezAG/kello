# Kello examples

These applications use generated oRPC clients. They do not replace TanStack Query's options, cache, hydration, or mutation APIs.

| Example                        | What to examine                                                                                                                                                            |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [integrations](./integrations) | Standalone schema comparison backend: Zod, Valibot, mixed schemas, Effect handlers/services, Effect Schema, typed errors, finite reads and explicit live contracts         |
| [next](./next)                 | Own Zod + Effect backend, Next.js App Router, request-scoped server prefetch, React Server Components, Query hydration, browser Neon Realtime subscriptions                |
| [start](./start)               | Own Valibot + async-handler backend, TanStack Start loader/server function, request-scoped QueryClient, native Router SSR integration, browser Neon Realtime subscriptions |
| [tasks](./tasks)               | React/Vite, Neon Auth, Valibot validators, relational tasks and optimistic updates                                                                                         |
| [jobs-storage](./jobs-storage) | Neon Auth, Object Storage, durable jobs and live upload state                                                                                                              |

## Run the Next.js and Start examples

Use Node 24 and Bun 1.4.2. From the workspace root:

```sh
bun install --frozen-lockfile
bunx turbo run build --filter=@kello/example-next --filter=@kello/example-start
```

Each framework example owns its `kello/` contracts, handlers, schema, migrations, application/auth configuration, and generated client. Neither depends on `example-integrations` or the other frontend. `build` generates the local client before building the frontend.

From each example directory, run `kello login` and `kello link --project-id <project> --branch <isolated-branch>` for **its own disposable Neon branch**. Linking discovers the database and owner; operational configuration is optional. Next and Start retain only their custom database namespaces in `kello.config.ts`. Authentication policy lives in `kello/auth.config.ts`; Neon supplies the branch auth URLs to deployed functions. Set `APP_ORIGINS` for the frontend, review the migration, and run `bun run deploy`. Use separate branches for separate examples; the default deployment name is `preview`.

Set `NEXT_PUBLIC_LOOM_SERVICE_URL` (Next) or `VITE_LOOM_SERVICE_URL` (Start) to that example's own deployed Kello service before building. These URLs are public. `NEON_AUTH_COOKIE_SECRET` belongs only on the Kello backend, not the frontend. The backend's `APP_ORIGINS` must include the frontend's exact origin.

Both frontends use `createKelloNeonReact(createClient, { serviceUrl })`. Neon's SDK owns the session; auth endpoints live under the Kello service's `/api/auth/*`. Neither frontend mounts an auth proxy. Kello retrieves a signed token, verifies identity before opening consumers, scopes its cache to that identity, and tears down connections on session changes.

Private SSR prefetch is optional: an incoming bearer header permits request-scoped prefetch and hydration. Ordinary browser visits render a shell and restore the session client-side, because a separate service's cookies cannot be read by the frontend server. WorkOS and Clerk examples are not included.

The managed Neon Function multi-cookie delivery failure remains an open acceptance issue; see [the validation record](../../docs/validation/2026-09-28-hosted-auth-u5-blocker.md). Builds and mocked routing tests do not establish live hosted sign-in acceptance.

## Client-only routes

Both Next.js and TanStack Start include `/client` routes with SSR disabled for the notes UI, no server auth helpers, and no query prefetch or hydration. Next uses a regular live query; Start uses a Suspense live query. The existing `/` routes demonstrate optional authenticated SSR.

- [Next.js client-only page](./next/app/client/page.tsx)
- [TanStack Start client-only route](./start/src/routes/client.tsx)

## Server and browser clients

Both factories are generated from the same required contracts:

```ts
import { createClient, createServerClient } from "./kello/_generated/api";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";

// Server request: native fetch transport, no browser Origin or persistent socket.
const server = createServerClient({ url, getToken: async () => requestToken });
try {
  const rpc = createTanstackQueryUtils(server.client);
  await queryClient.query(rpc.examples.notes.queryOptions());
} finally {
  server.dispose();
}

// Browser session: HTTPS calls; `.live()` procedures subscribe through Neon Realtime.
// realtimeUrl defaults to the discovered configuration.realtimeUrl.
const browser = createClient({ url, getToken });
const rpc = createTanstackQueryUtils(browser.client);
// useMutation(rpc.examples.add.mutationOptions())
// Dispose when this session ends.
```

Create a new server client and QueryClient per request. Never put an authenticated server client/cache in a module singleton. Only finite reads are prefetched; live streams start after mounting and are cancelled on unmount. The SSR payloads in these examples are JSON-safe. Native RPC itself supports Date and other rich types, but adding those to dehydrated query data requires the framework's matching serialization/deserialization configuration. Do not assume JSON hydration preserves every RPC type.

## Schema and Effect variants

Next has [Zod contracts](./next/kello/contracts/examples.ts) and [Effect handlers](./next/kello/functions/examples.ts). Start has [Valibot contracts](./start/kello/contracts/examples.ts) and [async handlers](./start/kello/functions/examples.ts).

The independent schema comparison backend is useful for comparing libraries side by side. Read [contracts](./integrations/kello/contracts/examples.ts), [handlers](./integrations/kello/functions/examples.ts), and [application middleware](./integrations/kello/app.config.ts).

- `zod`: Zod input trims names before the handler, with a Zod output contract.
- `mixed`: Zod input with Valibot output and a Promise handler.
- `effect`: native `.effect(...)`, an injected `Greeting` service, and a contract-declared `REJECTED` error.
- `effectSchema`: Effect Schema adapted through `Schema.toStandardSchemaV1`.
- `notes`: generated `Database` and `Tables` Effect services; issuer-and-subject ownership filters and the latest 50 notes.
- `add`: Zod mutation input and database-backed persistence. No automatic mutation retries.
- `watch`: a `.live()` contract whose handler returns one Drizzle SELECT with its ownership predicate in SQL; the browser subscribes with the generated `api.examples.watch.useLiveQuery()`.

Standard Schema lets each boundary use its chosen library. It does **not** make a Valibot schema directly nestable inside `z.object`, or guarantee that arbitrary transforms can be represented in OpenAPI. Generated table validators remain Valibot. The table field validation example uses a Zod schema independently. Unsupported OpenAPI schema conversions fail rather than silently advertising unconstrained data.

## Verification

```sh
bun run check
LOOM_TEST_DATABASE_URL=postgresql://... bun test packages/e2e/integration/server-client.test.ts packages/e2e/integration/example-variants.test.ts
LOOM_TEST_DATABASE_URL=postgresql://... bun test packages/e2e/browser/frameworks.test.ts
```

The browser tests start each production build against its own local Kello project and disposable database, use actual PostgreSQL and authenticated Kello transports, check server-rendered data, simultaneous users, hydration, two-tab updates, ownership, sign-out and responsive layouts. Their short-lived JWT issuer and disposable local database are test fixtures only. These checks do not prove deployment to Vercel, Cloudflare, or every hosting provider. Neon-hosted acceptance is recorded separately in `docs/architecture/contract-first-execution.md` and is not a claim that these new frontend examples ran in those providers.

Upstream references: [oRPC TanStack Query and SSR](https://orpc.dev/docs/integrations/tanstack-query), [oRPC Effect](https://orpc.dev/docs/integrations/effect), [TanStack Router query hydration](https://tanstack.com/router/latest/docs/integrations/query), [TanStack Start hosting](https://tanstack.com/start/latest/docs/framework/react/guide/hosting), [Next.js App Router](https://nextjs.org/docs/app).

## Shared client and React context

Each app binds the package provider to its own generated client once, in `lib/kello.ts` (under `src` for Start):

```tsx
"use client";
import { createKelloReact } from "kello/react";
import { createCookieSession } from "kello/client";
import { createClient } from "../kello/_generated/api";

export const { KelloProvider, useKello } = createKelloReact(createClient);
export const session = createCookieSession("/api/session");
```

Wrap the authenticated subtree with `KelloProvider`. Pass a memoized `auth={session.auth(sessionId)}`, the backend `url`, and an SSR `fallback`. The session ID is a SHA-256 credential fingerprint calculated on the server; it contains no bearer token. The required `onSessionChange` callback can reload the page or navigate through your router. The examples reload after session changes so server-rendered identity and data are refreshed together.

```tsx
function Notes() {
  const { rpc, api } = useKello();
  const notes = useQuery(rpc.examples.notes.queryOptions());
  const live = api.examples.watch.useLiveQuery();
  const add = useMutation(rpc.examples.add.mutationOptions());
  // Native oRPC options, inferred inputs/outputs, and native TanStack hooks.
}
```

The provider creates the connection after mount, closes it on unmount or identity changes, and clears the associated query cache when the identity changes. It uses an enclosing TanStack `QueryClientProvider` when present (including Start's SSR integration), accepts an explicit `queryClient`, or creates one. Give each authenticated application a dedicated cache: identity changes clear that cache, including non-Kello entries. Keep `auth` referentially stable to avoid reconnects. Ordinary unmounts preserve the cache. A session notification suspends rendering until the callback supplies a new `auth.sessionKey`; the previous SSR fallback is hidden to avoid displaying the old identity’s data. The fallback renders on both the server and the initial client pass, so live iterators never delay SSR.

For SSR, create a fresh `createQueryClient()` from `kello/client` and call the generated `createServerClient({ url, getToken })` for each request. It returns `{ client, rpc, dispose, ...transport }`; `rpc` is the native oRPC utility object. Dehydrate only finite, authorized results. Dispose the connection and clear the request cache in `finally`. Never keep a server connection or query cache in module scope.

## Optional cookie session bridge

`createCookieSessionHandler` from `kello/server` implements the `/api/session` endpoint. Supply `verify(token, signal)` to authenticate against your own identity provider or a protected backend procedure. `lib/session.ts` contains only that application policy and the service URL. Both Next route handlers and Start server routes delegate to the same Fetch `Request`/`Response` handler.

The bridge uses an HttpOnly, SameSite=Lax `loom_session` cookie, adds Secure on HTTPS, checks mutation origins, bounds tokens to 3800 ASCII characters, and binds token reads to the page's fingerprint. Responses are not cacheable. The browser adapter intentionally obtains the bearer token for authenticated HTTP calls and live issuance; this is not an identity provider, token refresh service, or protection against same-origin XSS. Applications with an existing auth SDK can skip the bridge and supply `KelloAuth` (`sessionKey`, `getToken`, optional `subscribe`) directly. `subscribe` must notify when identity changes; change `sessionKey` and replace the auth object when switching users.

## Migration history

The examples keep reviewed migration SQL and plans under `kello/migrations`, selected explicitly by `database.migrations`. Commit this history: rebuilding bindings cannot reconstruct the exact migrations already applied. Generated bindings under `kello/_generated` remain ignored, and build-cache pruning leaves the source migration directory intact.

New projects default to `<backend>/_generated/migrations`. If you keep that default, retain migration history with `kello/_generated/*` and `!kello/_generated/migrations/`. To keep all of `_generated` disposable, configure `database.migrations: "kello/migrations"` and keep the reviewed history there. Move existing SQL and plans intact; never create a second initial history.
