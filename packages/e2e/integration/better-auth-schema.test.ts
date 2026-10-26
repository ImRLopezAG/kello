import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { betterAuth } from "better-auth";
import { jwt, organization, twoFactor } from "better-auth/plugins";
import { inbox } from "better-inbox";
import { compileBetterAuthSchema, createBetterAuthDatabase } from "kello/better-auth";
import { createNativeSnapshot, emptySnapshot, migrationStatements } from "kello-cli";
import type { BetterAuthOptions } from "better-auth";
import type { SecondaryStorage } from "@better-auth/core/db";

function secondaryStorage(): SecondaryStorage {
  const values = new Map<string, { value: string; expiresAt: number }>();
  function get(key: string) {
    const entry = values.get(key);
    if (!entry || entry.expiresAt <= Date.now()) {
      values.delete(key);
      return null;
    }
    return entry.value;
  }
  return {
    get,
    set(key, value, ttl) {
      values.set(key, { value, expiresAt: ttl === undefined ? Infinity : Date.now() + ttl * 1000 });
    },
    delete(key) {
      values.delete(key);
    },
    getAndDelete(key) {
      const value = get(key);
      values.delete(key);
      return value;
    },
    increment(key, ttl) {
      const value = Number(get(key) ?? 0) + 1;
      values.set(key, { value: String(value), expiresAt: values.get(key)?.expiresAt ?? Date.now() + ttl * 1000 });
      return value;
    },
  };
}

