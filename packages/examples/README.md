# Kello examples

These applications use generated oRPC clients. They do not replace TanStack Query's options, cache, hydration, or mutation APIs.

| Example                        | What to examine                                                                                                                                                    |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [integrations](./integrations) | Standalone schema comparison backend: Zod, Valibot, mixed schemas, Effect handlers/services, Effect Schema, typed errors, finite reads and explicit live contracts |
| [next](./next)                 | Own Zod + Effect Neon backend, Next.js client UI, direct authenticated RPC and Neon Realtime subscriptions                                                         |
| [start](./start)               | Own Valibot + async-handler Neon backend, TanStack Start client UI, direct authenticated RPC and Neon Realtime subscriptions                                       |
| [tasks](./tasks)               | React/Vite, Neon Auth, Valibot validators, relational tasks and optimistic updates                                                                                 |
| [jobs-storage](./jobs-storage) | Neon Auth, Object Storage, durable jobs and live upload state                                                                                                      |

## Run the Next.js and Start examples

Use Node 24 and Bun 1.4.2. From the workspace root:

```sh
bun install --frozen-lockfile
bunx turbo run build --filter=@kello/example-next --filter=@kello/example-start
```

Each framework example owns its `kello/` contracts, handlers, schema, migrations, application/auth configuration, and generated client. Neither depends on `example-integrations` or the other frontend. `build` generates the local client before building the frontend.

From each example directory, run `kello login` and `kello link --project-id <project> --branch <isolated-branch>` for **its own disposable Neon branch**. Linking discovers the database and owner; operational configuration is optional. Next and Start retain only their custom database namespaces in `kello.config.ts`. Authentication policy lives in `kello/auth.config.ts`; Neon supplies the branch auth URLs to deployed functions. Set `APP_ORIGINS` for the frontend, review the migration, and run `bun run deploy`. Use separate branches for separate examples; the default deployment name is `preview`.

Set `NEXT_PUBLIC_KELLO_SERVICE_URL` (Next) or `VITE_KELLO_SERVICE_URL` (Start) to that example's own deployed Kello service before building. These URLs are public. `NEON_AUTH_COOKIE_SECRET` belongs only on the Kello backend, not the frontend. The backend's `APP_ORIGINS` must include the frontend's exact origin.

Both frontends use `createKelloNeonReact(createClient, { serviceUrl })`. Neon's SDK owns the session; auth endpoints live under the Kello service's `/api/auth/*`. Neither frontend mounts an auth proxy. Kello retrieves a signed token, verifies identity before opening consumers, scopes its cache to that identity, and tears down connections on session changes.

The frontend renders a public shell and restores its session client-side. Authentication, session resolution and RPC handlers run on the deployed Neon Function, independently of the frontend host. No `auth.ts`, auth route, RPC proxy or `withSession` wrapper is needed. Both `/` and `/client` use this architecture.

The managed Neon Function multi-cookie delivery failure remains an open acceptance issue; see [the validation record](../../docs/validation/2026-09-28-hosted-auth-u5-blocker.md). Builds and mocked routing tests do not establish live hosted sign-in acceptance.

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

Optional server clients are consumers of the same deployed backend. The examples use client-side session restoration and do not prefetch private data. Never put an authenticated server connection or cache in a module singleton.

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

## Client and React context

Each example binds its generated client to the deployed Function once:

```tsx
import { createKelloNeonReact } from "kello/react/neon";
import { createClient } from "../kello/_generated/api";

export const { KelloProvider, useKello, auth } = createKelloNeonReact(createClient, { serviceUrl });
```

`serviceUrl` is the deployed Neon Function URL. `auth` is the official browser SDK: its sign-in and sign-out calls target that backend. The frontend does not host auth, session or RPC routes. `KelloProvider` restores the backend session, forwards tokens and disposes connections and cached private state when the session changes. Live procedures subscribe through Neon Realtime.

## Verification

Builds and focused tests verify generated types, direct backend routing and lifecycle controls. Actual Neon sign-in, cookie delivery, authorization and live-query behavior require cloud acceptance. Browser cookie restrictions can prevent cross-site session restoration; there is no frontend proxy fallback.

## Migration history

The examples keep reviewed migration SQL and plans under `kello/migrations`, selected explicitly by `database.migrations`. Commit this history: rebuilding bindings cannot reconstruct the exact migrations already applied. Generated bindings under `kello/_generated` remain ignored, and build-cache pruning leaves the source migration directory intact.

New projects default to `<backend>/_generated/migrations`. If you keep that default, retain migration history with `kello/_generated/*` and `!kello/_generated/migrations/`. To keep all of `_generated` disposable, configure `database.migrations: "kello/migrations"` and keep the reviewed history there. Move existing SQL and plans intact; never create a second initial history.
