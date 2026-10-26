import assert from "node:assert/strict";
import { test } from "bun:test";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { S3Client, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import * as v from "valibot";
import { bootstrapDatabase, createKelloNeonApi } from "kello-cli";
import { createStorageIntents } from "kello/server";
import { createNeonObjectStorage } from "kello/neon";

/** Live provider regression: each test owns both branches and revokes its credentials. */
test.skipIf(process.env.LOOM_CLOUD_STORAGE_BRANCH !== "1")(
  "finalized files remain readable after a Neon branch fork",
  async () => {
    const projectId = v.parse(v.string(), process.env.KELLO_CLOUD_PROJECT_ID);
    const cli = createRequire(import.meta.resolve("kello-cli")).resolve("neon/dist/index.js");
    async function neon(args: string[]) {
      try {
        return (
          await promisify(execFile)("node", [cli, ...args, "--project-id", projectId, "--output", "json"], {
            timeout: 90000,
          })
        ).stdout;
      } catch {
        throw new Error(`Neon operation failed: ${args[0]} ${args[1]}`);
      }
    }
    const api = createKelloNeonApi();
    const branches = await api.listBranches(projectId);
    const main = branches.find((branch) => branch.isDefault);
    assert(main);
    const owned: string[] = [];
    const intendedBranches: Array<{ name: string; parentId: string }> = [];
    const credentials: Array<{ branch: string; id: string }> = [];
    const connections: pg.Pool[] = [];
    const adapters: ReturnType<typeof createNeonObjectStorage>[] = [];
    const clients: S3Client[] = [];
    const checks: string[] = [];
    const operations: Array<{ command: string; status: number | undefined; error?: string }> = [];
    let stage = "create parent";
    const cleanupFailures: string[] = [];
    let failure: unknown;
    let passed = false;
    async function fork(parent: string, prefix: string) {
      const name = `${prefix}-${crypto.randomUUID()}`;
      intendedBranches.push({ name, parentId: parent });
      const raw: unknown = JSON.parse(
        await neon(["branches", "create", "--parent", parent, "--name", name, "--no-secrets"]),
      );
      const branchRecord = v.object({ id: v.string(), name: v.string() });
      const parsed = v.parse(v.union([branchRecord, v.object({ branch: branchRecord })]), raw);
      const branch = "branch" in parsed ? parsed.branch : parsed;
      assert.equal(branch.name, name);
      assert.notEqual(branch.id, main!.id);
      owned.push(branch.id);
      return branch.id;
    }
    async function setup(branchId: string) {
      assert(owned.includes(branchId));
      const raw = JSON.parse(
        await neon([
          "credentials",
          "create",
          "--branch",
          branchId,
          "--scope",
          "storage:read",
          "--scope",
          "storage:write",
          "--name",
          "loom-branch-acceptance",
        ]),
      );
      const credential = v.parse(v.object({ token_id: v.string(), s3_secret_access_key: v.string() }), raw);
      credentials.push({ branch: branchId, id: credential.token_id });
      const location = await api.getProjectBranchStorage(projectId, branchId);
      assert(location);
      const storageOptions = {
        projectId,
        branchId,
        endpoint: location.s3Endpoint,
        region: location.region,
        credentials: { accessKeyId: credential.token_id, secretAccessKey: credential.s3_secret_access_key },
      };
      const s3 = new S3Client({ ...storageOptions, forcePathStyle: true, requestChecksumCalculation: "WHEN_REQUIRED" });
      s3.middlewareStack.add(
        (next, context) => async (args) => {
          try {
            const result = await next(args);
            operations.push({
              command: context.commandName ?? "unknown",
              status: v.parse(v.object({ statusCode: v.optional(v.number()) }), result.response).statusCode,
            });
            return result;
          } catch (cause) {
            const detail = v.safeParse(
              v.object({ name: v.string(), $metadata: v.object({ httpStatusCode: v.optional(v.number()) }) }),
              cause,
            );
            if (detail.success)
              operations.push({
                command: context.commandName ?? "unknown",
                status: detail.output.$metadata.httpStatusCode,
                error: detail.output.name,
              });
            throw cause;
          }
        },
        { step: "initialize", name: "acceptanceDiagnostics" },
      );
      const storage = createNeonObjectStorage(storageOptions, s3);
      adapters.push(storage);
      clients.push(s3);
      // CLI connection output is captured and never logged.
      const connectionString = (
        await promisify(execFile)(
          "node",
          [
            cli,
            "connection-string",
            branchId,
            "--project-id",
            projectId,
            "--role-name",
            "neondb_owner",
            "--ssl",
            "verify-full",
          ],
          { timeout: 30000 },
        )
      ).stdout.trim();
      const pool = new pg.Pool({ connectionString, connectionTimeoutMillis: 15000 });
      connections.push(pool);
      return { branchId, connectionString, pool, s3, storage };
    }
    const metadataNamespace = `loom_files_${crypto.randomUUID().replaceAll("-", "")}`;
    const identity = { issuer: "https://acceptance.test", subject: "alice" };
    const bucket = "branch-files";
    const body = "finalized on parent";
    const upload = {
      bucket,
      size: Buffer.byteLength(body),
      contentType: "text/plain",
      sha256: createHash("sha256").update(body).digest("hex"),
    };
    const intents = (connection: Awaited<ReturnType<typeof setup>>) =>
      createStorageIntents({
        db: drizzle({ client: connection.pool }),
        metadataNamespace,
        deployment: `storage-${connection.branchId}`,
        applicationNamespace: "acceptance_app",
        projectId,
        branchId: connection.branchId,
        buckets: [bucket],
        storage: connection.storage,
        assertActive: async () => {},
        authorize: () => {},
      });
    try {
      const parentId = await fork(main.id, "loom-acceptance-storage");
      await api.createBranchBucket(projectId, parentId, { name: bucket, accessLevel: "private" });
      const parent = await setup(parentId);
      await bootstrapDatabase({
        connectionString: parent.connectionString,
        metadataNamespace,
        runtimeRole: "storage_acceptance",
      });
      const parentFiles = intents(parent);
      stage = "parent finalize";
      const ready = await parentFiles.create(identity, upload, "ready");
      const signed = await parentFiles.signUpload(identity, ready.id);
      const put = await fetch(signed.url, { method: "PUT", headers: signed.headers, body });
      assert(put.ok, `Upload status ${put.status}`);
      await put.body?.cancel();
      assert.equal((await parentFiles.finalize(identity, ready.id)).state, "ready");
      const pending = await parentFiles.create(identity, upload, "pending");
      const parentDownload = await parentFiles.signDownload(identity, ready.id);
      const key = new URL(parentDownload.url).pathname.slice(`/${bucket}/`.length);
      checks.push("parent-finalized");
      stage = "fork and provider inheritance";
      const childId = await fork(parentId, "loom-acceptance-storage-child");
      const child = await setup(childId);
      const inherited = await child.s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      assert.equal(await inherited.Body?.transformToString(), body);
      checks.push("child-credential-provider-inheritance");
      stage = "Kello inherited read";
      const childFiles = intents(child);
      const download = await childFiles.signDownload(identity, ready.id);
      const response = await fetch(download.url);
      assert.equal(await response.text(), body);
      await assert.rejects(childFiles.signDownload({ ...identity, subject: "bob" }, ready.id));
      await assert.rejects(childFiles.signUpload(identity, pending.id));
      await assert.rejects(childFiles.finalize(identity, pending.id));
      checks.push("loom-inherited-owner-read", "cross-owner-denied", "inherited-pending-denied");
      const newPending = await childFiles.create(identity, upload, "pending");
      assert.notEqual(newPending.id, pending.id);
      stage = "copy-on-write delete";
      await child.s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      const original = await parent.s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      assert.equal(await original.Body?.transformToString(), body);
      checks.push("child-request-independent", "child-delete-preserves-parent");
      passed = true;
    } catch (cause) {
      failure = cause;
    } finally {
      for (const adapter of adapters) adapter.close();
      for (const client of clients) client.destroy();
      const pools = await Promise.allSettled(connections.map((pool) => pool.end()));
      if (pools.some((result) => result.status === "rejected")) cleanupFailures.push("database connections");
      for (const credential of credentials.toReversed()) {
        try {
          await neon(["credentials", "revoke", credential.id, "--branch", credential.branch]);
        } catch {
          cleanupFailures.push(`credential on ${credential.branch}`);
        }
      }
      try {
        // Creation may succeed even when its CLI response is lost or malformed.
        const currentBranches = await api.listBranches(projectId);
        for (const intended of intendedBranches.toReversed()) {
          try {
            const matches = currentBranches.filter((branch) => branch.name === intended.name);
            assert(matches.length <= 1, "Ambiguous acceptance branch ownership");
            for (const branch of matches) {
              assert(!branch.isDefault && !branch.protected && branch.id !== main.id);
              assert.equal(branch.parentId, intended.parentId);
              if (!owned.includes(branch.id)) owned.push(branch.id);
              await neon(["branches", "delete", branch.id]);
            }
          } catch {
            cleanupFailures.push(`branch ${intended.name}`);
          }
        }
      } catch {
        cleanupFailures.push("branch discovery");
      }
      if (process.env.LOOM_CLOUD_STORAGE_RECEIPT)
        await writeFile(
          process.env.LOOM_CLOUD_STORAGE_RECEIPT,
          JSON.stringify(
            {
              projectId,
              branches: owned,
              intendedBranches,
              stage,
              passed,
              checks,
              operations,
              cleanup: cleanupFailures.length === 0,
              cleanupFailures,
            },
            null,
            2,
          ),
        );
    }
    if (cleanupFailures.length)
      throw new AggregateError(
        [
          ...(failure === undefined ? [] : [failure]),
          ...cleanupFailures.map((resource) => new Error(`Cleanup failed: ${resource}`)),
        ],
        "Acceptance resources require cleanup",
      );
    if (failure !== undefined) throw failure;
  },
  600000,
);
