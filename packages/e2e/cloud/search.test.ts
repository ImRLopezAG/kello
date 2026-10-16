import assert from "node:assert/strict";
import { test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pg from "pg";
import * as v from "valibot";
import { createKelloNeonApi, defineConfig, inspectDeploymentTarget } from "kello/tooling";
import { prepareCloudSearch } from "../fixtures/cloud-search";
import { createCloudIssuer } from "../fixtures/cloud-issuer";
import { deployLiveServices } from "../fixtures/cloud-live-services";
import { chromium } from "playwright";
import type { Browser } from "playwright";
import type { JsonValue } from "kello/server";
import { measureSearchPerformance } from "../fixtures/search-performance";

const row = v.strictObject({ title: v.string(), labels: v.array(v.strictObject({ name: v.string() })) });
const windowSchema = v.strictObject({
  pages: v.array(v.array(row)),
  nextCursor: v.nullable(v.string()),
  previousCursor: v.nullable(v.string()),
  count: v.string(),
});
const finiteSchema = v.strictObject({
  rows: v.array(row),
  nextCursor: v.nullable(v.string()),
  previousCursor: v.nullable(v.string()),
  count: v.string(),
});
const natural = v.pipe(v.number(), v.integer(), v.minValue(0));
const metricsSchema = v.strictObject({
  instance: v.pipe(v.string(), v.uuid()),
  completedPolls: natural,
  subscriptions: natural,
  evaluating: natural,
  queued: natural,
  evaluations: v.strictObject({ watch: natural, broadWatch: natural, policyWatch: natural }),
});
type SearchMetrics = v.InferOutput<typeof metricsSchema>;
const watchNames = ["watch", "broadWatch", "policyWatch"] as const;
type WatchName = (typeof watchNames)[number];
type LiveValues = Record<WatchName, JsonValue>;
function equivalentWindow(parsed: v.InferOutput<typeof windowSchema>, expected: v.InferOutput<typeof windowSchema>) {
  assert.deepEqual(parsed.pages, expected.pages);
  assert.equal(parsed.count, expected.count);
  // Each native procedure has its own cursor binding and issuance time.
  assert.equal(parsed.nextCursor === null, expected.nextCursor === null);
  assert.equal(parsed.previousCursor === null, expected.previousCursor === null);
}
// Browser messages are parsed at the test boundary; packed generation checks exact client types.
declare global {
  interface Window {
    loomSearch: {
      start(urls: string[], token: string, input: Readonly<Record<string, JsonValue>>): Promise<LiveValues[]>;
      next(names?: WatchName[]): Promise<Partial<LiveValues>[]>;
      metrics(): Promise<SearchMetrics[]>;
      barrier(markers: SearchMetrics[]): Promise<SearchMetrics[]>;
      deliveries(): Record<WatchName, number>[];
      errors(): Promise<Record<WatchName, string>[]>;
      stop(): Promise<void>;
    };
  }
}

async function bounded<Value>(promise: Promise<Value>): Promise<Value> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Hosted search event timeout")), 25000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test.skipIf(process.env.LOOM_CLOUD_SEARCH !== "1")(
  "packed search works on two hosted Neon Functions",
  async () => {
    const projectId = process.env.LOOM_CLOUD_PROJECT_ID;
    const branchId = process.env.LOOM_CLOUD_BRANCH_ID;
    const connectionString = process.env.LOOM_MIGRATION_DATABASE_URL;
    const runtimeRole = process.env.LOOM_CLOUD_RUNTIME_ROLE;
    assert(projectId && branchId && connectionString && runtimeRole);
    assert.match(runtimeRole, /^runtime_[a-f0-9]{32}$/);
    const target = await inspectDeploymentTarget(
      defineConfig({ provider: { projectId, targets: { preview: { branchId } } } }),
      "preview",
    );
    assert(!target.protected && target.branchName.startsWith("loom-acceptance-"));
    const address = new URL(connectionString);
    assert.equal(address.hostname.split(".")[0], target.endpointId);
    const root = await mkdtemp(join(tmpdir(), "loom-cloud-search-"));
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const namespace = `search_${suffix}`;
    const metadataNamespace = `loom_meta_${suffix}`;
    const admin = new pg.Client({ connectionString, connectionTimeoutMillis: 15000 });
    const provider = createKelloNeonApi();
    const ownedSlugs = new Set<string>();
    let browser: Browser | undefined;
    let bundle = "";
    const frontend = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        return new URL(request.url).pathname === "/client.js"
          ? new Response(bundle, { headers: { "content-type": "text/javascript" } })
          : new Response('<html><body><script type="module" src="/client.js"></script></body></html>', {
              headers: { "content-type": "text/html" },
            });
      },
    });
    const original = {
      database: process.env.LOOM_DATABASE_URL,
      direct: process.env.LOOM_DIRECT_DATABASE_URL,
      activation: process.env.LOOM_ACTIVATION_TOKEN,
    };
    const checks: string[] = [];
    const timings: { operation: string; ms: number }[] = [];
    let stage = "prepare";
    let connected = false;
    let ownsRuntimeRole = false;
    let passed = false;
    try {
      await prepareCloudSearch(root, namespace);
      const tooling: typeof import("kello/tooling") = await import(
        join(root, "node_modules/kello/dist/tooling/index.js")
      );
      await admin.connect();
      connected = true;
      assert.equal(
        (await admin.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [runtimeRole])).rowCount,
        0,
        "Search acceptance requires a fresh runtime role",
      );
      const reservedSlugs = [
        "loomissuer",
        "loomsearchservice",
        "loomsearchworker",
        "loomlivea",
        "loomliveb",
        "loomrotated",
        "loommissingkey",
      ];
      const existing = await provider.listBranchFunctions(projectId, branchId);
      assert(
        !existing.some((fn) => reservedSlugs.includes(fn.slug)),
        "Search acceptance requires unused Function slugs",
      );
      for (const slug of reservedSlugs) ownedSlugs.add(slug);
      stage = "issuer";
      const issuer = await createCloudIssuer(root, projectId, branchId);
      const origin = frontend.url.origin;
      await writeFile(
        join(root, "kello.config.ts"),
        `import { defineConfig } from "kello/tooling"; export default defineConfig(${JSON.stringify({
          project: "search",
          openapi: true,
          database: { namespace, metadataNamespace },
          provider: { projectId, targets: { preview: { branchId } } },
          realtime: { pollIntervalMs: 1000, maxSubscriptions: 20 },
          auth: {
            origins: [origin],
            audience: "loom-acceptance",
            issuers: [{ issuer: issuer.issuer, jwksUrl: issuer.jwksUrl }],
          },
          deployment: {
            slugs: { service: "loomsearchservice", worker: "loomsearchworker" },
            environment: "preview",
            deployment: "preview",
            databaseName: decodeURIComponent(address.pathname.slice(1)),
            migrationRole: decodeURIComponent(address.username),
            runtimeRole,
            quarantine: "preserve",
          },
        })});`,
      );
      stage = "normal generated migrations";
      await tooling.generateRelease(root, "initial");
      const project = await tooling.loadProject(root);
      ownsRuntimeRole = true;
      await tooling.applyMigrations({
        root,
        connectionString,
        runtimeRole,
        namespace,
        metadataNamespace,
        migrations: project.config.database.migrations,
      });
      const password = crypto.randomUUID();
      await admin.query(`ALTER ROLE "${runtimeRole}" LOGIN PASSWORD '${password}'`);
      address.username = runtimeRole;
      address.password = password;
      process.env.LOOM_DATABASE_URL = address.href;
      process.env.LOOM_DIRECT_DATABASE_URL = address.href;
      process.env.LOOM_ACTIVATION_TOKEN = crypto.randomUUID().replaceAll("-", "").repeat(2);
      stage = "normal release deployment";
      const generated = await tooling.generateProject(root);
      const release = await tooling.deployProjectRelease(
        root,
        "kello.config.ts",
        provider,
        AbortSignal.timeout(240000),
      );
      const functions = release.completed.find((entry) => entry.stage === "functions");
      assert(functions);
      const receipt = await tooling.readNeonFunctionReceipt(root, functions.artifactHash);
      for (const fn of receipt.functions) ownedSlugs.add(fn.slug);
      const key = (
        await admin.query<{ key: string }>(
          `SELECT key FROM "${metadataNamespace}".search_cursor_keys WHERE project_id=$1 AND branch_id=$2`,
          [projectId, branchId],
        )
      ).rows[0]?.key;
      assert(key);
      stage = "two service deployments";
      const services = await deployLiveServices({
        root,
        artifactHash: functions.artifactHash,
        projectId,
        branchId,
        provider,
        environment: {
          LOOM_DATABASE_URL: address.href,
          LOOM_DIRECT_DATABASE_URL: address.href,
          LOOM_ACTIVATION_TOKEN: process.env.LOOM_ACTIVATION_TOKEN,
          LOOM_SEARCH_CURSOR_KEY: key,
        },
      });
      assert.equal(new Set(services.map((service) => service.functionId)).size, 2);
      if (process.env.LOOM_CLOUD_SEARCH_TEST_FAILURE === "after-deploy")
        throw new Error("Injected acceptance failure for teardown verification");
      const a = services[0],
        b = services[1];
      assert(a && b);
      stage = "seed relational oracle";
      await admin.query(`INSERT INTO "${namespace}".permissions(subject,allowed) VALUES ('alice',true),('bob',true)`);
      await admin.query(
        `INSERT INTO "${namespace}".declared_policy_permissions(subject,allowed) VALUES ('alice',true),('bob',true)`,
      );
      await admin.query(`INSERT INTO "${namespace}".unrelated(title) VALUES ('before')`);
      const organization = (
        await admin.query<{ _id: string }>(
          `INSERT INTO "${namespace}".organizations(name) VALUES ('organization') RETURNING _id`,
        )
      ).rows[0];
      assert(organization);
      const projectRow = (
        await admin.query<{ _id: string }>(
          `INSERT INTO "${namespace}".projects(name,organization_id) VALUES ('project',$1) RETURNING _id`,
          [organization._id],
        )
      ).rows[0];
      assert(projectRow);
      const team = (
        await admin.query<{ _id: string }>(
          `INSERT INTO "${namespace}".teams(name,organization_id) VALUES ('team',$1) RETURNING _id`,
          [organization._id],
        )
      ).rows[0];
      assert(team);
      await admin.query(`INSERT INTO "${namespace}".members(name,team_id) VALUES ('member',$1)`, [team._id]);
      await admin.query(
        `INSERT INTO "${namespace}".tasks(owner,title,done,project_id,at,count,amount) SELECT 'alice',title,false,$1,'2026-01-01',9007199254740993,'1.0001' FROM unnest($2::text[]) title`,
        [projectRow._id, ["A", "B", "C", "D", "E"]],
      );
      await admin.query(
        `INSERT INTO "${namespace}".tasks(owner,title,done,at,count,amount) VALUES ('bob','private',false,'2026-01-01',1,'1')`,
      );
      const task = (await admin.query<{ _id: string }>(`SELECT _id FROM "${namespace}".tasks WHERE title='A'`)).rows[0];
      assert(task);
      const label = (
        await admin.query<{ _id: string }>(`INSERT INTO "${namespace}".labels(name) VALUES ('old') RETURNING _id`)
      ).rows[0];
      assert(label);
      await admin.query(`INSERT INTO "${namespace}".task_labels(task_id,label_id) VALUES($1,$2)`, [
        task._id,
        label._id,
      ]);
      await admin.query(`CREATE INDEX ON "${namespace}".tasks(owner,title,_id)`);
      const explain = (
        await admin.query(
          `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT title FROM "${namespace}".tasks WHERE owner='alice' ORDER BY title,_id LIMIT 3`,
        )
      ).rows;
      const alice = await issuer.token("alice", "loom-acceptance", "30m");
      const bob = await issuer.token("bob", "loom-acceptance", "30m");
      const input = {
        columns: { title: true },
        with: { labels: { columns: { name: true } } },
        orderBy: [{ field: "title", direction: "asc" }],
        limit: 2,
        count: true,
      };
      async function request(service: string, name: string, body: Readonly<Record<string, JsonValue>>, token = alice) {
        const started = performance.now();
        const response = await fetch(new URL(`/api/kello/openapi/tasks/${name}`, service), {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            origin,
            "content-type": "application/json",
            "x-loom-protocol": "loom-orpc-2",
            "x-loom-version": generated.version,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(25000),
        });
        timings.push({ operation: name, ms: performance.now() - started });
        return response;
      }
      async function page(service: string, body: Readonly<Record<string, JsonValue>>, token = alice) {
        const response = await request(service, "list", body, token);
        assert.equal(response.status, 200, "Finite HTTP refused");
        return v.parse(finiteSchema, await response.json());
      }
      stage = "HTTP finite cross-replica cursors";
      const first = await page(a.url, input);
      assert.deepEqual(first.rows, [
        { title: "A", labels: [{ name: "old" }] },
        { title: "B", labels: [] },
      ]);
      assert.equal(first.count, "5");
      assert(first.nextCursor);
      const second = await page(b.url, { ...input, cursor: first.nextCursor });
      assert.deepEqual(
        second.rows.map((row) => row.title),
        ["C", "D"],
      );
      const back = await page(a.url, { ...input, cursor: second.previousCursor, direction: "backward" });
      assert.deepEqual(back.rows, first.rows);
      assert.equal((await page(b.url, input, bob)).count, "1");
      assert.equal((await request(b.url, "list", { ...input, cursor: first.nextCursor }, bob)).status, 400);
      checks.push("HTTP-M2M-oracle", "cold-replica-cursor", "backward-page", "identity-cursor-isolation");
      stage = "four relation edges and output enforcement";
      const deep = await request(a.url, "list", {
        columns: { title: true },
        with: {
          project: {
            columns: { name: true },
            with: {
              organization: {
                columns: { name: true },
                with: { teams: { columns: { name: true }, with: { members: { columns: { name: true } } } } },
              },
            },
          },
        },
        limit: 1,
      });
      assert.equal(deep.status, 200);
      assert.deepEqual((await deep.json()).rows, [
        {
          title: "A",
          project: {
            name: "project",
            organization: { name: "organization", teams: [{ name: "team", members: [{ name: "member" }] }] },
          },
        },
      ]);
      assert.equal((await request(a.url, "effectList", input)).status, 200);
      assert.equal((await request(a.url, "bad", input)).status, 500);
      await admin.query(`INSERT INTO "${namespace}".labels(name) VALUES ('two')`);
      await admin.query(
        `INSERT INTO "${namespace}".task_labels(task_id,label_id) SELECT $1,_id FROM "${namespace}".labels WHERE name='two'`,
        [task._id],
      );
      const budget = await request(a.url, "rows", input);
      assert.equal(budget.status, 400);
      assert.equal((await budget.json()).code, "QUERY_BUDGET_EXCEEDED");
      await admin.query(`UPDATE "${namespace}".tasks SET title=$1 WHERE title='E'`, ["Z".repeat(256)]);
      const bytes = await request(a.url, "bytes", {
        columns: { title: true },
        where: { title: { eq: "Z".repeat(256) } },
        limit: 1,
      });
      assert.equal(bytes.status, 400);
      assert.equal((await bytes.json()).code, "QUERY_BUDGET_EXCEEDED");
      checks.push(
        "four-edge-projection",
        "Effect-search-service",
        "malformed-output-rejected",
        "nested-row-budget",
        "encoded-result-budget",
      );
      stage = "native generated live clients";
      const entry = join(root, "browser.ts");
      await writeFile(
        entry,
        `import { createClient } from "./kello/_generated/api";
const connections = [], peers = [];
const names = ["watch", "broadWatch", "policyWatch"];
function observe(stream) {
 const values = [], waiters = [], failures = [];
 let deliveries = 0, failure;
 const fail = code => { failure = code; for (const waiter of waiters.splice(0)) waiter.reject(new Error(code)); for (const resolve of failures.splice(0)) resolve(code); };
 void (async () => {
  try { for (;;) { const event = await stream.next(); if (event.done) { fail("STREAM_ENDED"); return; } deliveries++; const waiter = waiters.shift(); if (waiter) waiter.resolve(event.value); else values.push(event.value); } }
  catch (error) { fail(error.code ?? "UNKNOWN"); }
 })();
 return {
  next() { if (values.length) return Promise.resolve(values.shift()); if (failure) return Promise.reject(new Error(failure)); return new Promise((resolve, reject) => waiters.push({ resolve, reject })); },
  error() { if (values.length) return Promise.resolve("UNEXPECTED_VALUE"); if (failure) return Promise.resolve(failure); return new Promise(resolve => failures.push(resolve)); },
  deliveries: () => deliveries,
  stream,
 };
}
window.loomSearch = {
 async start(urls, token, input) {
  for (const url of urls) {
   const connection = createClient({ url, getToken: async () => token }); connections.push(connection);
   const peer = {};
   for (const name of names) peer[name] = observe(await connection.client.tasks[name](input));
   peers.push(peer);
  }
  return this.next();
 },
 async next(selected = names) { return Promise.all(peers.map(async peer => Object.fromEntries(await Promise.all(selected.map(async name => [name, await peer[name].next()]))))); },
 async metrics() { return Promise.all(connections.map(connection => connection.client.tasks.metrics())); },
 async barrier(markers) { return Promise.all(connections.map((connection, index) => connection.client.tasks.barrier({ instance: markers[index].instance, after: markers[index].completedPolls, expectedSubscriptions: 3 }))); },
 deliveries() { return peers.map(peer => Object.fromEntries(names.map(name => [name, peer[name].deliveries()]))); },
 async errors() { return Promise.all(peers.map(async peer => Object.fromEntries(await Promise.all(names.map(async name => [name, await peer[name].error()]))))); },
 async stop() { for (const connection of connections) connection.dispose(); await Promise.allSettled(peers.flatMap(peer => names.map(async name => { await peer[name].stream.return?.(); }))); }
};`,
      );
      const build = await Bun.build({ entrypoints: [entry], target: "browser", format: "esm" });
      assert(build.success, "Generated browser search build failed");
      bundle = await build.outputs[0]!.text();
      browser = await chromium.launch({ headless: true });
      const browserPage = await browser.newPage();
      await browserPage.goto(frontend.url.href);
      await browserPage.waitForFunction(() => Boolean(window.loomSearch));
      const initial = await bounded(
        browserPage.evaluate(({ urls, token, input }) => window.loomSearch.start(urls, token, input), {
          urls: services.map((service) => service.url),
          token: alice,
          input: { ...input, loadedPages: 2 },
        }),
      );
      async function windows() {
        return (await bounded(browserPage.evaluate(() => window.loomSearch.next()))).map((values) => {
          const watch = v.parse(windowSchema, values.watch);
          equivalentWindow(v.parse(windowSchema, values.broadWatch), watch);
          equivalentWindow(v.parse(windowSchema, values.policyWatch), watch);
          return watch;
        });
      }
      let current = initial.map((values) => {
        const watch = v.parse(windowSchema, values.watch);
        equivalentWindow(v.parse(windowSchema, values.broadWatch), watch);
        equivalentWindow(v.parse(windowSchema, values.policyWatch), watch);
        return watch;
      });
      for (const value of current)
        assert.deepEqual(
          value.pages.flat().map((row) => row.title),
          ["A", "B", "C", "D"],
        );
      await admin.query(
        `INSERT INTO "${namespace}".tasks(owner,title,done,at,count,amount) VALUES ('alice','AA',false,'2026-01-01',1,'1')`,
      );
      current = await windows();
      for (const value of current) {
        assert.deepEqual(
          value.pages.flat().map((row) => row.title),
          ["A", "AA", "B", "C"],
        );
        assert.equal(value.count, "6");
      }
      await admin.query(`UPDATE "${namespace}".labels SET name='updated' WHERE _id=$1`, [label._id]);
      current = await windows();
      for (const value of current)
        assert.deepEqual(value.pages[0]?.[0]?.labels.map((row) => row.name).sort(), ["two", "updated"]);
      await admin.query(`DELETE FROM "${namespace}".task_labels WHERE task_id=$1`, [task._id]);
      current = await windows();
      for (const value of current) assert.deepEqual(value.pages[0]?.[0]?.labels, []);
      checks.push(
        "two-hosted-websocket-windows",
        "external-root-commit",
        "external-child-commit",
        "external-junction-commit",
      );
      stage = "same-peer selective completed-poll barriers";
      const instances: string[] = [];
      const selectiveEvidence: { check: string; before: SearchMetrics[]; after: SearchMetrics[] }[] = [];
      async function metrics() {
        const values = (await bounded(browserPage.evaluate(() => window.loomSearch.metrics()))).map((value) =>
          v.parse(metricsSchema, value),
        );
        assert.equal(values.length, 2);
        if (!instances.length) {
          instances.push(...values.map((value) => value.instance));
          assert.equal(new Set(instances).size, 2, "Hosted services must use distinct processes");
        }
        values.forEach((value, index) =>
          assert.equal(value.instance, instances[index], "Same RPC peer changed isolate"),
        );
        return values;
      }
      async function completedPolls(markers: SearchMetrics[]) {
        const values = (
          await bounded(browserPage.evaluate((markers) => window.loomSearch.barrier(markers), markers))
        ).map((value) => v.parse(metricsSchema, value));
        assert.equal(values.length, 2);
        values.forEach((value, index) => {
          const marker = markers[index];
          assert(marker);
          assert.equal(value.instance, instances[index], "Barrier changed isolate");
          assert.equal(value.subscriptions, 3);
          assert.equal(value.evaluating, 0);
          assert.equal(value.queued, 0);
          assert(value.completedPolls >= marker.completedPolls + 2, "Post-commit completed ALL-poll barrier");
        });
        return values;
      }
      await completedPolls(await metrics());
      const beforeUnrelated = await metrics();
      const beforeDeliveries = await browserPage.evaluate(() => window.loomSearch.deliveries());
      await admin.query(`UPDATE "${namespace}".unrelated SET title='after'`);
      const afterUnrelated = await completedPolls(await metrics());
      const broadValues = await bounded(browserPage.evaluate(() => window.loomSearch.next(["broadWatch"])));
      const afterDeliveries = await browserPage.evaluate(() => window.loomSearch.deliveries());
      for (let index = 0; index < 2; index++) {
        const before = beforeUnrelated[index],
          after = afterUnrelated[index];
        const deliveriesBefore = beforeDeliveries[index],
          deliveriesAfter = afterDeliveries[index];
        assert(before && after && deliveriesBefore && deliveriesAfter);
        assert.equal(after.evaluations.watch, before.evaluations.watch);
        assert.equal(after.evaluations.policyWatch, before.evaluations.policyWatch);
        assert.equal(after.evaluations.broadWatch, before.evaluations.broadWatch + 1);
        assert.equal(deliveriesAfter.watch, deliveriesBefore.watch);
        assert.equal(deliveriesAfter.policyWatch, deliveriesBefore.policyWatch);
        assert.equal(deliveriesAfter.broadWatch, deliveriesBefore.broadWatch + 1);
        const expected = current[index];
        assert(expected);
        equivalentWindow(v.parse(windowSchema, broadValues[index]?.broadWatch), expected);
      }
      selectiveEvidence.push({
        check: "unrelated-skip-and-broad-rerun",
        before: beforeUnrelated,
        after: afterUnrelated,
      });
      checks.push(
        "same-peer-instance-UUID-both-replicas",
        "completed-ALL-poll-barrier-both-replicas",
        "unrelated-skip-both-replicas",
        "undeclared-control-rerun-both-replicas",
      );
      stage = "declared policy-only subquery dependency";
      const beforePolicy = await metrics();
      const policyDeliveries = await browserPage.evaluate(() => window.loomSearch.deliveries());
      await admin.query(`UPDATE "${namespace}".declared_policy_permissions SET allowed=false WHERE subject='alice'`);
      const afterPolicy = await completedPolls(await metrics());
      const policyValues = await bounded(
        browserPage.evaluate(() => window.loomSearch.next(["broadWatch", "policyWatch"])),
      );
      const afterPolicyDeliveries = await browserPage.evaluate(() => window.loomSearch.deliveries());
      for (let index = 0; index < 2; index++) {
        const before = beforePolicy[index],
          after = afterPolicy[index];
        const deliveriesBefore = policyDeliveries[index],
          deliveriesAfter = afterPolicyDeliveries[index];
        assert(before && after && deliveriesBefore && deliveriesAfter);
        assert.equal(after.evaluations.watch, before.evaluations.watch);
        assert.equal(after.evaluations.policyWatch, before.evaluations.policyWatch + 1);
        assert.equal(after.evaluations.broadWatch, before.evaluations.broadWatch + 1);
        assert.equal(deliveriesAfter.watch, deliveriesBefore.watch);
        assert.equal(deliveriesAfter.policyWatch, deliveriesBefore.policyWatch + 1);
        assert.equal(deliveriesAfter.broadWatch, deliveriesBefore.broadWatch + 1);
        assert.deepEqual(v.parse(windowSchema, policyValues[index]?.policyWatch), {
          pages: [],
          nextCursor: null,
          previousCursor: null,
          count: "0",
        });
        const expected = current[index];
        assert(expected);
        equivalentWindow(v.parse(windowSchema, policyValues[index]?.broadWatch), expected);
      }
      selectiveEvidence.push({ check: "declared-policy-only-rerun", before: beforePolicy, after: afterPolicy });
      checks.push("declared-policy-subquery-only-rerun-both-replicas");
      stage = "same-connection permission-only revocation";
      const beforeRevocation = await metrics();
      const revocationDeliveries = await browserPage.evaluate(() => window.loomSearch.deliveries());
      await admin.query(`UPDATE "${namespace}".permissions SET allowed=false WHERE subject='alice'`);
      const errors = await bounded(browserPage.evaluate(() => window.loomSearch.errors()));
      assert.equal(errors.length, 2);
      for (const error of errors)
        assert.deepEqual(error, { watch: "FORBIDDEN", broadWatch: "FORBIDDEN", policyWatch: "FORBIDDEN" });
      const afterRevocation = await metrics();
      assert.deepEqual(
        await browserPage.evaluate(() => window.loomSearch.deliveries()),
        revocationDeliveries,
        "No unauthorized new publication",
      );
      afterRevocation.forEach((value, index) =>
        assert.deepEqual(
          value.evaluations,
          beforeRevocation[index]?.evaluations,
          "Revocation must fail before authored handlers",
        ),
      );
      selectiveEvidence.push({
        check: "same-connection-permission-revocation",
        before: beforeRevocation,
        after: afterRevocation,
      });
      await browserPage.evaluate(() => window.loomSearch.stop());
      checks.push(
        "authorization-only-revocation-both-replicas",
        "same-connection-revocation-no-unauthorized-event-both-replicas",
      );
      stage = "representative hosted performance";
      const performanceToken = await issuer.token("performance", "loom-acceptance", "30m");
      const performanceEvidence = await measureSearchPerformance({
        admin,
        namespace,
        projectId: projectRow._id,
        request: (input) => request(a.url, "list", input, performanceToken),
      });
      checks.push("2000-roots-24000-junctions-performance");
      stage = "rotated key and missing key startup";
      await admin.query(`UPDATE "${namespace}".permissions SET allowed=true WHERE subject='alice'`);
      const common = { root, artifactHash: functions.artifactHash, projectId, branchId, provider };
      const environment = {
        LOOM_DATABASE_URL: address.href,
        LOOM_DIRECT_DATABASE_URL: address.href,
        LOOM_ACTIVATION_TOKEN: process.env.LOOM_ACTIVATION_TOKEN!,
      };
      const rotated = (
        await deployLiveServices({
          ...common,
          slugs: ["loomrotated"],
          environment: {
            ...environment,
            LOOM_SEARCH_CURSOR_KEY: crypto.randomUUID().replaceAll("-", "").repeat(2),
          },
        })
      )[0];
      assert(rotated);
      const rejected = await request(rotated.url, "list", { ...input, cursor: first.nextCursor });
      assert.equal(rejected.status, 400);
      assert.equal((await rejected.json()).code, "INVALID_CURSOR");
      const missing = (await deployLiveServices({ ...common, slugs: ["loommissingkey"], environment }))[0];
      assert(missing);
      assert.equal((await request(missing.url, "list", input)).status, 503);
      checks.push("hosted-key-rotation-restart", "hosted-missing-key-refuses-startup");
      passed = true;
      await writeFile(
        process.env.LOOM_CLOUD_RECEIPT!,
        JSON.stringify(
          {
            projectId,
            branchId,
            passed,
            version: generated.version,
            artifactHash: functions.artifactHash,
            services,
            checks,
            timings,
            explain,
            performanceEvidence,
            selectiveEvidence,
            namespace,
            metadataNamespace,
          },
          null,
          2,
        ),
      );
    } catch (cause) {
      // Never include connection strings, provider bodies, cursor keys or access tokens in diagnostics.
      const code = v.safeParse(v.object({ code: v.string() }), cause);
      const diagnostic = v.safeParse(
        v.object({
          name: v.optional(v.pipe(v.string(), v.regex(/^[A-Za-z]+$/))),
          details: v.optional(v.object({ status: v.number() })),
        }),
        cause,
      );
      if (diagnostic.success)
        console.info({
          diagnostic: { name: diagnostic.output.name, providerStatus: diagnostic.output.details?.status },
        });
      const health = v.safeParse(
        v.object({
          stage: v.picklist([
            "validate receipt",
            "observe deployments",
            "service health",
            "worker health",
            "confirm deployments",
          ]),
          aborted: v.boolean(),
          status: v.optional(v.number()),
          identityMismatch: v.optional(v.picklist(["version", "artifactHash", "role"])),
        }),
        cause,
      );
      if (health.success) console.info({ health: health.output });
      throw new Error(`Hosted search failed during ${stage}${code.success ? ` (${code.output.code})` : ""}`, {
        cause: cause instanceof assert.AssertionError ? cause : undefined,
      });
    } finally {
      try {
        const cleanup = await Promise.allSettled([
          browser?.close(),
          frontend.stop(true),
          (async () => {
            if (!ownedSlugs.size) return;
            const functions = await provider.listBranchFunctions(projectId, branchId);
            const deleted = await Promise.allSettled(
              functions
                .filter((fn) => ownedSlugs.has(fn.slug))
                .map((fn) => provider.deleteBranchFunction(projectId, branchId, fn.slug)),
            );
            assert(
              deleted.every((result) => result.status === "fulfilled"),
              "Owned Function teardown failed",
            );
          })(),
          (async () => {
            if (!connected || !ownsRuntimeRole) return;
            await admin.query(`ALTER ROLE "${runtimeRole}" NOLOGIN PASSWORD NULL`);
            if (passed)
              await admin.query(
                `DROP SCHEMA IF EXISTS "${namespace}" CASCADE; DROP SCHEMA IF EXISTS "${metadataNamespace}" CASCADE`,
              );
          })(),
        ]);
        assert(
          cleanup.every((result) => result.status === "fulfilled"),
          "Cloud search teardown failed",
        );
        if (passed) await rm(root, { recursive: true, force: true });
      } finally {
        await admin.end();
        for (const [key, value] of Object.entries({
          LOOM_DATABASE_URL: original.database,
          LOOM_DIRECT_DATABASE_URL: original.direct,
          LOOM_ACTIVATION_TOKEN: original.activation,
        })) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        if (!passed) console.info(`Search fixture retained for diagnosis: ${root}`);
      }
    }
  },
  600000,
);
