# TanStack Start + Kello

This frontend connects directly to its deployed Kello Neon Function. It has no authentication server, session proxy, RPC routes, or private server prefetch. The same client architecture works in a separate mobile or web application.

The `kello/` folder defines this example's contracts, procedures, schema, migrations and backend authentication policy. Deploy it to its own Neon branch with `bun run deploy`. Neon Functions hosts the generated RPC handler and Kello's managed Neon Auth endpoints. Neon Auth owns sign-in and sessions; the Function verifies signed JWTs and resolves the provider session before live issuance and renewal. Neon Realtime delivers `.live()` query updates.

## Frontend configuration

Set `VITE_KELLO_SERVICE_URL` to the deployed Function URL before building:

```sh
bun run generate
bun run build
bun run start
```

`lib/kello.ts` creates `createKelloNeonReact(createClient, { serviceUrl })`. Sign-in and token retrieval go directly to the Function's `/api/auth/*`; authenticated RPC goes directly to that Function. No frontend cookie secret or server-only backend URL is required. Cookies remain on the backend host and JWTs stay out of rendered HTML and hydration. The backend must allow the exact frontend origin (`http://localhost:3001` here). Browsers must permit the provider's cross-site cookies; the frontend does not proxy around browser policy.

Configure authentication secrets only on the deployed backend. Both `/` and `/client` render the same client-side notes UI. The `.live()` procedure supplies the initial snapshot and subsequent updates; mutations use the generated typed RPC client.

See [the example matrix](../README.md). Builds and offline tests do not establish actual hosted authentication acceptance.
