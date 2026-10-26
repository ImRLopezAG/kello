import assert from "node:assert/strict";
import { test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pg from "pg";
import * as v from "valibot";
import { createKelloNeonApi, defineConfig, inspectDeploymentTarget } from "kello-cli";
import { prepareCloudSearch } from "../fixtures/cloud-search";
import { createCloudIssuer } from "../fixtures/cloud-issuer";
import { deployLiveServices } from "../fixtures/cloud-live-services";
import type { JsonValue } from "kello/server";
import { measureSearchPerformance } from "../fixtures/search-performance";

const row = v.strictObject({ title: v.string(), labels: v.array(v.strictObject({ name: v.string() })) });
const finiteSchema = v.strictObject({
  rows: v.array(row),
  nextCursor: v.nullable(v.string()),
  previousCursor: v.nullable(v.string()),
  count: v.string(),
});
test.skipIf(process.env.LOOM_CLOUD_SEARCH !== "1")(
  "packed search works on two hosted Neon Functions",
  async () => {
    const projectId = process.env.KELLO_CLOUD_PROJECT_ID;
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
    const frontend = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return new Response("Finite hosted search acceptance");
      },
    });
    const original = {
      database: process.env.LOOM_DATABASE_URL,
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
      const tooling: typeof import("kello-cli") = await import(
        join(root, "node_modules/kello-cli/dist/tooling/index.js")
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
        `import { defineConfig } from "kello-cli"; export default defineConfig(${JSON.stringify({
          project: "search",
          openapi: true,
          database: { namespace, metadataNamespace },
          provider: { projectId, targets: { preview: { branchId } } },
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
      stage = "finite permission and SQL policy revocation";
      for (const service of services) {
        const allowed = await request(service.url, "policyList", input);
        assert.equal(allowed.status, 200);
        assert.equal(v.parse(finiteSchema, await allowed.json()).count, "5");
      }
      await admin.query(`UPDATE "${namespace}".declared_policy_permissions SET allowed=false WHERE subject='alice'`);
      for (const service of services) {
        const denied = await request(service.url, "policyList", input);
        assert.equal(denied.status, 200);
        const result = v.parse(finiteSchema, await denied.json());
        assert.deepEqual(result.rows, []);
        assert.equal(result.count, "0");
        assert.equal((await page(service.url, input)).count, "5");
      }
      await admin.query(`UPDATE "${namespace}".permissions SET allowed=false WHERE subject='alice'`);
      for (const service of services) assert.equal((await request(service.url, "list", input)).status, 403);
      await admin.query(`UPDATE "${namespace}".permissions SET allowed=true WHERE subject='alice'`);
      checks.push("finite-SQL-policy-revocation", "finite-authorization-revocation-both-replicas");
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
