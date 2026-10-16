import { expect, test, vi } from "vite-plus/test";
import * as v from "valibot";
import { eq, sql } from "drizzle-orm";
import { pgTable, text } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/node-postgres";
import { createNeonLiveQuery, createNeonQueryIssuer } from "kello/server";

const tasks = pgTable("tasks", { id: text().notNull(), tenant: text().notNull(), title: text().notNull() });
const db = drizzle.mock();
const rows = v.array(v.strictObject({ id: v.string(), title: v.string() }));
const declaration = createNeonLiveQuery({
  name: "tasks.v1",
  input: v.strictObject({ tenant: v.string() }),
  rows,
  authorize: ({ identity }, input) => {
    if (identity.tenantId !== input.tenant) throw new Error("Forbidden");
  },
  query: ({ identity }) =>
    db.select({ id: tasks.id, title: tasks.title }).from(tasks).where(eq(tasks.tenant, identity.tenantId!)),
});
const authority = {
  identity: { issuer: "test", subject: "user", tenantId: "tenant" },
  sessionId: "session1",
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
  signal: new AbortController().signal,
};
const issuer = createNeonQueryIssuer({
  secret: "nrt_live_1" + Buffer.alloc(32, 1).toString("base64url"),
  database: "test",
  deployment: "test",
  queries: [declaration],
});
test("built public issuer retains the bundled JSON and array parameter patch", async () => {
  const parameterized = createNeonLiveQuery({
    name: "parameters.v1",
    input: v.strictObject({}),
    rows: v.array(v.strictObject({ id: v.string() })),
    authorize: () => {},
    query: () =>
      db
        .select({ id: tasks.id })
        .from(tasks)
        .where(
          sql`${sql.param({ enabled: true })}::jsonb IS NOT NULL AND ${sql.param(["one", null])}::text[] IS NOT NULL`,
        ),
  });
  const publicIssuer = createNeonQueryIssuer({
    secret: "nrt_live_1" + Buffer.alloc(32, 1).toString("base64url"),
    database: "test",
    deployment: "test",
    queries: [parameterized],
  });
  expect((await publicIssuer.issue(parameterized, {}, authority)).query.capability).toEqual(expect.any(String));
});
test("registered typed query issues only for validated authorized inputs", async () => {
  const issued = await issuer.issue(declaration, { tenant: "tenant" }, authority);
  expect(issued.query.capability).toEqual(expect.any(String));
  expect(issued.scope.database).toBe("test");
  expect(JSON.stringify(issued)).not.toContain("user");
  await expect(issuer.issue(declaration, { tenant: "other" }, authority)).rejects.toThrow("Forbidden");
  // @ts-expect-error Untrusted transport can still supply undeclared fields; runtime schema must reject them.
  await expect(issuer.issue(declaration, { tenant: "tenant", sql: "select 1" }, authority)).rejects.toThrow();
  await expect(issuer.issue(declaration, { tenant: "tenant" }, { ...authority, identity: null })).rejects.toThrow();
});

test("target/session binding changes, unknown declarations and client mappers refuse issuance", async () => {
  const first = await issuer.issue(declaration, { tenant: "tenant" }, authority);
  const next = await issuer.issue(declaration, { tenant: "tenant" }, { ...authority, sessionId: "session2" });
  expect(next.authorization).not.toBe(first.authorization);
  expect(next.query.queryFingerprint).toBe(first.query.queryFingerprint);
  await expect(issuer.issue({ ...declaration }, { tenant: "tenant" }, authority)).rejects.toThrow("Unknown");
  const { sql } = await import("drizzle-orm");
  const mapped = createNeonLiveQuery({
    name: "mapped.v1",
    input: v.object({}),
    rows: v.array(v.object({ title: v.string() })),
    authorize: () => {},
    query: () => db.select({ title: sql<string>`${tasks.title}`.mapWith((x) => String(x)).as("title") }).from(tasks),
  });
  const mappedIssuer = createNeonQueryIssuer({
    secret: "nrt_live_1" + Buffer.alloc(32, 1).toString("base64url"),
    database: "test",
    deployment: "test",
    queries: [mapped],
  });
  await expect(mappedIssuer.issue(mapped, {}, authority)).rejects.toThrow("mapWith");
});

test("issuance refuses expired sessions and a signed capability extending past verified expiry", async () => {
  await expect(issuer.issue(declaration, { tenant: "tenant" }, { ...authority, expiresAt: 1 })).rejects.toThrow(
    "UNAUTHORIZED",
  );
  await expect(
    issuer.issue(declaration, { tenant: "tenant" }, { ...authority, expiresAt: Math.floor(Date.now() / 1000) + 20 }),
  ).rejects.toThrow("Session expires");
});

test("example issuance and renewal require current membership independently of SQL filtering", async () => {
  const { default: pg } = await import("pg");
  const { createTaskRealtimeExample } = await import("../fixtures/neon-realtime");
  const pool = new pg.Pool();
  // Native Drizzle builder/decoder, isolated PG query boundary: no connection is
  // acquired. Actual subscribed membership revocation remains a provider gate.
  const query = vi.spyOn(pool, "query");
  query.mockImplementation(async () => ({ command: "SELECT", rowCount: 1, oid: 0, fields: [], rows: [["user"]] }));
  const database = drizzle({ client: pool });
  const example = createTaskRealtimeExample({
    connection: { db: database, pool, transaction: database.transaction.bind(database), close: () => pool.end() },
    secret: "nrt_live_1" + Buffer.alloc(32, 1).toString("base64url"),
    database: "test",
    deployment: "test",
    metadataNamespace: "test",
  });
  const verified = { identity: authority.identity, expiresAt: authority.expiresAt };
  const login = { ...authority.identity, id: authority.sessionId, expiresAt: authority.expiresAt };
  try {
    expect((await example.issue({ tenant: "tenant" }, verified, login, authority.signal)).query.capability).toEqual(
      expect.any(String),
    );
    query.mockImplementation(async () => ({ command: "SELECT", rowCount: 0, oid: 0, fields: [], rows: [] }));
    await expect(example.issue({ tenant: "tenant" }, verified, login, authority.signal)).rejects.toThrow("Forbidden");
    expect(query).toHaveBeenCalledTimes(2);
    const sql = query.mock.calls[0]?.[0];
    expect(JSON.stringify(sql)).toContain("issuer");
    expect(JSON.stringify(sql)).toContain("subject");
    expect(JSON.stringify(sql)).toContain("tenant");
  } finally {
    query.mockRestore();
    await pool.end();
  }
});