const configurations: readonly [string, BetterAuthOptions][] = [
  ["core", {}],
  ["jwt", { plugins: [jwt()] }],
  ["organization", { plugins: [organization()] }],
  ["teams", { plugins: [organization({ teams: { enabled: true } })] }],
  ["two-factor", { plugins: [twoFactor()] }],
  ["inbox", { plugins: [inbox()] }],
  ["combined", { plugins: [jwt(), organization({ teams: { enabled: true } }), twoFactor(), inbox()] }],
  ["aliases", { user: { modelName: "account", fields: { email: "address" } }, account: { modelName: "credentials" } }],
  ["serial", { advanced: { database: { generateId: "serial" } } }],
  ["uuid", { advanced: { database: { generateId: "uuid" } } }],
  ["secondary-only", { secondaryStorage: secondaryStorage() }],
  [
    "secondary-database",
    {
      secondaryStorage: secondaryStorage(),
      session: { storeSessionInDatabase: true },
      verification: { storeInDatabase: true },
    },
  ],
  ["secondary-two-factor", { secondaryStorage: secondaryStorage(), plugins: [twoFactor()] }],
  [
    "required-field",
    { user: { additionalFields: { department: { type: "string", required: true, defaultValue: "Engineering" } } } },
  ],
  [
    "uuid-organization",
    { advanced: { database: { generateId: "uuid" } }, plugins: [organization({ teams: { enabled: true } })] },
  ],
  [
    "organization-aliases",
    {
      plugins: [
        organization({
          teams: { enabled: true },
          schema: {
            organization: { modelName: "workspace", fields: { name: "title" } },
            member: { modelName: "membership", fields: { organizationId: "workspaceId" } },
          },
        }),
      ],
    },
  ],
  ["rate-limit", { rateLimit: { storage: "database" } }],
  [
    "fields",
    {
      user: {
        additionalFields: {
          score: { type: "number", required: false },
          tags: { type: "string[]", required: false },
          numbers: { type: "number[]", required: false },
          profile: { type: "json", required: false },
          status: { type: ["active", "inactive"], required: false },
        },
      },
    },
  ],
];
for (const [name, configuration] of configurations)
  test.skipIf(!process.env.LOOM_TEST_DATABASE_URL)(
    `${name}: migrations create native tables and real Better Auth sign-up uses the adapter`,
    async () => {
      const namespace = `auth_${crypto.randomUUID().replaceAll("-", "")}`;
      const pool = new pg.Pool({ connectionString: process.env.LOOM_TEST_DATABASE_URL });
      try {
        const schema = compileBetterAuthSchema(configuration, namespace);
        const snapshot = await createNativeSnapshot({ namespace, tables: schema.ownedTables });
        const statements = await migrationStatements(await emptySnapshot(namespace), snapshot);
        for (const statement of statements) await pool.query(statement);
        const catalog = await pool.query<{ table_name: string }>(
          "SELECT table_name FROM information_schema.tables WHERE table_schema=$1",
          [namespace],
        );
        expect(catalog.rows.map((r) => r.table_name).sort()).toEqual(Object.keys(schema.ownedTables).sort());
        const auth = betterAuth({
          ...configuration,
          secret: "loom-integration-secret-at-least-thirty-two-characters",
          baseURL: "https://auth.example.test",
          database: createBetterAuthDatabase(drizzle({ client: pool }), namespace),
          emailAndPassword: { enabled: true },
        });
        const result = await auth.api.signUpEmail({
          body: { email: `${name}@example.test`, password: "integration-password-1", name: "Test User" },
        });
        expect(result.user.email).toBe(`${name}@example.test`);
        const login = await auth.api.signInEmail({
          body: { email: result.user.email, password: "integration-password-1" },
        });
        expect(login.user.id).toBe(result.user.id);
        expect(result.user.createdAt).toBeInstanceOf(Date);
        expect(result.user.emailVerified).toBe(false);
        if (name === "core") {
          const next = await auth.api.signUpEmail({
            body: { email: "second@example.test", password: "integration-password-1", name: "Second" },
          });
          expect(next.user.createdAt.getTime()).toBeGreaterThan(result.user.createdAt.getTime());
          await rejects(
            pool.query(
              `INSERT INTO "${namespace}"."session" (id, "userId", token, "expiresAt", "createdAt", "updatedAt") VALUES ('invalid', 'missing', 'invalid', now(), now(), now())`,
            ),
            { code: "23503" },
          );
          await rejects(
            pool.query(`UPDATE "${namespace}"."user" SET email=$1 WHERE id=$2`, [result.user.email, next.user.id]),
            { code: "23505" },
          );
        }
        const context = await auth.$context;
        expect((await context.internalAdapter.findSession(login.token))?.user.id).toBe(result.user.id);
        const identifier = `verification-${name}`;
        await context.internalAdapter.createVerificationValue({
          identifier,
          value: "fixture-value",
          expiresAt: new Date(Date.now() + 60_000),
        });
        expect((await context.internalAdapter.findVerificationValue(identifier))?.value).toBe("fixture-value");
        if (name.startsWith("secondary-")) {
          const names = catalog.rows.map((row) => row.table_name);
          expect(names.includes("session")).toBe(name === "secondary-database");
          expect(names.includes("verification")).toBe(name === "secondary-database");
        }
        if (name === "required-field") {
          expect(
            (await pool.query(`SELECT department FROM "${namespace}"."user" WHERE id=$1`, [result.user.id])).rows[0]
              .department,
          ).toBe("Engineering");
        }
        if (name === "organization-aliases" || name === "uuid-organization") {
          const org = await context.adapter.create<{ id: string }>({
            model: "organization",
            data: { name: "Engineering", slug: "engineering", createdAt: new Date() },
          });
          await context.adapter.create({
            model: "member",
            data: { userId: result.user.id, organizationId: org.id, role: "owner", createdAt: new Date() },
          });
          const member = await context.adapter.findOne<{ organizationId: string }>({
            model: "member",
            where: [{ field: "userId", value: result.user.id }],
          });
          expect(member?.organizationId).toBe(org.id);
        }
        if (name === "fields") {
          await context.adapter.update({
            model: "user",
            where: [{ field: "id", value: result.user.id }],
            update: { score: 1.25, tags: ["x"], numbers: [1.5], profile: { enabled: true }, status: "active" },
          });
          const user = await context.adapter.findOne<{
            score: number;
            tags: string[];
            numbers: number[];
            profile: { enabled: boolean };
            status: string;
          }>({ model: "user", where: [{ field: "id", value: result.user.id }] });
          expect(user).toMatchObject({
            score: 1.25,
            tags: ["x"],
            numbers: [1.5],
            profile: { enabled: true },
            status: "active",
          });
          await rejects(pool.query(`UPDATE "${namespace}"."user" SET status='invalid' WHERE id=$1`, [result.user.id]), {
            code: "23514",
          });
        }
        const noChange = await createNativeSnapshot({ namespace, tables: schema.ownedTables }, snapshot);
        expect(await migrationStatements(snapshot, noChange)).toEqual([]);
      } finally {
        await pool.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
        await pool.end();
      }
    },
    30_000,
  );
