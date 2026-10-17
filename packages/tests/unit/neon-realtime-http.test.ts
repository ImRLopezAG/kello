import { forwardNeonRpcRequest } from "../../../apps/kello/src/core/server/auth/neon-rpc";
import { expect, expectTypeOf, test, vi } from "vite-plus/test";
import * as v from "valibot";
import { implement, os, RPCSerializer } from "@orpc/server";
import { oc } from "../../../apps/kello/src/core/contract";
import "../../../apps/kello/src/core/server/realtime/procedure";
import type { LiveQueryTarget } from "../../../apps/kello/src/core/server/realtime/procedure";
import type { RouterClient } from "@orpc/server";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { createHash } from "node:crypto";
import pg from "pg";
import { defineRelations } from "drizzle-orm";
import { drizzle, NodePgSession, NodePgTransaction } from "drizzle-orm/node-postgres";
import { PgDialect, pgTable, text } from "drizzle-orm/pg-core";
import { createNeonLoginResolver } from "../../../apps/kello/src/core/adapters/neon/neon-login";
import {
  defineApplication,
  prepareApplicationEnvironment,
} from "../../../apps/kello/src/core/server/application/definition";
import { createRpcHttpTransport } from "../../../apps/kello/src/core/client/rpc-http-transport";
import { eq, and } from "drizzle-orm";
import { createRpcHttpApp } from "../../../apps/kello/src/core/adapters/neon/rpc-http";
import { createJwtVerifier } from "../../../apps/kello/src/core/server/auth/verify";
import { captureTrustedLogin, resolveTrustedLogin } from "../../../apps/kello/src/core/server/auth/login";
import type { TrustedLogin, TrustedLoginResolver } from "../../../apps/kello/src/core/server/auth/login";
import type { ProcedureContext } from "../../../apps/kello/src/core/server/rpc/procedure";
import { createTaskRealtimeRouter } from "../fixtures/neon-realtime";

const version = "a".repeat(64);
const identity = { issuer: "https://login.test", subject: "alice", tenantId: "tenant" };
const expiresAt = () => Math.floor(Date.now() / 1000) + 3600;
const login = (id = "login-A"): TrustedLogin => ({ ...identity, id, expiresAt: expiresAt() });
const headers = (token: string) => ({
  authorization: `Bearer ${token}`,
  "x-loom-version": version,
  "x-loom-protocol": "loom-orpc-2",
});
async function credentials(expiration = expiresAt()) {
  const key = await generateKeyPair("ES256");
  const verify = createJwtVerifier([
    {
      issuer: identity.issuer,
      tenantClaim: "tenant",
      keys: { type: "local", jwks: { keys: [await exportJWK(key.publicKey)] } },
    },
  ]);
  const token = await new SignJWT({ tenant: identity.tenantId })
    .setProtectedHeader({ alg: "ES256" })
    .setIssuer(identity.issuer)
    .setSubject(identity.subject)
    .setExpirationTime(expiration)
    .sign(key.privateKey);
  return { token, verify };
}
const ordinary = os
  .$context<ProcedureContext>()
  .handler(({ context }) => ({ authenticated: context.identity !== null }));

function client<Router extends Parameters<typeof createRpcHttpApp>[0]["router"]>(
  router: Router,
  auth: Awaited<ReturnType<typeof credentials>>,
  resolveLogin?: TrustedLoginResolver,
  liveQueries?: LiveQueryTarget,
) {
  const options = {
    router,
    verify: auth.verify,
    version,
    origins: [],
  };
  const configured = liveQueries ? { ...options, liveQueries } : options;
  const app = createRpcHttpApp(resolveLogin ? { ...configured, resolveLogin } : configured);
  const link = new RPCLink({
    url: "/api/kello/rpc",
    origin: "https://api.test",
    method: "POST",
    headers: headers(auth.token),
    serializer: new RPCSerializer({ omitUndefinedProperties: false }),
    fetch: (url, init) => app.fetch(new Request(url, init)),
  });
  return {
    app,
    rpc: createORPCClient<RouterClient<Router>>(link),
    session: () =>
      app.fetch(new Request("https://api.test/api/kello/session", { method: "POST", headers: headers(auth.token) })),
  };
}

