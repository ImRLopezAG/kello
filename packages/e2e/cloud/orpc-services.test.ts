import assert from "node:assert/strict";
import { test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import pg from "pg";
import * as v from "valibot";
import { createNeonApiFromOptions } from "@neon/config-runtime/v1";
import type { StorageUpload } from "kello/server";
import {
  applyMigrations,
  defineConfig,
  deployProjectRelease,
  generateProject,
  inspectDeploymentTarget,
  readNeonFunctionReceipt,
} from "kello/tooling";
import { createCloudIssuer } from "../fixtures/cloud-issuer";

/** Assembled REST and invocation services on a real storage-enabled branch. */
test.skipIf(process.env.LOOM_CLOUD_SERVICES !== "1")(
  "Neon REST invokes identity-bound Promise and Effect storage",
  async () => {
    const projectId = process.env.LOOM_CLOUD_PROJECT_ID;
    const branchId = process.env.LOOM_CLOUD_BRANCH_ID;
    const connectionString = process.env.LOOM_MIGRATION_DATABASE_URL;
    const runtimeRole = process.env.LOOM_CLOUD_RUNTIME_ROLE;
    const apiKey = process.env.NEON_API_KEY;
    assert(projectId && branchId && connectionString && runtimeRole && apiKey);
    assert.match(runtimeRole, /^runtime_[a-f0-9]{32}$/);
    const target = await inspectDeploymentTarget(
      defineConfig({
        project: "jobs-storage",
        database: { migrations: "kello/migrations" },
        provider: { projectId, targets: { preview: { branchId } } },
      }),
      "preview",
    );
    assert.match(target.branchName, /^loom-acceptance-/);
    assert(!target.protected);
    const provider = createNeonApiFromOptions("Kello hosted service acceptance", { apiKey });
    const origin = `https://services-${crypto.randomUUID()}.test`;
    const root = await mkdtemp(join(tmpdir(), "loom-cloud-services-"));
    const admin = new pg.Client({ connectionString, connectionTimeoutMillis: 15000 });
    let stage = "prepare";
    try {
      const source = fileURLToPath(new URL("../../examples/jobs-storage/", import.meta.url));
      await cp(source, root, {
        recursive: true,
        filter: (path) => !["node_modules", "dist", "_generated", ".loom", ".turbo"].includes(basename(path)),
      });
      await cp(join(source, "kello/migrations"), join(root, "kello/migrations"), {
        recursive: true,
      });
      await symlink(fileURLToPath(new URL("../node_modules/", import.meta.url)), join(root, "node_modules"));
      const issuer = await createCloudIssuer(root, projectId, branchId);
      await writeFile(
        join(root, "kello/app.config.ts"),
        `import { defineApplication } from "kello/server";
import * as v from "valibot";
export default defineApplication({
 env: { LOOM_ACCEPTANCE_NUMBER: v.pipe(v.string(), v.transform(Number), v.integer()), NEON_BRANCH: v.string() },
 rpc: ({os}) => ({os}),
});`,
      );
      process.env.LOOM_ACCEPTANCE_NUMBER = "42";
      await rm(join(root, "kello/functions"), { recursive: true });
      await rm(join(root, "kello/contracts/files.ts"));
      await writeFile(
        join(root, "kello/contracts/probe.ts"),
        `import { defineContract, oc } from "kello/contract";
import { storageUploadValidator } from "kello/server";
import * as v from "valibot";
const base = oc.errors({ FORBIDDEN: {}, UNAUTHORIZED: {} });
export default defineContract({
 create: base.input(v.strictObject({upload:storageUploadValidator,key:v.string()})).output(v.strictObject({id:v.string()})),
 status: base.input(v.strictObject({id:v.string()})).output(v.strictObject({id:v.string(),state:v.string()})),
 large: base.output(v.string()),
 environment: base.input(v.strictObject({})).output(v.strictObject({number:v.number(),branch:v.string()})),
});`,
      );
      await mkdir(join(root, "kello/functions"));
      await writeFile(
        join(root, "kello/functions/probe.ts"),
        `import { os } from "../_generated/rpc";
import { Storage } from "kello/server";
import { Effect } from "effect";
export default os.probe.router({
 create: os.probe.create.handler(async ({context,input}) => ({id:(await context.storage.create(input.upload,input.key)).id})),
 status: os.probe.status.effect(function* ({input}) {const storage=yield* Storage; const saved=yield* Effect.tryPromise({try:()=>storage.status(input.id),catch:cause=>cause}); return {id:saved.id,state:saved.state};}),
 environment: os.probe.environment.handler(({context})=>({number:context.env.LOOM_ACCEPTANCE_NUMBER,branch:context.env.NEON_BRANCH})),
 large: os.probe.large.handler(async ()=>{await new Promise(resolve=>setTimeout(resolve,2000));return "x".repeat(262144);}),
});`,
      );
      const address = new URL(connectionString);
      await writeFile(
        join(root, "kello.config.ts"),
        `import {defineConfig} from "kello/tooling"; export default defineConfig(${JSON.stringify({ project: "jobs-storage", database: { migrations: "kello/migrations" }, openapi: true, provider: { projectId, targets: { preview: { branchId } } }, auth: { origins: [origin], audience: "loom-acceptance", issuers: [{ issuer: issuer.issuer, jwksUrl: issuer.jwksUrl }] }, deployment: { environment: "preview", deployment: "preview", databaseName: decodeURIComponent(address.pathname.slice(1)), migrationRole: decodeURIComponent(address.username), runtimeRole, quarantine: "preserve" } })});`,
      );
      const generated = await generateProject(root);
      // Typecheck backend independently: this fixture deliberately replaces frontend routes.
      await writeFile(
        join(root, "tsconfig.acceptance.json"),
        JSON.stringify({ extends: "./tsconfig.json", include: ["kello/**/*.ts", "kello.config.ts"] }),
      );
      await promisify(execFile)("bun", ["x", "tsc", "-p", "tsconfig.acceptance.json"], { cwd: root, timeout: 60000 });
      stage = "deploy";
      await applyMigrations({
        connectionString,
        root,
        runtimeRole,
        namespace: "app",
        migrations: "kello/migrations",
      });
      await admin.connect();
      const password = crypto.randomUUID();
      await admin.query(`ALTER ROLE "${runtimeRole}" LOGIN PASSWORD '${password}'`);
      address.username = runtimeRole;
      address.password = password;
      process.env.LOOM_DATABASE_URL = address.href;
      process.env.LOOM_ACTIVATION_TOKEN = crypto.randomUUID().replaceAll("-", "").repeat(2);
      const release = await deployProjectRelease(root, "kello.config.ts", provider, AbortSignal.timeout(240000));
      const functions = release.completed.find((entry) => entry.stage === "functions");
      assert(functions);
      const receipt = await readNeonFunctionReceipt(root, functions.artifactHash);
      const service = receipt.functions[0].invocationUrl;
      assert(service);
      const serviceUrl = new URL(service);
      const token = await issuer.token("services-owner", "loom-acceptance", "10m");
      async function request(
        path: string,
        input: { id: string } | { upload: StorageUpload; key: string } | Record<never, never>,
        bearer = token,
        version = generated.version,
      ) {
        return fetch(new URL(`/api/kello/openapi/${path}`, serviceUrl), {
          method: "POST",
          headers: {
            authorization: `Bearer ${bearer}`,
            origin,
            "content-type": "application/json",
            "x-loom-protocol": "loom-orpc-2",
            "x-loom-version": version,
          },
          body: JSON.stringify(input),
          signal: AbortSignal.timeout(15000),
        });
      }
      stage = "application environment";
      const environment = await request("probe/environment", {});
      assert.equal(environment.status, 200);
      assert.deepEqual(await environment.json(), { number: 42, branch: target.branchName });
      stage = "Promise storage over REST";
      const created = await request("probe/create", {
        upload: { bucket: "uploads", size: 3, contentType: "text/plain", sha256: "a".repeat(64) },
        key: crypto.randomUUID(),
      });
      assert.equal(created.status, 200);
      const intent = v.parse(v.strictObject({ id: v.pipe(v.string(), v.uuid()) }), await created.json());
      stage = "Effect storage over REST";
      const status = await request("probe/status", intent);
      assert.equal(status.status, 200);
      assert.deepEqual(await status.json(), { ...intent, state: "pending" });
      const other = await issuer.token("services-other", "loom-acceptance", "10m");
      const denied = await request("probe/status", intent, other);
      assert.equal(denied.status, 403);
      await denied.body?.cancel();
      const invalid = await request("probe/status", intent, "invalid");
      assert.equal(invalid.status, 401);
      await invalid.body?.cancel();
      const stale = await request("probe/status", intent, token, "a".repeat(64));
      assert.equal(stale.status, 409);
      await stale.body?.cancel();
      const privateRoute = await request("files/created", intent);
      assert.equal(privateRoute.status, 404);
      await privateRoute.body?.cancel();
      if (process.env.LOOM_CLOUD_RECEIPT)
        await writeFile(
          process.env.LOOM_CLOUD_RECEIPT,
          JSON.stringify(
            {
              projectId,
              branchId,
              version: generated.version,
              region: process.env.LOOM_CLOUD_REGION,
              passed: true,
              checks: [
                "assembled-openapi",
                "application-environment-transform",
                "provider-injected-environment",
                "promise-storage",
                "effect-storage",
                "cross-owner-refusal",
                "authentication",
                "stale-version",
                "private-route",
              ],
              completedAt: new Date().toISOString(),
            },
            null,
            2,
          ),
        );
    } catch (cause) {
      if (process.env.LOOM_CLOUD_RECEIPT)
        await writeFile(
          process.env.LOOM_CLOUD_RECEIPT,
          JSON.stringify({
            projectId,
            branchId,
            stage,
            passed: false,
            frames:
              cause instanceof Error
                ? cause.stack
                    ?.split("\n")
                    .filter((line) => /^\s+at .*:\d+:\d+\)?$/.test(line))
                    .slice(0, 5)
                : [],
            error:
              cause instanceof assert.AssertionError
                ? cause.message
                : cause instanceof Error
                  ? cause.name
                  : "UnknownError",
          }),
        );
      throw new Error(`Hosted service acceptance failed during ${stage}; owned branch retained`);
    } finally {
      delete process.env.LOOM_ACCEPTANCE_NUMBER;
      await admin.end();
      await rm(root, { recursive: true, force: true });
    }
  },
  600000,
);
