import { expect, expectTypeOf, test, vi } from "vite-plus/test";
import * as v from "valibot";
import { implement, os, RPCSerializer } from "@orpc/server";
import { oc } from "../../../apps/loom/src/core/contract";
import "../../../apps/loom/src/core/server/realtime/procedure";
import type { LiveQueryTarget } from "../../../apps/loom/src/core/server/realtime/procedure";
import type { RouterClient } from "@orpc/server";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { createHash } from "node:crypto";
import pg from "pg";
import { defineRelations } from "drizzle-orm";
import { drizzle, NodePgSession, NodePgTransaction } from "drizzle-orm/node-postgres";
import { PgDialect, pgTable, text } from "drizzle-orm/pg-core";
import { createRpcHttpApp } from "../../../apps/loom/src/core/adapters/neon/rpc-http";
import { createJwtVerifier } from "../../../apps/loom/src/core/server/auth/verify";
import { captureTrustedLogin, resolveTrustedLogin } from "../../../apps/loom/src/core/server/auth/login";
import type { TrustedLogin, TrustedLoginResolver } from "../../../apps/loom/src/core/server/auth/login";
import type { ProcedureContext } from "../../../apps/loom/src/core/server/rpc/procedure";
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
