import assert from "node:assert/strict";
import { test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { betterAuth } from "better-auth";
import { symmetricDecrypt } from "better-auth/crypto";
import { inbox } from "better-inbox";
import { inboxClient } from "better-inbox/client";
import { jwt, organization, twoFactor } from "better-auth/plugins";
import { createAuthClient } from "better-auth/client";
import { jwtClient, organizationClient, twoFactorClient } from "better-auth/client/plugins";
import { createLocalJWKSet, jwtVerify, decodeProtectedHeader } from "jose";
import { defineRelations } from "drizzle-orm";
import { defineApplication } from "kello";
import { defineSchema } from "kello/server";
import { defineBetterAuth, resolveBetterAuthSchema } from "kello/better-auth";
import { createNeonRpcService } from "kello/neon";
import { emptySnapshot, planMigration, writeMigration, applyMigrations } from "kello-cli";

import { appPreferences } from "../fixtures/app-auth-plugin";
import { appPreferencesClient } from "../fixtures/app-auth-plugin-client";

const connectionString = process.env.LOOM_TEST_DATABASE_URL;
test.skipIf(!connectionString)(
  "native plugin clients and routes use the assembled Kello server and real Neon tables",
  async () => {
    assert(connectionString);
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const namespace = `auth_http_${suffix}`;
    const metadataNamespace = `loom_auth_http_${suffix}`;
    const runtimeRole = `auth_http_role_${suffix}`;
    const root = await mkdtemp(join(tmpdir(), "loom-auth-http-"));
    const admin = new pg.Client({ connectionString });
    await admin.connect();
    let service: Awaited<ReturnType<typeof createNeonRpcService>> | undefined;
    try {
      let native: ReturnType<typeof create> | undefined;
      const create = (database: Parameters<Parameters<typeof resolveBetterAuthSchema>[0]>[0]) => {
        const auth = betterAuth({
          database,
          baseURL: "https://api.test",
          secret: "test-only-native-http-secret-at-least-32-characters",
          emailAndPassword: { enabled: true },
          plugins: [
            jwt({
              jwt: { issuer: "https://api.test", audience: "loom-test", expirationTime: "5m" },
              jwks: { keyPairConfig: { alg: "EdDSA" } },
            }),
            organization({ teams: { enabled: true } }),
            twoFactor(),
            inbox(),
            appPreferences({ modelName: "customerPreferences", maxLength: 20 }),
          ],
        });
        native = auth;
        return auth;
      };
      const nativeSchema = await resolveBetterAuthSchema(create, namespace);
      const plan = await planMigration(await emptySnapshot(namespace), { namespace, tables: nativeSchema.ownedTables });
      await writeMigration(root, "migrations", "auth", plan);
      await applyMigrations({
        connectionString,
        root,
        migrations: "migrations",
        namespace,
        metadataNamespace,
        runtimeRole,
      });
      await admin.query(`ALTER ROLE "${runtimeRole}" LOGIN PASSWORD 'test-only-auth-http'`);
      const address = new URL(connectionString);
      address.username = runtimeRole;
      address.password = "test-only-auth-http";
      const application = defineApplication({ rpc: ({ os }) => ({ os }) });
      application.use(defineBetterAuth({ name: "identity", env: {}, create: ({ database }) => create(database) }));
      const schema = defineSchema(() => ({}));
      service = await createNeonRpcService({
        application,
        schema,
        relations: defineRelations(schema.tables),
        connectionString: address.href,
        metadataNamespace,
        deployment: "auth-http",
        version: "a".repeat(64),
        procedures: [],
        authScopes: [{ mountPath: "identity", namespace, fingerprint: nativeSchema.fingerprint }],
        config: {
          auth: {
            origins: ["https://api.test"],
            issuers: [
              {
                issuer: "https://api.test",
                jwksUrl: "https://api.test/api/auth/jwks",
                audience: "loom-test",
                algorithms: ["EdDSA"],
              },
            ],
          },
        },
        assertActive: async () => {},
      });
      const running = service;
      const cookies = new Map<string, string>();
      const client = createAuthClient({
        baseURL: "https://api.test",
        plugins: [
          jwtClient(),
          organizationClient({ teams: { enabled: true } }),
          twoFactorClient(),
          inboxClient(),
          appPreferencesClient(),
        ],
        fetchOptions: {
          customFetchImpl: async (input, init) => {
            const request = new Request(input, init);
            request.headers.set("origin", "https://api.test");
            request.headers.set("cookie", [...cookies].map(([key, value]) => `${key}=${value}`).join("; "));
            const response = await running.fetch(request);
            for (const cookie of response.headers.getSetCookie()) {
              const pair = cookie.split(";", 1)[0]!;
              const separator = pair.indexOf("=");
              cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
            }
            return response;
          },
        },
      });
      const signup = await client.signUp.email({
        email: "owner@example.test",
        password: "integration-password-1",
        name: "Owner",
      });
      assert.equal(signup.error, null);
      assert(signup.data?.user.id);
      assert.equal((await client.getSession()).data?.user.id, signup.data.user.id);
      assert.equal((await client.appPreferences.set({ value: "dark" })).error, null);
      assert.equal((await client.appPreferences.get()).data?.value, "dark");
      assert.equal((await client.appPreferences.set({ value: "x".repeat(21) })).error?.status, 400);
      assert.equal((await client.appPreferences.set({ value: "light" })).error, null);
      assert.equal((await client.appPreferences.get()).data?.value, "light");
      const preferences = await admin.query(
        `SELECT value FROM "${namespace}"."customerPreferences" WHERE "userId"=$1`,
        [signup.data.user.id],
      );
      assert.deepEqual(preferences.rows, [{ value: "light" }]);
      assert.equal((await running.fetch(new Request("https://api.test/api/auth/app-preferences/get"))).status, 401);
      const organizationResult = await client.organization.create({ name: "Example", slug: "example" });
      assert.equal(organizationResult.error, null);
      assert(organizationResult.data?.id);
      const team = await client.organization.createTeam({
        name: "Engineering",
        organizationId: organizationResult.data.id,
      });
      assert.equal(team.error, null);
      assert(native);
      const notice = await native.api.notify({
        body: {
          userId: signup.data.user.id,
          type: "acceptance",
          title: "Persisted notice",
          data: { checked: true },
        },
      });
      assert.equal(notice.count, 1);
      const listed = await client.inbox.list({ query: { filter: "unread" } });
      assert.equal(listed.error, null);
      assert.equal(listed.data?.notifications[0]?.title, "Persisted notice");
      assert.equal((await client.inbox.unreadCount()).data?.count, 1);
      assert.equal((await client.inbox.markRead({ id: notice.notifications[0]!.id })).error, null);
      assert.equal((await client.inbox.unreadCount()).data?.count, 0);
      assert.equal(
        (await admin.query(`SELECT count(*)::int AS n FROM "${namespace}"."notification" WHERE read=true`)).rows[0].n,
        1,
      );
      assert.equal(
        (
          await running.fetch(
            new Request("https://api.test/api/auth/inbox/notify", {
              method: "POST",
              body: "{}",
              headers: { "content-type": "application/json" },
            }),
          )
        ).status,
        404,
      );
      assert.equal((await running.fetch(new Request("https://api.test/api/auth/inbox/list"))).status, 401);
      const token = await client.token();
      assert.equal(token.error, null);
      assert(token.data?.token);
      const keys = await (await running.fetch(new Request("https://api.test/api/auth/jwks"))).json();
      const verified = await jwtVerify(token.data.token, createLocalJWKSet(keys), {
        issuer: "https://api.test",
        audience: "loom-test",
        algorithms: ["EdDSA"],
      });
      assert.equal(verified.payload.sub, signup.data.user.id);
      assert(verified.payload.exp! - verified.payload.iat! <= 300);
      const originalKey = decodeProtectedHeader(token.data.token).kid;
      assert(originalKey);
      await admin.query(`UPDATE "${namespace}".jwks SET "expiresAt"=now()-interval '1 second' WHERE id=$1`, [
        originalKey,
      ]);
      const rotated = await client.token();
      assert.equal(rotated.error, null);
      assert(rotated.data?.token);
      assert.notEqual(decodeProtectedHeader(rotated.data.token).kid, originalKey);
      const rotatedKeys = await (await running.fetch(new Request("https://api.test/api/auth/jwks"))).json();
      for (const credential of [token.data.token, rotated.data.token]) {
        const result = await jwtVerify(credential, createLocalJWKSet(rotatedKeys), {
          issuer: "https://api.test",
          audience: "loom-test",
          algorithms: ["EdDSA"],
        });
        assert.equal(result.payload.sub, signup.data.user.id);
      }
      assert.equal(
        (
          await running.fetch(
            new Request("https://api.test/api/auth/signJWT", {
              method: "POST",
              body: "{}",
              headers: { "content-type": "application/json" },
            }),
          )
        ).status,
        404,
      );
      assert.equal((await running.fetch(new Request("https://api.test/api/auth/token"))).status, 401);
      assert.equal(
        (
          await running.fetch(
            new Request("https://api.test/api/auth/get-session", { headers: { origin: "https://evil.test" } }),
          )
        ).status,
        403,
      );
      assert.equal((await client.signOut()).error, null);
      assert.equal((await client.getSession()).data, null);
      assert.equal(
        (await client.signIn.email({ email: "owner@example.test", password: "integration-password-1" })).error,
        null,
      );
      assert.equal((await client.signOut()).error, null);
      const other = await client.signUp.email({
        email: "other@example.test",
        password: "integration-password-2",
        name: "Other",
      });
      assert.equal(other.error, null);
      assert.equal((await client.appPreferences.get()).data?.value, null);
      assert.equal((await client.appPreferences.set({ value: "other" })).error, null);
      assert.equal((await client.inbox.list()).data?.notifications.length, 0);
      assert.equal(
        (await client.organization.createTeam({ name: "Unauthorized", organizationId: organizationResult.data.id }))
          .error?.status,
        403,
      );
      assert.equal((await client.inbox.markRead({ id: notice.notifications[0]!.id })).error?.status, 404);
      assert.equal((await client.signOut()).error, null);
      assert.equal(
        (await client.signIn.email({ email: "owner@example.test", password: "integration-password-1" })).error,
        null,
      );
      assert.equal((await client.appPreferences.get()).data?.value, "light");
      const enabled = await client.twoFactor.enable({ password: "integration-password-1" });
      assert.equal(enabled.error, null);
      assert.equal(enabled.data?.method, "totp");
      assert(enabled.data && "totpURI" in enabled.data && enabled.data.totpURI);
      const stored = await admin.query<{ secret: string }>(`SELECT secret FROM "${namespace}"."twoFactor"`);
      assert.equal(stored.rowCount, 1);
      const secret = await symmetricDecrypt({
        key: "test-only-native-http-secret-at-least-32-characters",
        data: stored.rows[0]!.secret,
      });
      const code = await native.api.generateTOTP({ body: { secret } });
      assert.equal((await client.twoFactor.verifyTotp({ code: code.code })).error, null);
      assert.equal((await client.getSession()).data?.user.twoFactorEnabled, true);
      assert.equal((await client.signOut()).error, null);
      const challenge = await client.signIn.email({ email: "owner@example.test", password: "integration-password-1" });
      assert.equal(challenge.error, null);
      assert(challenge.data && "twoFactorRedirect" in challenge.data && challenge.data.twoFactorRedirect);
      assert.equal((await client.getSession()).data, null);
      assert.equal((await client.token()).error?.status, 401);
      assert(enabled.data && "backupCodes" in enabled.data);
      const backup = enabled.data.backupCodes[0];
      assert(backup);
      assert.equal((await client.twoFactor.verifyBackupCode({ code: backup })).error, null);
      assert.equal((await client.getSession()).data?.user.id, signup.data.user.id);
      assert.equal((await client.signOut()).error, null);
      await client.signIn.email({ email: "owner@example.test", password: "integration-password-1" });
      assert((await client.twoFactor.verifyBackupCode({ code: backup })).error, "Backup codes must be single-use");
      assert.equal((await client.getSession()).data, null);
      assert.equal(
        (
          await running.fetch(
            new Request("https://api.test/api/auth/totp/generate", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ secret }),
            }),
          )
        ).status,
        404,
      );
    } finally {
      await service?.stop();
      await admin.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
      await admin.query(`DROP SCHEMA IF EXISTS "${metadataNamespace}" CASCADE`);
      await admin.query(`DROP ROLE IF EXISTS "${runtimeRole}"`);
      await admin.end();
      await rm(root, { recursive: true, force: true });
    }
  },
  90_000,
);
