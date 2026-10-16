import assert from "node:assert/strict";
import { test } from "bun:test";
import { cp, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout } from "node:timers/promises";
import pg from "pg";
import { createORPCClient } from "@orpc/client";
import type { Client } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import * as v from "valibot";
import { chromium } from "playwright";
import {
  applyMigrations,
  createKelloNeonApi,
  defineConfig,
  deployProjectRelease,
  generateProject,
  inspectDeploymentTarget,
} from "kello/tooling";
import { createCloudIssuer } from "../fixtures/cloud-issuer";
import { deployLiveServices } from "../fixtures/cloud-live-services";
import type { LiveObservation } from "../fixtures/cloud-live-browser";

import { readoutSchema as metricSchema } from "../fixtures/cloud-live-metrics-schema";
const observationSchema = v.object({ index: v.number(), sequence: v.number() });

test.skipIf(process.env.LOOM_CLOUD_LIVE !== "1")(
  "two Neon Functions observe SQL commits and recover listeners",
  async () => {
    const projectId = process.env.LOOM_CLOUD_PROJECT_ID;
    const branchId = process.env.LOOM_CLOUD_BRANCH_ID;
    const connectionString = process.env.LOOM_MIGRATION_DATABASE_URL;
    const runtimeRole = process.env.LOOM_CLOUD_RUNTIME_ROLE;
    assert(projectId && branchId && connectionString && runtimeRole);
    assert.match(runtimeRole, /^runtime_[a-f0-9]{32}$/);
    const mode = v.parse(v.picklist(["notify", "polling"]), process.env.LOOM_CLOUD_LIVE_MODE ?? "notify");
    const workload = v.parse(v.picklist(["spread", "hot-table"]), process.env.LOOM_CLOUD_LIVE_WORKLOAD ?? "spread");
    const warmupSeconds = v.parse(
      v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(60)),
      Number(process.env.LOOM_CLOUD_LIVE_WARMUP_SECONDS ?? "30"),
    );
    const seconds = v.parse(
      v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(600)),
      Number(process.env.LOOM_CLOUD_LIVE_SECONDS ?? "600"),
    );
    const provider = createKelloNeonApi();
    const target = await inspectDeploymentTarget(
      defineConfig({
        project: "tasks",
        database: { migrations: "kello/migrations" },
        provider: { projectId, targets: { preview: { branchId } } },
      }),
      "preview",
    );
    assert.match(target.branchName, /^loom-acceptance-/);
    const root = await mkdtemp(join(tmpdir(), "loom-cloud-live-"));
    const admin = new pg.Client({ connectionString, connectionTimeoutMillis: 15000 });
    const writers = new pg.Pool({
      connectionString,
      application_name: "loom-live-writers",
      max: 10,
      connectionTimeoutMillis: 15000,
      statement_timeout: 15000,
    });
    const frontend = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname === "/live.js") return new Response(Bun.file(join(root, "live.js")));
        return new Response('<!doctype html><script type="module" src="/live.js"></script>', {
          headers: { "content-type": "text/html" },
        });
      },
    });
    const browser = await chromium.launch({ headless: true });
    let stage = "prepare";
    type BrowserStatus = ReturnType<Window["loomLive"]["status"]> | { unavailable: true };
    interface Diagnostics {
      browser?: BrowserStatus;
      metricsError?: string;
      initial?: v.InferOutput<typeof metricSchema>[];
      final?: v.InferOutput<typeof metricSchema>[];
      timings?: { lowerMs: number; upperMs: number }[];
      writingMs?: number;
      idlePool?: { total: number; active: number; idleTransactions: number };
    }
    const diagnostics: Diagnostics = {};
    let browserStatus = async (): Promise<BrowserStatus> => ({ unavailable: true });
    try {
      const source = fileURLToPath(new URL("../../examples/tasks/", import.meta.url));
      await cp(source, root, {
        recursive: true,
        filter: (path) => !["node_modules", "dist", "_generated", ".loom", ".turbo"].includes(basename(path)),
      });
      await cp(join(source, "kello/migrations"), join(root, "kello/migrations"), {
        recursive: true,
      });
      await symlink(join(source, "node_modules"), join(root, "node_modules"));
      stage = "issuer";
      const issuer = await createCloudIssuer(root, projectId, branchId);
      const address = new URL(connectionString);
      await writeFile(
        join(root, "kello.config.ts"),
        `import { defineConfig } from "kello/tooling"; export default defineConfig(${JSON.stringify({
          project: "tasks",
          database: { migrations: "kello/migrations" },
          provider: { projectId, targets: { preview: { branchId } } },
          realtime: { mode, pollIntervalMs: 1000, maxSubscriptions: 100 },
          auth: {
            origins: [frontend.url.origin],
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
      await cp(
        fileURLToPath(new URL("../fixtures/cloud-live-metrics.ts", import.meta.url)),
        join(root, "kello/acceptance-metrics.ts"),
      );
      await cp(
        fileURLToPath(new URL("../fixtures/cloud-live-metrics-schema.ts", import.meta.url)),
        join(root, "kello/acceptance-metrics-schema.ts"),
      );
      await writeFile(
        join(root, "kello/contracts/acceptance.ts"),
        `import { defineContract, oc } from "kello/contract";
import * as v from "valibot";
import { readoutSchema } from "../acceptance-metrics-schema";
export default defineContract(({ validators }) => ({
 metrics: oc.output(readoutSchema),
 finite: oc.input(v.strictObject({ projectId: validators.id("projects") })).output(v.array(v.strictObject({ _id: validators.id("tasks"), projectId: validators.id("projects"), title: v.string(), done: v.boolean() }))),
}));`,
      );
      await writeFile(
        join(root, "kello/functions/acceptance.ts"),
        `import { os } from "../_generated/rpc";
import { readMetrics } from "../acceptance-metrics";
import { requireIdentity } from "../access";
export default os.acceptance.router({
 metrics: os.acceptance.metrics.handler(() => readMetrics()),
 finite: os.acceptance.finite.handler(({context:{db,identity},input}) => {
  const owner = requireIdentity(identity);
  return db.query.tasks.findMany({ columns:{_id:true,projectId:true,title:true,done:true},where:{projectId:{eq:input.projectId},project:{ownerIssuer:owner.issuer,ownerId:owner.subject}},orderBy:{_createdAt:"asc",_id:"asc"},limit:100 });
 }),
});`,
      );
      const generated = await generateProject(root);
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
      process.env.LOOM_DIRECT_DATABASE_URL = address.href;
      process.env.LOOM_ACTIVATION_TOKEN = crypto.randomUUID().replaceAll("-", "").repeat(2);
      stage = "deploy";
      const release = await deployProjectRelease(root, "kello.config.ts", provider, AbortSignal.timeout(240000));
      const functions = release.completed.find((entry) => entry.stage === "functions");
      assert(functions);
      // The normal deployment also owns a scheduled worker. Attribute this
      // assertion to the two measured services, not every isolate using the role.
      const measuredAddress = new URL(address);
      measuredAddress.searchParams.set("application_name", "loom-live-load");
      const services = await deployLiveServices({
        root,
        artifactHash: functions.artifactHash,
        projectId,
        branchId,
        provider,
        environment: {
          LOOM_DATABASE_URL: measuredAddress.href,
          LOOM_DIRECT_DATABASE_URL: measuredAddress.href,
          LOOM_ACTIVATION_TOKEN: process.env.LOOM_ACTIVATION_TOKEN,
        },
      });
      assert.equal(new Set(services.map((service) => service.functionId)).size, 2);
      stage = "seed";
      await admin.query("BEGIN");
      try {
        await admin.query(
          "DELETE FROM app.tasks t USING app.projects p WHERE t.project_id=p._id AND p.owner_issuer=$1 AND p.owner_id='live-load'",
          [issuer.issuer],
        );
        await admin.query("DELETE FROM app.projects WHERE owner_issuer=$1 AND owner_id='live-load'", [issuer.issuer]);
        await admin.query("COMMIT");
      } catch (cause) {
        await admin.query("ROLLBACK");
        throw cause;
      }
      const projects = await admin.query<{ _id: string }>(
        `INSERT INTO app.projects(name,owner_issuer,owner_id) SELECT 'live-'||i,$1,'live-load' FROM generate_series(1,100) i RETURNING _id`,
        [issuer.issuer],
      );
      const ids = projects.rows.map((row) => row._id);
      await admin.query(`INSERT INTO app.tasks(project_id,title) SELECT unnest($1::uuid[]),'0'`, [ids]);
      const build = await Bun.build({
        entrypoints: [fileURLToPath(new URL("../fixtures/cloud-live-browser.ts", import.meta.url))],
        target: "browser",
        minify: true,
      });
      assert(build.success);
      assert(build.outputs[0]);
      await Bun.write(join(root, "live.js"), build.outputs[0]);
      const page = await browser.newPage();
      browserStatus = () => page.evaluate(() => window.loomLive.status());
      async function metrics() {
        const result = await page.evaluate(async () => {
          try {
            return { values: await window.loomLive.metrics() };
          } catch {
            return { error: window.loomLive.status().metricsError ?? "UNKNOWN" };
          }
        });
        if (result.error) {
          diagnostics.metricsError = result.error;
          throw new Error("Live metrics request failed");
        }
        return v.parse(v.array(metricSchema), result.values);
      }
      const arrivals = new Map<number, number>();
      const commits = new Map<number, { started: number; acknowledged: number }>();
      await page.exposeFunction("loomObserved", (value: LiveObservation) => {
        const observation = v.parse(observationSchema, value);
        if (observation.sequence > 0 && !arrivals.has(observation.sequence))
          arrivals.set(observation.sequence, performance.now());
      });
      await page.goto(frontend.url.href);
      await page.waitForFunction(() => !!window.loomLive);
      const token = await issuer.token("live-load", "loom-acceptance", "30m");
      const measuredService = services[0];
      const measuredProject = ids[0];
      assert(measuredService && measuredProject);
      const finiteClient = createORPCClient<{
        acceptance: {
          metrics: Client<Record<never, never>, void, v.InferOutput<typeof metricSchema>, Error>;
          finite: Client<
            Record<never, never>,
            { projectId: string },
            { _id: string; title: string; done: boolean }[],
            Error
          >;
        };
      }>(
        new RPCLink({
          origin: new URL(measuredService.url).origin,
          url: "/api/kello/rpc",
          headers: {
            authorization: `Bearer ${token}`,
            "x-loom-protocol": "loom-orpc-2",
            "x-loom-version": generated.version,
          },
        }),
      );
      const finiteMs = [];
      stage = "finite requests";
      for (let attempt = 0; attempt < 31; attempt++) {
        const started = performance.now();
        assert.equal((await finiteClient.acceptance.finite({ projectId: measuredProject })).length, 1);
        finiteMs.push(performance.now() - started);
      }
      // The provider may route this HTTP request to another isolate. Preserve
      // instance identity and sample counts; do not imply per-call correlation.
      stage = "finite runtime diagnostics";
      const finiteRuntime = v.parse(metricSchema, await finiteClient.acceptance.metrics());
      for (const service of services) {
        const stale = await fetch(new URL("/api/kello/ticket", service.url), {
          method: "POST",
          headers: {
            origin: frontend.url.origin,
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            "x-loom-protocol": "loom-orpc-2",
            "x-loom-version": "a".repeat(64),
          },
          body: "{}",
          signal: AbortSignal.timeout(15000),
        });
        assert.equal(stale.status, 409, "Stale generated clients must receive a deliberate version refusal");
        await stale.body?.cancel();
      }
      await page.evaluate((setup) => window.loomLive.start(setup), {
        services: services.map((service) => ({ url: service.url, version: generated.version, token })),
        projects: ids,
      });
      stage = "subscribe";
      await page.waitForFunction(() => window.loomLive.status().ready === 100, undefined, { timeout: 60000 });
      diagnostics.browser = await page.evaluate(() => window.loomLive.status());
      assert.equal((await page.evaluate(() => window.loomLive.status())).errors, 0);
      stage = "instance metrics";
      const initial = await metrics();
      diagnostics.initial = initial;
      assert.equal(new Set(initial.map((sample) => sample.instance)).size, 2);
      assert(initial.every((sample) => sample.subscriptions === 50));
      const listeners = () =>
        admin.query<{ pid: number }>(
          `SELECT pid FROM pg_stat_activity WHERE usename=$1 AND state='idle' AND query LIKE 'LISTEN "loom_revision_%'`,
          [runtimeRole],
        );
      if (mode === "notify") {
        stage = "listener recovery";
        const before = await listeners();
        assert.equal(before.rows.length, 2, "One listener per active runtime");
        for (const { pid } of before.rows) await admin.query("SELECT pg_terminate_backend($1)", [pid]);
        const deadline = performance.now() + 30000;
        for (;;) {
          const current = await metrics();
          if (current.every((sample) => sample.listener === "connected" && sample.reconnects >= 2)) break;
          assert(performance.now() < deadline, "Listeners did not reconnect");
          await setTimeout(250);
        }
        assert.equal((await listeners()).rows.length, 2);
      }
      stage = "warmup";
      const warming = performance.now();
      for (let index = 0; index < warmupSeconds * 10; index++) {
        const due = warming + index * 100;
        if (performance.now() < due) await setTimeout(due - performance.now());
        await admin.query("UPDATE app.tasks SET title=$1 WHERE project_id=$2", [
          String(index - warmupSeconds * 10),
          ids[index % ids.length],
        ]);
      }
      stage = "load";
      const samples = [];
      const writerWaitSamples = [];
      const start = performance.now();
      const batchSize = workload === "hot-table" ? 10 : 1;
      for (let sequence = 1; sequence <= seconds * 10; sequence += batchSize) {
        const due = start + (sequence - 1) * 100;
        if (performance.now() < due) await setTimeout(due - performance.now());
        const writing = Promise.all(
          Array.from({ length: batchSize }, async (_, offset) => {
            const current = sequence + offset;
            const started = performance.now();
            await (workload === "hot-table" ? writers : admin).query(
              "UPDATE app.tasks SET title=$1 WHERE project_id=$2",
              [String(current), ids[(current - 1) % ids.length]],
            );
            commits.set(current, { started, acknowledged: performance.now() });
          }),
        );
        const locks =
          workload === "hot-table"
            ? admin.query<{ lockWaiters: number; active: number }>(
                "SELECT count(*) FILTER (WHERE wait_event_type='Lock')::integer AS \"lockWaiters\", count(*) FILTER (WHERE state='active')::integer AS active FROM pg_stat_activity WHERE application_name='loom-live-writers'",
              )
            : undefined;
        const [, lockSample] = await Promise.all([writing, locks]);
        if (lockSample) writerWaitSamples.push({ elapsedMs: performance.now() - start, ...lockSample.rows[0] });
        if ((sequence + batchSize - 1) % 100 === 0) {
          const database = await admin.query<{ total: number; active: number; lockWaiters: number }>(
            `SELECT count(*)::integer AS total, count(*) FILTER (WHERE state='active')::integer AS active, count(*) FILTER (WHERE wait_event_type='Lock')::integer AS "lockWaiters" FROM pg_stat_activity WHERE usename=$1`,
            [runtimeRole],
          );
          samples.push({ elapsedMs: performance.now() - start, services: await metrics(), database: database.rows[0] });
        }
      }
      const writingMs = performance.now() - start;
      diagnostics.writingMs = writingMs;
      const deadline = performance.now() + 30000;
      while (arrivals.size < commits.size && performance.now() < deadline) await setTimeout(100);
      assert.equal(arrivals.size, commits.size, "Every distinct-project write must become visible");
      const timings = [...commits].map(([sequence, commit]) => {
        const observed = arrivals.get(sequence);
        assert(observed !== undefined);
        return {
          lowerMs: Math.max(0, observed - commit.acknowledged),
          upperMs: Math.max(0, observed - commit.started),
        };
      });
      diagnostics.timings = timings;
      stage = "cleanup counters";
      await page.evaluate(() => window.loomLive.stopSubscriptions());
      const cleanupDeadline = performance.now() + 30000;
      let final = await metrics();
      while (
        final.some(
          (sample) => sample.subscriptions || sample.evaluating || sample.queued || sample.listener !== "idle",
        ) &&
        performance.now() < cleanupDeadline
      ) {
        await setTimeout(250);
        final = await metrics();
      }
      assert(
        final.every(
          (sample) =>
            sample.subscriptions === 0 && sample.evaluating === 0 && sample.queued === 0 && sample.listener === "idle",
        ),
      );
      assert(final.every((sample) => sample.peakEvaluating <= 4 && sample.peakQueued <= 50));
      diagnostics.final = final;
      assert(final.every((sample) => sample.pool.total <= 4 && sample.pool.waiting === 0));
      assert.equal((await listeners()).rows.length, 0);
      assert.equal((await page.evaluate(() => window.loomLive.status())).errors, 0);
      const idlePool = await admin.query<{ total: number; active: number; idleTransactions: number }>(
        `SELECT count(*)::integer AS total, count(*) FILTER (WHERE state='active')::integer AS active, count(*) FILTER (WHERE state LIKE 'idle in transaction%')::integer AS "idleTransactions" FROM pg_stat_activity WHERE usename=$1 AND application_name='loom-live-load'`,
        [runtimeRole],
      );
      assert(idlePool.rows[0]);
      diagnostics.idlePool = idlePool.rows[0];
      assert.equal(idlePool.rows[0]?.active, 0);
      assert.equal(idlePool.rows[0]?.idleTransactions, 0);
      assert((idlePool.rows[0]?.total ?? Infinity) <= 8, "Two runtime pools must stay within their four-client bounds");
      const budget = await admin.query<{ maximum: string; connections: string }>(
        "SELECT current_setting('max_connections') AS maximum,(SELECT count(*)::text FROM pg_stat_activity) AS connections",
      );
      if (process.env.LOOM_CLOUD_RECEIPT)
        await writeFile(
          process.env.LOOM_CLOUD_RECEIPT,
          JSON.stringify(
            {
              projectId,
              branchId,
              region: process.env.LOOM_CLOUD_REGION,
              version: generated.version,
              mode,
              workload,
              seconds,
              warmupSeconds,
              writingMs,
              finiteMs,
              finiteRuntime,
              subscriptions: 100,
              services,
              initial,
              samples,
              writerWaitSamples,
              final,
              timings,
              budget: budget.rows[0],
              idlePool: idlePool.rows[0],
              fullWorkload: seconds === 600 && warmupSeconds >= 30,
              passed: true,
              completedAt: new Date().toISOString(),
            },
            null,
            2,
          ),
        );
    } catch (cause) {
      diagnostics.browser = await browserStatus().catch(() => ({ unavailable: true }));
      if (process.env.LOOM_CLOUD_RECEIPT)
        await writeFile(
          process.env.LOOM_CLOUD_RECEIPT,
          JSON.stringify(
            {
              projectId,
              branchId,
              stage,
              diagnostics,
              passed: false,
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
      throw new Error(
        `Hosted native live acceptance failed during ${stage}; provider resources remain on the owned branch for diagnosis`,
      );
    } finally {
      await browser.close();
      await frontend.stop(true);
      await admin.end();
      await writers.end();
      await rm(root, { recursive: true, force: true });
    }
  },
  1000000,
);
