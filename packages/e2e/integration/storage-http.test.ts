import assert from "node:assert/strict";
import { test } from "bun:test";
import pg from "pg";
import { defineRelations } from "drizzle-orm";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { bootstrapDatabase } from "kello-cli";
import { createRpcRuntime, createJwtVerifier, defineSchema, defineProcedureStorage } from "kello/server";
import { createStorageHttpApp } from "kello/neon";
import { createStorageClient, KelloClientError } from "kello/client";
import { storageProviderFixture } from "../fixtures/storage-provider";

const connectionString = process.env.LOOM_TEST_DATABASE_URL;
test.skipIf(!connectionString)(
  "storage HTTP verifies tenant JWTs and preserves intents across lost client responses",
  async () => {
    if (!connectionString) throw new Error("Missing database");
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const metadataNamespace = `loom_${suffix}`;
    const runtimeRole = `runtime_${suffix}`;
    const admin = new pg.Client({ connectionString });
    const provider = storageProviderFixture();
    await admin.connect();
    try {
      await bootstrapDatabase({ connectionString, metadataNamespace, runtimeRole });
      await admin.query(`ALTER ROLE "${runtimeRole}" LOGIN PASSWORD 'loom-test-only'`);
      const address = new URL(connectionString);
      address.username = runtimeRole;
      address.password = "loom-test-only";
      const schema = defineSchema(() => ({}));
      let permitted = true;
      const runtime = await createRpcRuntime({
        schema,
        relations: defineRelations(schema.tables),
        connectionString: address.href,
        metadataNamespace,
        deployment: "storage-http",
        version: "a".repeat(64),
        procedures: [],
        assertActive: async () => {},
        storage: defineProcedureStorage({
          buckets: { uploads: {} },
          authorize: ({ identity }) => {
            assert.equal(identity.subject, "alice");
            if (!permitted) throw new Error("private-policy-secret");
          },
        }),
        storageBackend: { projectId: "project", branchId: "br-preview", connect: provider.connect },
      });
      const { publicKey, privateKey } = await generateKeyPair("ES256");
      const issuer = "https://identity.test";
      const tokenFor = (tenant: string) =>
        new SignJWT({ tenant })
          .setProtectedHeader({ alg: "ES256" })
          .setIssuer(issuer)
          .setSubject("alice")
          .setAudience("kello")
          .setExpirationTime("1m")
          .sign(privateKey);
      const token = await tokenFor("one");
      const otherToken = await tokenFor("two");
      const verify = createJwtVerifier([
        {
          issuer,
          audience: "kello",
          tenantClaim: "tenant",
          keys: { type: "local", jwks: { keys: [await exportJWK(publicKey)] } },
        },
      ]);
      const app = createStorageHttpApp({
        storage: runtime.storage?.intents,
        verify,
        origins: ["https://app.test"],
      });
      const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
      try {
        let lost = false;
        const client = createStorageClient({
          url: server.url.href,
          getAuth: async () => ({ token, identityKey: "alice-one" }),
          fetch: async (url, init) => {
            const response = await fetch(url, init);
            if (!lost && response.ok) {
              lost = true;
              await response.body?.cancel();
              throw new Error("lost response");
            }
            return response;
          },
        });
        const other = createStorageClient({
          url: server.url.href,
          getAuth: async () => ({ token: otherToken, identityKey: "alice-two" }),
        });
        const { id: _id, ...upload } = provider.intent;
        const anonymous = createStorageClient({ url: server.url.href });
        await assert.rejects(
          anonymous.create(upload),
          (cause) => cause instanceof KelloClientError && cause.code === "UNAUTHENTICATED",
        );
        const saved = await client.create(upload, { idempotencyKey: "once" });
        assert.equal(lost, true);
        assert.equal(
          (await admin.query(`SELECT count(*)::int AS count FROM "${metadataNamespace}".storage_intents`)).rows[0]
            .count,
          1,
        );
        assert.deepEqual(await client.create(upload, { idempotencyKey: "once" }), saved);
        await assert.rejects(
          client.create({ ...upload, size: upload.size + 1 }, { idempotencyKey: "once" }),
          (cause) => cause instanceof KelloClientError && cause.code === "IDEMPOTENCY_CONFLICT",
        );
        await assert.rejects(
          other.status(saved.id),
          (cause) => cause instanceof KelloClientError && cause.code === "FORBIDDEN",
        );
        await assert.rejects(
          other.signUpload(saved.id),
          (cause) => cause instanceof KelloClientError && cause.code === "FORBIDDEN",
        );
        await assert.rejects(
          client.signDownload(saved.id),
          (cause) => cause instanceof KelloClientError && cause.code === "STORAGE_UNAVAILABLE",
        );
        const signed = await client.signUpload(saved.id);
        assert.equal(
          (await fetch(signed.url, { method: signed.method, headers: signed.headers, body: provider.body })).status,
          200,
        );
        assert.equal((await client.finalize(saved.id)).state, "ready");
        assert.equal((await client.finalize(saved.id)).state, "ready");
        assert.equal((await client.status(saved.id)).state, "ready");
        const download = await client.signDownload(saved.id);
        assert.equal(await (await fetch(download.url)).text(), provider.body.toString());
        await assert.rejects(
          other.signDownload(saved.id),
          (cause) => cause instanceof KelloClientError && cause.code === "FORBIDDEN",
        );
        permitted = false;
        await assert.rejects(
          client.signDownload(saved.id),
          (cause) =>
            cause instanceof KelloClientError &&
            cause.code === "FORBIDDEN" &&
            !cause.message.includes("private-policy-secret"),
        );
        permitted = true;
        const url = new URL("/api/kello/storage", server.url);
        const headers = {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          origin: "https://app.test",
        };
        assert.equal(
          (
            await fetch(url, {
              method: "POST",
              headers,
              body: JSON.stringify({ protocol: 1, operation: "status", id: saved.id, identity: { subject: "alice" } }),
            })
          ).status,
          400,
        );
        assert.equal(
          (await fetch(url, { method: "POST", headers: { ...headers, origin: "https://attacker.test" }, body: "{}" }))
            .status,
          403,
        );
        assert.equal((await fetch(url, { method: "POST", headers, body: "x".repeat(16385) })).status, 413);
        const preflight = await fetch(url, {
          method: "OPTIONS",
          headers: {
            origin: "https://app.test",
            "access-control-request-method": "POST",
            "access-control-request-headers": "authorization,content-type",
          },
        });
        assert.equal(preflight.status, 204);
        assert.equal(preflight.headers.get("access-control-allow-origin"), "https://app.test");
        assert.equal(preflight.headers.has("access-control-allow-credentials"), false);
        const bad = await client.create({ ...upload, sha256: "0".repeat(64) }, { idempotencyKey: "bad" });
        const badSigned = await client.signUpload(bad.id);
        await fetch(badSigned.url, { method: badSigned.method, headers: badSigned.headers, body: provider.body });
        await assert.rejects(
          client.finalize(bad.id),
          (cause) => cause instanceof KelloClientError && cause.code === "STORAGE_VERIFICATION_FAILED",
        );
        assert.deepEqual(await client.status(bad.id), {
          id: bad.id,
          state: "failed",
          errorCode: "VERIFICATION_FAILED",
        });
      } finally {
        await runtime.stop();
        await server.stop(true);
      }
    } finally {
      await provider.cleanup();
      await admin.query(`DROP SCHEMA IF EXISTS "${metadataNamespace}" CASCADE`);
      await admin.query(`DROP ROLE IF EXISTS "${runtimeRole}"`);
      await admin.end();
    }
  },
);