test("contract/functions live reads use the native verified HTTP login and configured target", async () => {
  const auth = await credentials();
  const tasks = pgTable("live_http_tasks", { id: text().notNull() });
  const db = drizzle.mock();
  const base = implement({
    list: oc
      .input(v.object({ limit: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100)) }))
      .output(v.array(v.object({ id: v.string() })))
      .live(),
  }).$context<ProcedureContext>();
  const build = vi.fn(({ input }: { input: { limit: number } }) =>
    db.select({ id: tasks.id }).from(tasks).limit(input.limit),
  );
  const router = base.router({ list: base.list.live(build) });
  const target = {
    database: "db",
    deployment: "test-deployment",
    secret: "nrt_live_1" + Buffer.alloc(32, 1).toString("base64url"),
  };
  const native = client(router, auth, async () => login(), target);
  const issued = await native.rpc.list({ limit: 10 });
  expect(issued.authorization).toEqual(expect.any(String));
  expect(issued.scope).toEqual({ database: "db", deployment: "test-deployment" });
  expect(issued.query.capability).toEqual(expect.any(String));
  expect(build).toHaveBeenCalledTimes(1);
  await expect(native.rpc.list({ limit: 101 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await expect(client(router, auth, undefined, target).rpc.list({ limit: 1 })).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
  await expect(client(router, auth, async () => login()).rpc.list({ limit: 1 })).rejects.toMatchObject({
    code: "SERVICE_UNAVAILABLE",
  });
  expect(build).toHaveBeenCalledTimes(1);
});

test("native verified HTTP mounts typed issuance/update; refresh keeps generation and new login changes owner", async () => {
  const auth = await credentials();
  const pool = new pg.Pool();
  const boundary = vi.spyOn(pool, "query");
  let writes = 0;
  // Only the PG query/transaction boundary is doubled. JWT verification, native
  // HTTP transport, oRPC inference, Drizzle SQL/decoding and sealing are actual.
  boundary.mockImplementation(async (config) => {
    const query = v.parse(v.union([v.string(), v.object({ text: v.string() })]), config);
    const text = v.is(v.string(), query) ? query : query.text;
    if (text.includes("SELECT fingerprint")) return { rows: [], fields: [], command: "SELECT", oid: 0, rowCount: 0 };
    if (text.includes("INSERT INTO"))
      return { rows: [{ scope_hash: "saved" }], fields: [], command: "INSERT", oid: 0, rowCount: 1 };
    if (text.includes("pg_current_xact_id"))
      return { rows: [{ txid: "111" }], fields: [], command: "SELECT", oid: 0, rowCount: 1 };
    if (text.startsWith("update")) {
      writes++;
      return { rows: [["1", "next"]], fields: [], command: "UPDATE", oid: 0, rowCount: 1 };
    }
    return { rows: [["alice"]], fields: [], command: "SELECT", oid: 0, rowCount: 1 };
  });
  const relations = defineRelations({});
  const db = drizzle({ client: pool, relations });
  const tx = new NodePgTransaction(
    new PgDialect(),
    new NodePgSession(pool, new PgDialect(), relations),
    relations,
    0,
    false,
  );
  const transaction: typeof db.transaction = async (operation) => operation(tx);
  const router = createTaskRealtimeRouter({
    connection: { db, pool, transaction, close: () => pool.end() },
    database: "db",
    deployment: "deployment",
    metadataNamespace: "loom_test",
    secret: "nrt_live_1" + Buffer.alloc(32, 1).toString("base64url"),
  });
  let current = login();
  const resolveLogin: TrustedLoginResolver = async (input) => {
    expect(input.credential).toBe(auth.token);
    expect(input.verified.identity).toEqual(identity);
    return current; // Test store adapter, not an asserted provider-specific implementation.
  };
  const native = client(router, auth, resolveLogin);
  try {
    const issued = await native.rpc.issue({ tenant: "tenant" });
    expectTypeOf(issued.query).toMatchTypeOf<{ capability: string }>();
    expect(issued.query.capability).toEqual(expect.any(String));
    expect((await native.rpc.issue({ tenant: "tenant" })).authorization).toBe(issued.authorization);
    const first = v.parse(v.object({ key: v.string() }), await (await native.session()).json());
    expect(v.parse(v.object({ key: v.string() }), await (await native.session()).json()).key).toBe(first.key);
    await expect(client(router, auth).rpc.issue({ tenant: "tenant" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(client(router, auth, async () => undefined).rpc.issue({ tenant: "tenant" })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    current = login("login-B");
    const second = v.parse(v.object({ key: v.string() }), await (await native.session()).json());
    expect(second.key).not.toBe(first.key);
    expect(JSON.stringify(second)).not.toContain("login-B");
    expect((await native.rpc.issue({ tenant: "tenant" })).authorization).not.toBe(issued.authorization);
    const updated = await native.rpc.update({ tenant: "tenant", id: "1", title: "next", key: "request-1" });
    expectTypeOf(updated.value).toEqualTypeOf<{ id: string; title: string }>();
    expect(updated.value).toEqual({ id: "1", title: "next" });
    expect(updated.transaction).toEqual({ kind: "committed", txid: "111" });
    expect(writes).toBe(1);
    expect(JSON.stringify(updated)).not.toContain("login-B");
    // @ts-expect-error Login authority is never procedure input; runtime validator also refuses it.
    await expect(native.rpc.issue({ tenant: "tenant", login: current })).rejects.toThrow();
  } finally {
    boundary.mockRestore();
    await pool.end();
  }
});

test("ordinary HTTP keeps original behavior without resolver; Neon mount fails closed", async () => {
  const auth = await credentials();
  const native = client({ ordinary }, auth);
  expect(await native.rpc.ordinary()).toEqual({ authenticated: true });
  const session = v.parse(v.object({ key: v.string() }), await (await native.session()).json());
  expect(session.key).toBe(
    createHash("sha256")
      .update(JSON.stringify([version, identity.issuer, identity.subject, identity.tenantId]))
      .digest("hex"),
  );
  const required = os.$context<ProcedureContext>().handler(({ context }) => {
    if (!context.login) throw new Error("Missing trusted login");
    return true;
  });
  await expect(client({ required }, auth).rpc.required()).rejects.toThrow();
});

test("configured lookup rejects mismatched identities, invalid generations and expired records before handler", async () => {
  const auth = await credentials();
  const called = vi.fn(() => true);
  const route = os.$context<ProcedureContext>().handler(called);
  for (const record of [
    { ...login(), issuer: "https://other.test" },
    { ...login(), subject: "bob" },
    { ...login(), tenantId: "other" },
    { ...login(), id: "" },
    { ...login(), id: "a".repeat(513) },
    { ...login(), expiresAt: 1 },
  ]) {
    expect((await client({ route }, auth, async () => record).session()).status).toBe(401);
  }
  expect(called).not.toHaveBeenCalled();
});

test("trusted lookup snapshots/caps expiry and does not retain mutable returned authority", async () => {
  const verified = { identity, expiresAt: expiresAt() };
  const record = { ...login(), expiresAt: verified.expiresAt + 100 };
  const captured = await resolveTrustedLogin(
    async () => record,
    "test-credential",
    verified,
    new AbortController().signal,
  );
  expect(captured?.expiresAt).toBe(verified.expiresAt);
  expect(Object.isFrozen(captured)).toBe(true);
  record.id = "changed";
  expect(captured?.id).toBe("login-A");
  expect(() =>
    captureTrustedLogin(verified, { ...record, expiresAt: Number.NaN }, new AbortController().signal),
  ).toThrow();
});

test("request abort settles pending login lookup and never invokes native handler", async () => {
  const auth = await credentials();
  const entered = Promise.withResolvers<void>();
  const ended = Promise.withResolvers<void>();
  const called = vi.fn(() => true);
  const native = client({ route: os.$context<ProcedureContext>().handler(called) }, auth, async ({ signal }) => {
    entered.resolve();
    await new Promise<void>((resolve) =>
      signal.addEventListener(
        "abort",
        () => {
          resolve();
          ended.resolve();
        },
        { once: true },
      ),
    );
    return login();
  });
  const controller = new AbortController();
  const pending = native.app.fetch(
    new Request("https://api.test/api/kello/rpc/route", {
      method: "POST",
      headers: headers(auth.token),
      body: JSON.stringify({ json: null }),
      signal: controller.signal,
    }),
  );
  await entered.promise;
  controller.abort();
  expect((await pending).status).toBe(499);
  await ended.promise;
  expect(called).not.toHaveBeenCalled();
});

for (const boundary of ["credential", "request"] as const) {
  test(`${boundary} deadline cancels a pending trusted lookup before handler entry`, async () => {
    const auth = await credentials(boundary === "credential" ? Math.floor(Date.now() / 1000) + 2 : expiresAt());
    const entered = Promise.withResolvers<void>();
    const cancelled = Promise.withResolvers<void>();
    const called = vi.fn(() => true);
    const app = createRpcHttpApp({
      router: { route: os.$context<ProcedureContext>().handler(called) },
      verify: auth.verify,
      version,
      origins: [],
      requestTimeoutMs: boundary === "credential" ? 10_000 : 50,
      resolveLogin: async ({ signal }) => {
        entered.resolve();
        await new Promise<void>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              cancelled.resolve();
              resolve();
            },
            { once: true },
          );
        });
        return login();
      },
    });
    const pending = app.fetch(
      new Request("https://api.test/api/kello/rpc/route", {
        method: "POST",
        headers: headers(auth.token),
        body: JSON.stringify({ json: null }),
      }),
    );
    await entered.promise;
    expect((await pending).status).toBe(boundary === "credential" ? 401 : 504);
    await cancelled.promise;
    expect(called).not.toHaveBeenCalled();
  });
}

test("native HTTP makes the provider session cookie available to the trusted resolver", async () => {
  const auth = await credentials();
  const called = vi.fn(() => true);
  const app = createRpcHttpApp({
    router: { ordinary: os.$context<ProcedureContext>().handler(called) },
    version,
    origins: ["https://frontend.test"],
    verify: auth.verify,
    resolveLogin: async (input) => {
      const request = v.parse(v.object({ headers: v.instance(Headers) }), input);
      expect(request.headers.get("cookie")).toBe("__Secure-neon-auth.session_token=opaque-session");
      return login();
    },
  });
  const response = await app.fetch(
    new Request("https://api.test/api/kello/session", {
      method: "POST",
      headers: {
        ...headers(auth.token),
        origin: "https://frontend.test",
        cookie: "__Secure-neon-auth.session_token=opaque-session",
      },
    }),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("access-control-allow-origin")).toBe("https://frontend.test");
  expect(response.headers.get("access-control-allow-credentials")).toBe("true");
  expect(called).not.toHaveBeenCalled();
});

test("example-style managed live HTTP binds the fresh provider cookie session to verified JWT issuance and renewal", async () => {
  const issuer = "https://branch.neonauth.test";
  const authority = { issuer, subject: "alice" };
  const key = await generateKeyPair("EdDSA");
  const verify = createJwtVerifier([
    { issuer, keys: { type: "local", jwks: { keys: [await exportJWK(key.publicKey)] } } },
  ]);
  const sign = (subject = "alice", expires = expiresAt()) =>
    new SignJWT({})
      .setProtectedHeader({ alg: "EdDSA" })
      .setIssuer(issuer)
      .setSubject(subject)
      .setExpirationTime(expires)
      .sign(key.privateKey);
  const firstToken = await sign();
  let token = firstToken;
  let cookie =
    "__Secure-neon-auth.session_token=opaque-provider-cookie; unrelated=private; __Secure-neon-auth.local.session_data=stale";
  let record: object | null = {
    session: {
      id: "provider-session-generation-A",
      userId: "alice",
      expiresAt: new Date((expiresAt() - 60) * 1000).toISOString(),
    },
    user: { id: "alice" },
  };
  const table = pgTable("owned_notes", { id: text().notNull(), owner: text().notNull(), issuer: text().notNull() });
  const db = drizzle.mock();
  const queries: { sql: string; params: unknown[] }[] = [];
  const base = implement({
    list: oc.output(v.array(v.object({ id: v.string() }))).live(),
    ordinary: oc.output(v.string()),
  }).$context<ProcedureContext>();
  const router = base.router({
    list: base.list.live(({ context }) => {
      if (!context.identity) throw new Error("Expected verified identity");
      const query = db
        .select({ id: table.id })
        .from(table)
        .where(and(eq(table.owner, context.identity.subject), eq(table.issuer, context.identity.issuer)));
      queries.push(query.toSQL());
      return query;
    }),
    ordinary: base.ordinary.handler(() => "ordinary-ok"),
  });
  const application = defineApplication({
    liveQueries: ({ realtime }) => ({
      ...realtime,
      resolveLogin: createNeonLoginResolver({ baseUrl: issuer + "/auth" }),
    }),
    rpc: ({ os }) => ({ os }),
  });
  const secret = "nrt_live_1" + Buffer.alloc(32, 2).toString("base64url");
  const prepared = await prepareApplicationEnvironment(
    application,
    { LOOM_REALTIME_SECRET: secret },
    { database: "neondb", deployment: "example" },
  );
  const configured = prepared.liveQueries!;
  const app = createRpcHttpApp({
    router,
    version,
    origins: ["https://frontend.test"],
    verify,
    liveQueries: configured,
    resolveLogin: configured.resolveLogin,
  });
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin === issuer) {
      expect(url.pathname).toBe("/auth/get-session");
      expect(url.searchParams.get("disableCookieCache")).toBe("true");
      expect(url.searchParams.get("disableRefresh")).toBe("true");
      const forwarded = new Headers(init?.headers);
      expect(forwarded.get("cookie")).toBe("__Secure-neon-auth.session_token=opaque-provider-cookie");
      expect(forwarded.has("authorization")).toBe(false);
      expect(init?.redirect).toBe("error");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return Response.json(record);
    }
    const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
    if (url.origin === "https://frontend.test") {
      expect(init?.credentials).toBe("include");
      // The browser cookie belongs ONLY to the frontend. It cannot accompany
      // a direct cross-host browser fetch to api.test, regardless of credentials.
      const browserHeaders = new Headers(request.headers);
      browserHeaders.set("origin", "https://frontend.test");
      browserHeaders.set("cookie", cookie);
      const incoming = new Request(request, { headers: browserHeaders });
      return forwardNeonRpcRequest(incoming, "https://api.test");
    }
    expect(url.origin).toBe("https://api.test");
    return app.fetch(request);
  });
  const transport = createRpcHttpTransport({
    url: "https://frontend.test",
    version,
    credentials: "include",
    getToken: async () => token,
  });
  const rpc = createORPCClient<RouterClient<typeof router>>(transport.link);
  try {
    const remote = createRpcHttpTransport({
      url: "https://api.test",
      version,
      credentials: "include",
      getToken: async () => token,
    });
    try {
      // credentials:include cannot move the frontend's HttpOnly cookie to a different host.
      const direct = createORPCClient<RouterClient<typeof router>>(remote.link);
      await expect(direct.list()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    } finally {
      remote.dispose();
    }
    const issued = await rpc.list();
    expect(issued.authorization).toEqual(expect.any(String));
    expect(issued.scope).toEqual({ database: "neondb", deployment: "example" });
    expect(queries.at(-1)?.params).toEqual([authority.subject, authority.issuer]);
    expect(JSON.stringify(issued)).not.toContain(secret);
    expect(JSON.stringify(issued)).not.toContain("opaque-provider-cookie");
    const session = await transport.verifySession();
    token = await sign("alice", expiresAt() + 30);
    const renewed = await rpc.list();
    expect(renewed.authorization).toBe(issued.authorization);
    expect((await transport.verifySession()).key).toBe(session.key);
    token = await sign("bob");
    await expect(rpc.list()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    token = firstToken;
    record = {
      session: {
        id: "provider-session-generation-B",
        userId: "alice",
        expiresAt: new Date(expiresAt() * 1000).toISOString(),
      },
      user: { id: "alice" },
    };
    expect((await rpc.list()).authorization).not.toBe(issued.authorization);
    record = {
      session: { id: "expired", userId: "alice", expiresAt: "2000-01-01T00:00:00.000Z" },
      user: { id: "alice" },
    };
    await expect(rpc.list()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    record = null; // Provider logout/revocation, even while the access JWT is still valid.
    await expect(rpc.list()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(transport.verifySession()).rejects.toThrow("Session verification refused (401)");
    cookie = "";
    await expect(rpc.list()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(await rpc.ordinary()).toBe("ordinary-ok");
    const count = fetcher.mock.calls.length;
    const hostile = await forwardNeonRpcRequest(
      new Request("https://frontend.test/api/kello/session", {
        method: "POST",
        headers: { origin: "https://evil.test", cookie: "__Secure-neon-auth.session_token=opaque-provider-cookie" },
      }),
      "https://api.test",
    );
    expect(hostile.status).toBe(403);
    expect(fetcher.mock.calls).toHaveLength(count);
    const refused = await app.fetch(
      new Request("https://api.test/api/kello/session", {
        method: "POST",
        headers: {
          ...headers(firstToken),
          origin: "https://evil.test",
          cookie: "__Secure-neon-auth.session_token=opaque-provider-cookie",
        },
      }),
    );
    expect(refused.status).toBe(403);
    expect(fetcher.mock.calls).toHaveLength(count);
    const preflight = await app.fetch(
      new Request("https://api.test/api/kello/rpc/list", {
        method: "OPTIONS",
        headers: {
          origin: "https://frontend.test",
          "access-control-request-method": "POST",
          "access-control-request-headers": "authorization,x-loom-version,x-loom-protocol",
        },
      }),
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("https://frontend.test");
    expect(preflight.headers.get("access-control-allow-credentials")).toBe("true");
  } finally {
    transport.dispose();
    fetcher.mockRestore();
  }
});

test("Neon session lookup rejects foreign issuer and unconfigured tenants before forwarding cookies", async () => {
  const resolve = createNeonLoginResolver({ baseUrl: "https://branch.neonauth.test/auth" });
  const fetcher = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected provider request"));
  try {
    for (const identity of [
      { issuer: "https://other.neonauth.test", subject: "alice" },
      { issuer: "https://branch.neonauth.test", subject: "alice", tenantId: "foreign" },
    ])
      await expect(
        resolve({
          verified: { identity, expiresAt: expiresAt() },
          credential: "verified-access-token",
          signal: new AbortController().signal,
          headers: new Headers({ cookie: "__Secure-neon-auth.session_token=opaque-provider-cookie" }),
        }),
      ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    fetcher.mockRestore();
  }
});
