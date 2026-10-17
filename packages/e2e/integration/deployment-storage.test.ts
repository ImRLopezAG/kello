import { initializeProject } from "kello/tooling";
import assert from "node:assert/strict";
import { test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, symlink, realpath, readFile, writeFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";
import { unzipSync } from "fflate";
import { buildNeonFunctionBundle } from "kello/tooling";
import { generateProject, prepareNeonEntrypoints, bootstrapDatabase } from "kello/tooling";

const connectionString = process.env.LOOM_TEST_DATABASE_URL;
test.skipIf(!connectionString)(
  "packed Neon storage entries boot with injected credentials and reject absent or mismatched storage",
  async () => {
    if (!connectionString) throw new Error("Missing database");
    const root = await mkdtemp(join(tmpdir(), "loom-storage-deployment-"));
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const metadataNamespace = `loom_${suffix}`;
    const runtimeRole = `runtime_${suffix}`;
    const admin = new pg.Client({ connectionString });
    await admin.connect();
    try {
      await initializeProject(root, "storage");
      await mkdir(join(root, "node_modules/@kello"), { recursive: true });
      for (const name of ["kello", "valibot", "drizzle-orm"]) {
        await symlink(
          await realpath(fileURLToPath(new URL(`../../tests/node_modules/${name}`, import.meta.url))),
          join(root, "node_modules", name),
        );
      }
      await writeFile(
        join(root, "kello.config.ts"),
        `import { defineConfig } from "kello/tooling"; export default defineConfig({ project: "storage", database: { metadataNamespace: ${JSON.stringify(metadataNamespace)} } });`,
      );
      await writeFile(
        join(root, "kello/storage.ts"),
        'import { defineProcedureStorage } from "kello/server"; export default defineProcedureStorage({ buckets: { uploads: {} } });',
      );
      const generated = await generateProject(root);
      await bootstrapDatabase({ connectionString, metadataNamespace, runtimeRole });
      await admin.query(`ALTER ROLE "${runtimeRole}" LOGIN PASSWORD 'loom-test-only'`);
      const runtime = new URL(connectionString);
      runtime.username = runtimeRole;
      runtime.password = "loom-test-only";
      const token = "c".repeat(64);
      const binding = {
        metadataNamespace,
        deployment: "preview",
        version: generated.version,
        projectId: "project",
        branchId: "br-preview",
        branchName: "preview",
        endpointHost: runtime.hostname,
        databaseName: decodeURIComponent(runtime.pathname.slice(1)),
      };
      await admin.query(
        `INSERT INTO "${metadataNamespace}".deployment_activations (deployment,version,project_id,branch_id,endpoint_host,database_name,token_hash,state) VALUES ($1,$2,$3,$4,$5,$6,$7,'active')`,
        [
          binding.deployment,
          binding.version,
          binding.projectId,
          binding.branchId,
          binding.endpointHost,
          binding.databaseName,
          createHash("sha256").update(token).digest("hex"),
        ],
      );
      const entries = await prepareNeonEntrypoints(root, binding, {});
      await rm(join(root, ".loom/generations"), { recursive: true });
      await admin.query(
        `INSERT INTO "${metadataNamespace}".deployment_trigger_bindings
          (deployment,version,project_id,branch_id,bindings) VALUES ($1,$2,$3,$4,'{}'::jsonb)`,
        [binding.deployment, binding.version, binding.projectId, binding.branchId],
      );
      await admin.query(`INSERT INTO "${metadataNamespace}".jobs
        (id, deployment, deduplication_key, fingerprint, call, identity, due_at, max_attempts, retry_delay_seconds)
        VALUES (uuidv7(), 'preview', 'probe-must-not-run', repeat('a', 64), '{}'::jsonb, 'null'::jsonb, clock_timestamp(), 2, 1)`);
      for (const name of ["service", "worker"] as const) {
        const source = entries[name];
        assert.match(await readFile(source, "utf8"), /storageBackend: createNeonStorageBackend/);
        const archive = await buildNeonFunctionBundle(source);
        const directory = join(root, `packed-${name}`);
        for (const [filename, contents] of Object.entries(unzipSync(archive))) {
          const destination = join(directory, filename);
          await mkdir(dirname(destination), { recursive: true });
          await writeFile(destination, contents);
        }
        const packed = join(directory, "index.mjs");
        assert.ok(!(await readFile(packed, "utf8")).includes("fixture-injected-secret"));
        for (const [endpoint, state, expected, healthStatus] of [
          ["https://br-preview.storage.c-1.us-east-2.aws.neon.tech", "active", 404, 200],
          ["https://br-other.storage.c-1.us-east-2.aws.neon.tech", "active", 503, 503],
          ["", "active", 503, 503],
          ["https://br-preview.storage.c-1.us-east-2.aws.neon.tech", "quarantined", 503, 200],
          ["https://br-other.storage.c-1.us-east-2.aws.neon.tech", "quarantined", 503, 503],
          ["", "quarantined", 503, 503],
        ] as const) {
          await admin.query(`UPDATE "${metadataNamespace}".deployment_activations SET state = $1`, [state]);
          const execution = Bun.spawn(
            [
              "node",
              "--input-type=module",
              "-e",
              `
          import assert from "node:assert/strict";
          import entry from ${JSON.stringify(pathToFileURL(packed).href)};
          const health = () => new Request("https://app.test/_loom/deployment/health", {
            method: "POST", headers: { authorization: "Bearer " + process.env.LOOM_ACTIVATION_TOKEN }
          });
          assert.equal((await entry.fetch(new Request(health().url, { method: "POST" }))).status, 404);
          const probe = await entry.fetch(health());
          assert.equal(probe.status, ${healthStatus});
          if (probe.status === 200) {
            assert.deepEqual(await probe.json(), { format: 1, databaseDrainProtocol: 1, version: ${JSON.stringify(binding.version)}, artifactHash: ${JSON.stringify(entries.hash)}, role: ${JSON.stringify(name)} });
            process.env.NEON_BRANCH = "wrong-branch";
            assert.equal((await entry.fetch(health())).status, 503);
            process.env.NEON_BRANCH = "preview";
            const originalToken = process.env.LOOM_ACTIVATION_TOKEN;
            process.env.LOOM_ACTIVATION_TOKEN = "d".repeat(64);
            assert.equal((await entry.fetch(health())).status, 503);
            process.env.LOOM_ACTIVATION_TOKEN = originalToken;
          } else assert.equal(await probe.text(), "Service unavailable");
          const response = await entry.fetch(new Request("https://app.test/not-a-route"));
          assert.equal(response.status, ${expected});
          if (response.status === 503) assert.equal(await response.text(), "Service unavailable");
          await entry.stop();
        `,
            ],
            {
              cwd: directory,
              stdout: "pipe",
              stderr: "pipe",
              env: {
                ...process.env,
                LOOM_DATABASE_URL: runtime.href,
                DATABASE_URL: runtime.href,
                NEON_BRANCH: "preview",
                LOOM_ACTIVATION_TOKEN: token,
                AWS_ACCESS_KEY_ID: "fixture-injected-access",
                AWS_SECRET_ACCESS_KEY: "fixture-injected-secret",
                AWS_ENDPOINT_URL_S3: endpoint,
                AWS_REGION: "us-east-2",
              },
            },
          );
          assert.equal(await new Response(execution.stderr).text(), "");
          assert.equal(await execution.exited, 0);
          assert.equal(
            (await admin.query(`SELECT state FROM "${metadataNamespace}".deployment_activations`)).rows[0].state,
            state,
          );
          assert.deepEqual((await admin.query(`SELECT state, attempts FROM "${metadataNamespace}".jobs`)).rows, [
            { state: "pending", attempts: 0 },
          ]);
        }
      }
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS "${metadataNamespace}" CASCADE`);
      await admin.query(`DROP ROLE IF EXISTS "${runtimeRole}"`);
      await admin.end();
      await rm(root, { recursive: true, force: true });
    }
  },
  30000,
);
