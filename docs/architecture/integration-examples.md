# Framework and schema integration evidence

Date: 2026-09-25. Scope: the generated HTTP server client and the new `integrations`, `next`, and `start` examples.

## Examples

See [the runnable example guide](../../packages/examples/README.md) for setup and deployment configuration.

| Surface                 | Executable example                                              | Verification                                                                             |
| ----------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Zod input/output        | `integrations/kello/contracts/examples.ts`                      | Authenticated RPC validates input, applies trimming and preserves inferred output        |
| Mixed Standard Schema   | Zod input, Valibot output                                       | Runtime call and negative TypeScript output assertion                                    |
| Effect handler/services | Native `.effect`, injected Greeting, Database and Tables        | Typed declared error, real PostgreSQL reads and service resolution                       |
| Effect Schema           | `Schema.toStandardSchemaV1`                                     | Valid/invalid RPC input and negative generated-client type assertion                     |
| Next.js App Router      | Server Components and HydrationBoundary                         | Production Node server, request isolation, SSR data, hydration and browser subscriptions |
| TanStack Start          | Server function, loader and Router query integration            | Production Nitro server, private no-store SSR, request isolation and hydration           |
| Native TanStack options | Upstream queryOptions, mutationOptions and explicit liveOptions | Generated client types, real writes, two-tab observations and cross-user isolation       |

Current dependency pins are maintained in the example manifests and root lockfile; Effect now uses stable 4.0.0. The September 25 validation below used oRPC 2.0.0-beta.40, Effect 4.0.0-rc.117, Zod 4.6.5, Valibot 1.5.0, Drizzle 1.0.0-rc.4 and TypeScript 7.0.2. Next.js and TanStack Start each use their own framework build; runtime exports remain Node/browser compatible.

## Independent example backends

The Next and Start examples now each own their contracts, schema, handlers, migrations, app/auth configuration and generated clients. Neither consumes `@kello/example-integrations`. Next demonstrates Zod plus native Effect handlers/services; Start demonstrates Valibot plus ordinary async handlers. The `integrations` package remains a separate schema comparison backend.

Each app also owns its deployment identity: `next_app` / `kello_next` / `kello_next_runtime` / `next-preview`, and `start_app` / `kello_start` / `kello_start_runtime` / `start-preview`. Distinct development deployment names are configured too. Initial migrations were generated separately by the Kello CLI. These examples have not yet been deployed by this change.

Correction verification: production builds and negative client typechecks pass for both apps; workspace typechecks and Oxlint pass. Five focused PostgreSQL/browser scenarios cover the schema comparison backend, each app's own authenticated SSR/live flow, independent writes, and all three migrations applied together to one database. The shared-database test verifies that each runtime role can read only its own notes namespace. The existing 204-unit-test suite remains green via Turbo cache.

Code/security review ran inline under the workspace instructions, with an independent Claude adversarial pass (requested/reported `claude-opus-5-5`, requested high effort, actual effort unverified). It identified shared deployment/schema defaults despite independent source files; distinct namespaces, metadata, roles and deployment names now remove that collision. The same-database regression verifies the database boundary. Start's startup instructions also specify port 3001, matching its configured origin. Receipt: `kello-independent-examples-20260925`; no actionable findings remain.

## Initial integration validation

- All 20 workspace build/typecheck/unit-test tasks passed; 204 unit tests passed.
- The complete PostgreSQL 18 integration run passed 153 tests before the final cancellation regression was added. Final focused verification passed all five schema, HTTP transport and framework browser scenarios, including that new regression and the latest-50-note boundary.
- The full browser suite passed eight scenarios. Both new framework scenarios were rerun after the final changes and passed.
- Oxlint passed without warnings. Formatting passed for all changed supported files.
- The aggregate `bun run check` encountered a pre-existing extra blank line at EOF in the root README. That unrelated edit was preserved and excluded from this change. Build, typecheck, unit tests, lint and changed-file formatting were verified separately.
- Desktop and mobile screenshots were inspected; neither example overflowed at 390px.
- React Doctor's remaining effect-fetch and preventDefault suggestions do not apply: the effect owns an authenticated transport lifecycle and the forms intentionally invoke TanStack mutations. Its generated TanStack/React JSON warning points to upstream code that escapes serialized script content. Explicit submit/button types were added.

The browser tests verify oversized token refusal, origin checks, per-page token binding, cross-tab sign-out, a subsequent different-user login, absence of credentials in HTML, post-write SSR ownership, private no-store SSR responses and no page errors. The HTTP transport test verifies concurrent identities, native operation intent, Date serialization and cancellation while credential acquisition remains pending. Cancellation was reproduced failing before the fix and passing afterward.

## Review

`ce-simplify-code` and `ce-code-review` ran with local passes sequentially in the main context, as required by the workspace instructions. Simplification narrowed Turbo output declarations; duplicate frontend demonstration code remains intentional so each example can be read independently.

Review receipt: `kello-integrations-20260925`. The independent Claude adversarial pass requested and reported `claude-opus-5-5`; requested effort was high, actual effort was unverified. Three actionable findings were resolved:

1. Bound asynchronous token acquisition by cancellation/deadline.
2. Prevent stale tabs from adopting a different session; broadcast session changes.
3. Reject tokens that exceed the demonstration cookie capacity.

The review also prompted matching configuration propagation for browser fixtures, clearer build/deploy version instructions, and explicit proxy/auth limitations. No actionable finding remains deferred.

## Acceptance boundary

These new examples were tested against disposable local PostgreSQL 18 databases, genuine Kello runtimes and authenticated native oRPC transports. Their configuration supports the ordinary Neon deployment flow; this run did **not** deploy these examples to Neon, Vercel or another frontend host. Earlier Neon acceptance remains recorded separately in [contract-first execution](contract-first-execution.md).

The session bridge is a demonstration, not an identity-provider callback/refresh implementation. It makes the bearer token available to same-origin browser code for direct WebSocket authentication. Tokens are limited to 3,800 characters; rotation requires a page reload. Preserve the public origin/protocol behind proxies. Finite SSR payloads are JSON-safe; richer RPC values require corresponding framework hydration serializers. Standard Schema compatibility does not promise that every library-specific transform can be represented by OpenAPI.

## Post-deploy validation

The deploying maintainer should use a disposable Neon branch with matching build/deploy configuration, then run two independent users through SSR, writes, live updates and sign-out in two tabs. Verify private/no-store page responses, rejected stale sessions, no token in HTML, and drained subscriptions after logout. Stop on cross-user data, unexpected repeated writes, version mismatches or persistent live failures. Keep the previous frontend artifacts available; only restore a backend version permitted by Kello's schema compatibility checks. No production monitoring owner or metrics service is configured by these examples.
