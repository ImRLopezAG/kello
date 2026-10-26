import assert from "node:assert/strict";
import { test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout } from "node:timers/promises";
import pg from "pg";
import * as v from "valibot";
import { createNeonApiFromOptions } from "@neon/config-runtime/v1";
import { createClient } from "../fixtures/historical/client";
import {
  applyMigrations,
  defineConfig,
  deployProjectRelease,
  generateProject,
  inspectDeploymentTarget,
  readNeonFunctionReceipt,
} from "kello-cli";
import { createCloudIssuer } from "../fixtures/cloud-issuer";

const hash = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/));
test.skipIf(process.env.LOOM_CLOUD_UPGRADE !== "1")(
  "populated Neon release resumes and migrates a retained legacy job",
  async () => {
    const projectId = process.env.KELLO_CLOUD_PROJECT_ID;
    const branchId = process.env.LOOM_CLOUD_BRANCH_ID;
    const connectionString = process.env.LOOM_MIGRATION_DATABASE_URL;
    const runtimeRole = process.env.LOOM_CLOUD_RUNTIME_ROLE;
    const apiKey = process.env.NEON_API_KEY;
    const previousVersion = v.parse(hash, process.env.LOOM_CLOUD_PREVIOUS_VERSION);
    assert(projectId && branchId && connectionString && runtimeRole && apiKey);
    assert.match(runtimeRole, /^runtime_[a-f0-9]{32}$/);
    const config = defineConfig({
      project: "tasks",
      database: { migrations: "kello/migrations" },
      provider: { projectId, targets: { preview: { branchId } } },
    });
    const target = await inspectDeploymentTarget(config, "preview");
    assert.match(target.branchName, /^loom-acceptance-/);
    assert(!target.protected);
    const provider = createNeonApiFromOptions("Kello populated upgrade acceptance", { apiKey });
    const root = await mkdtemp(join(tmpdir(), "loom-cloud-upgrade-"));
    const admin = new pg.Client({ connectionString, connectionTimeoutMillis: 15000 });
    let stage = "prepare";
    try {
      await admin.connect();
      const beforeHistory = (
        await admin.query("SELECT version,hash FROM loom_meta.framework_migrations ORDER BY version")
      ).rows;
      assert.equal(beforeHistory.length, 21, "Upgrade requires the historical metadata format");
      assert.equal(
        (
          await admin.query(
            "SELECT count(*)::integer AS count FROM loom_meta.deployment_activations WHERE state='active' AND version=$1 AND project_id=$2 AND branch_id=$3",
            [previousVersion, projectId, branchId],
          )
        ).rows[0]?.count,
        1,
        "Upgrade must target the actual historical release on this branch",
      );
      const beforeMigrations = (
        await admin.query(
          "SELECT namespace,ordinal,name,hash FROM loom_meta.migration_history ORDER BY namespace,ordinal",
        )
      ).rows;
      const beforeCount = (await admin.query<{ count: number }>("SELECT count(*)::integer AS count FROM app.tasks"))
        .rows[0]?.count;
      assert(beforeCount && beforeCount >= 100, "Upgrade requires a populated historical example");
      const task = (
        await admin.query<{ id: string; issuer: string; subject: string }>(
          "SELECT t._id AS id,p.owner_issuer AS issuer,p.owner_id AS subject FROM app.tasks t JOIN app.projects p ON p._id=t.project_id WHERE p.owner_id='live-load' ORDER BY t._id LIMIT 1",
        )
      ).rows[0];
      assert(task);
      const original = {
        version: previousVersion,
        name: "maintenance:touch",
        kind: "mutation",
        args: { taskId: task.id, title: "upgraded-worker" },
      };
      const jobId = crypto.randomUUID();
      await admin.query(
        "INSERT INTO loom_meta.jobs(id,deployment,deduplication_key,fingerprint,call,identity,due_at,max_attempts,retry_delay_seconds) VALUES($1::uuid,'preview',$1::text,$2,$3::jsonb,$4::jsonb,clock_timestamp()+interval '1 hour',3,0)",
        [
          jobId,
          "f".repeat(64),
          JSON.stringify(original),
          JSON.stringify({ issuer: task.issuer, subject: task.subject }),
        ],
      );
      const source = fileURLToPath(new URL("../../examples/tasks/", import.meta.url));
      stage = "copy historical successor";
      await cp(source, root, {
        recursive: true,
        filter: (path) => !["node_modules", "dist", "_generated", ".kello", ".turbo"].includes(basename(path)),
      });
      await cp(join(source, "kello/migrations"), join(root, "kello/migrations"), {
        recursive: true,
      });
      await symlink(join(source, "node_modules"), join(root, "node_modules"));
      stage = "test issuer";
      const issuer = await createCloudIssuer(root, projectId, branchId);
      const address = new URL(connectionString);
      await writeFile(
        join(root, "kello.config.ts"),
        `import { defineConfig } from "kello-cli"; export default defineConfig(${JSON.stringify({
          project: "tasks",
          database: { migrations: "kello/migrations" },
          provider: { projectId, targets: { preview: { branchId } } },
          auth: {
            origins: ["https://upgrade.test"],
            audience: "loom-acceptance",
            issuers: [{ issuer: issuer.issuer, jwksUrl: issuer.jwksUrl }],
          },
          deployment: {
            environment: "preview",
            deployment: "preview",
            databaseName: decodeURIComponent(address.pathname.slice(1)),
            migrationRole: decodeURIComponent(address.username),
            runtimeRole,
            quarantine: "preserve",
          },
        })});`,
      );
      await mkdir(join(root, "kello/internal"), { recursive: true });
      await mkdir(join(root, "kello/contracts/internal"), { recursive: true });
      await writeFile(
        join(root, "kello/contracts/internal/maintenance.ts"),
        `import { defineContract, oc } from "kello/contract"; import * as v from "valibot";
export default defineContract(({validators}) => ({ touch: oc.input(v.strictObject({id:validators.id("tasks"),title:v.string()})).output(v.null()) }));`,
      );
      await writeFile(
        join(root, "kello/internal/maintenance.ts"),
        `import { os } from "../_generated/rpc";
import { eq } from "drizzle-orm";
import { requireIdentity } from "../access";
export default os.internal.maintenance.router({ touch: os.internal.maintenance.touch.handler(async ({context,input}) => {
 const owner = requireIdentity(context.identity);
 const owned = await context.db.query.tasks.findFirst({ where: { _id: {eq: input.id}, project: {ownerIssuer: owner.issuer, ownerId: owner.subject} } });
 if (!owned) throw new Error("Missing owned task");
 await context.db.update(context.tables.tasks).set({title: input.title}).where(eq(context.tables.tasks._id, owned._id)); return null;
}) });`,
      );
      await writeFile(
        join(root, "kello/upgrade.ts"),
        `import { defineJobMigration } from "kello/server"; import * as v from "valibot"; import maintenance from "./internal/maintenance"; const touch = maintenance.touch; import schema from "./schema";
export default [defineJobMigration({from:{protocol:"loom-legacy-1",version:"${previousVersion}",name:"maintenance:touch",kind:"mutation"},input:v.strictObject({taskId:schema.id("tasks"),title:v.string()}),to:touch,transform:({taskId,title})=>({id:taskId,title})})];`,
      );
      stage = "generate successor";
      const generated = await generateProject(root);
      stage = "generated project typecheck";
      await writeFile(
        join(root, "tsconfig.acceptance.json"),
        JSON.stringify({ extends: "./tsconfig.json", include: ["kello/**/*.ts", "kello.config.ts"] }),
      );
      await promisify(execFile)("bun", ["x", "tsc", "-p", "tsconfig.acceptance.json"], {
        cwd: root,
        timeout: 60000,
      }).catch(async (cause) => {
        const diagnostics = v.safeParse(v.object({ stdout: v.string() }), cause);
        if (diagnostics.success && process.env.LOOM_CLOUD_RECEIPT)
          await writeFile(`${process.env.LOOM_CLOUD_RECEIPT}.typecheck.log`, diagnostics.output.stdout, {
            mode: 0o600,
          });
        throw cause;
      });
      stage = "metadata upgrade";
      await applyMigrations({
        connectionString,
        root,
        runtimeRole,
        namespace: "app",
        migrations: "kello/migrations",
      });
      const password = crypto.randomUUID();
      await admin.query(`ALTER ROLE "${runtimeRole}" LOGIN PASSWORD '${password}'`);
      address.username = runtimeRole;
      address.password = password;
      process.env.LOOM_DATABASE_URL = address.href;
      process.env.LOOM_DIRECT_DATABASE_URL = address.href;
      process.env.LOOM_ACTIVATION_TOKEN = crypto.randomUUID().replaceAll("-", "").repeat(2);
      const interrupted = new AbortController();
      let submitted = false;
      const submit = provider.deployBranchFunction.bind(provider);
      provider.deployBranchFunction = async (...args: Parameters<typeof provider.deployBranchFunction>) => {
        const result = await submit(...args);
        submitted = true;
        interrupted.abort(new Error("Deliberate acceptance interruption"));
        return result;
      };
      stage = "interrupted deployment";
      try {
        await assert.rejects(deployProjectRelease(root, "kello.config.ts", provider, interrupted.signal), (cause) => {
          if (!submitted) throw cause;
          return true;
        });
      } finally {
        provider.deployBranchFunction = submit;
      }
      assert(submitted, "Interruption must occur after a real provider submission");
      assert.deepEqual(
        (await admin.query("SELECT call,state,attempts FROM loom_meta.jobs WHERE id=$1", [jobId])).rows,
        [{ call: original, state: "pending", attempts: 0 }],
      );
      stage = "resume deployment";
      const release = await deployProjectRelease(root, "kello.config.ts", provider, AbortSignal.timeout(240000));
      assert.equal(release.completed.at(-1)?.stage, "complete");
      const functions = release.completed.find((entry) => entry.stage === "functions");
      assert(functions);
      const receipt = await readNeonFunctionReceipt(root, functions.artifactHash);
      const service = receipt.functions[0].invocationUrl;
      assert(service);
      const history = (await admin.query("SELECT version,hash FROM loom_meta.framework_migrations ORDER BY version"))
        .rows;
      assert.deepEqual(history.slice(0, beforeHistory.length), beforeHistory);
      assert.equal(history.length, 23);
      assert.deepEqual(
        (
          await admin.query(
            "SELECT namespace,ordinal,name,hash FROM loom_meta.migration_history ORDER BY namespace,ordinal",
          )
        ).rows,
        beforeMigrations,
      );
      assert.equal((await admin.query("SELECT count(*)::integer AS count FROM app.tasks")).rows[0].count, beforeCount);
      const legacy = createClient({ url: service });
      await assert.rejects(
        legacy.call(
          { name: "tasks:list", kind: "query", visibility: "public", version: previousVersion },
          { projectId: task.id },
        ),
        { code: "VERSION_MISMATCH" },
      );
      stage = "scheduled provider worker";
      await admin.query("UPDATE loom_meta.jobs SET due_at=clock_timestamp() WHERE id=$1", [jobId]);
      const deadline = performance.now() + 180000;
      for (;;) {
        const saved = (
          await admin.query("SELECT call,state,attempts,claim_version FROM loom_meta.jobs WHERE id=$1", [jobId])
        ).rows[0];
        assert(saved);
        assert.deepEqual(saved.call, original);
        assert.equal(saved.claim_version, generated.version);
        if (saved.state === "succeeded") {
          assert.equal(saved.attempts, 1);
          break;
        }
        assert.notEqual(saved.state, "failed");
        assert(performance.now() < deadline, "Scheduled worker did not complete migrated job");
        await setTimeout(1000);
      }
      assert.equal(
        (await admin.query("SELECT title FROM app.tasks WHERE _id=$1", [task.id])).rows[0].title,
        "upgraded-worker",
      );
      if (process.env.LOOM_CLOUD_RECEIPT)
        await writeFile(
          process.env.LOOM_CLOUD_RECEIPT,
          JSON.stringify(
            {
              projectId,
              branchId,
              previousVersion,
              version: generated.version,
              jobId,
              frameworkVersions: history.length,
              preservedTasks: beforeCount,
              interruptedAfterSubmission: submitted,
              passed: true,
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
          JSON.stringify(
            {
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
            },
            null,
            2,
          ),
        );
      throw new Error(`Hosted populated upgrade failed during ${stage}; owned branch retained for diagnosis`);
    } finally {
      await admin.end();
      await rm(root, { recursive: true, force: true });
    }
  },
  600000,
);
