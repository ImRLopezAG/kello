import assert from "node:assert/strict";
import { test } from "bun:test";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import * as v from "valibot";
import { createKelloNeonApi } from "kello-cli";

test.skipIf(!process.env.LOOM_CLOUD_COMPONENT_SOURCE_RECEIPT)(
  "schema-only Neon branch adopts all component histories without data or work",
  async () => {
    const source = v.parse(
      v.object({ passed: v.literal(true), projectId: v.string(), branchId: v.string(), fixtureRoot: v.string() }),
      JSON.parse(await readFile(process.env.LOOM_CLOUD_COMPONENT_SOURCE_RECEIPT!, "utf8")),
    );
    const tooling: typeof import("kello-cli") = await import(
      join(source.fixtureRoot, "node_modules/kello-cli/dist/tooling/index.js")
    );
    const api = createKelloNeonApi();
    const parent = (await api.listBranches(source.projectId)).find((branch) => branch.id === source.branchId);
    assert(parent && !parent.isDefault && !parent.protected && parent.name.startsWith("loom-acceptance-"));
    const name = `loom-acceptance-component-schema-${Date.now()}`;
    const declaration = {
      format: 1,
      key: createHash("sha256").update(name).digest("hex"),
      projectId: source.projectId,
      parentBranchId: source.branchId,
      branchName: name,
      environment: "development",
      initSource: "schema-only",
    };
    await writeFile(join(source.fixtureRoot, "schema-branch.json"), JSON.stringify(declaration));
    const cli = createRequire(import.meta.resolve("kello-cli")).resolve("neon/dist/index.js");
    async function neon(args: string[]) {
      const child = Bun.spawn(["node", cli, ...args, "--project-id", source.projectId], {
        stdout: "pipe",
        stderr: "pipe",
        timeout: 90000,
      });
      const [output, , code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      assert.equal(code, 0, "Neon acceptance operation failed");
      return output.trim();
    }
    let branchId: string | undefined;
    let passed = false;
    const checks: string[] = [];
    const cleanupFailures: string[] = [];
    let connection: pg.Client | undefined;
    try {
      const receipt = await tooling.provisionProjectBranch(
        source.fixtureRoot,
        "schema-branch.json",
        undefined,
        AbortSignal.timeout(180000),
      );
      assert.equal(receipt.state, "complete");
      assert("branchId" in receipt);
      branchId = receipt.branchId;
      assert.notEqual(branchId, source.branchId);
      assert.deepEqual(await tooling.provisionProjectBranch(source.fixtureRoot, "schema-branch.json"), receipt);
      checks.push("public-provisioning-idempotent");
      const connectionString = await neon([
        "connection-string",
        branchId,
        "--role-name",
        "neondb_owner",
        "--ssl",
        "verify-full",
      ]);
      connection = new pg.Client({ connectionString });
      await connection.connect();
      const namespaces = await connection.query<{ mount_path: string; namespace: string }>(
        "SELECT mount_path,namespace FROM loom_meta.component_namespaces ORDER BY mount_path",
      );
      assert.deepEqual(
        namespaces.rows.map((row) => row.mount_path),
        ["left", "right"],
      );
      for (const row of namespaces.rows) {
        assert.match(row.namespace, /^[a-z0-9_]+$/);
        assert.equal(
          (await connection.query(`SELECT count(*)::int AS count FROM "${row.namespace}".entries`)).rows[0].count,
          0,
        );
        const status = await tooling.migrationStatus({
          root: source.fixtureRoot,
          connectionString,
          namespace: row.namespace,
          metadataNamespace: "loom_meta",
          migrations: `kello/_generated/migrations/components/${row.namespace}`,
        });
        assert(status.consistent && status.pending.length === 0);
      }
      checks.push("component-ownership-adopted", "component-data-empty", "all-component-histories-consistent");
      for (const table of [
        "jobs",
        "storage_intents",
        "deployment_activations",
        "deployment_secrets",
        "search_cursor_keys",
        "mutation_results",
        "runtime_scopes",
      ]) {
        assert.equal(
          (await connection.query(`SELECT count(*)::int AS count FROM loom_meta.${table}`)).rows[0].count,
          0,
        );
      }
      checks.push("runtime-work-and-secrets-not-inherited");
      passed = true;
    } finally {
      try {
        await connection?.end();
      } catch {
        cleanupFailures.push("connection");
      }
      // Recover a created branch even if schema adoption failed before returning its receipt.
      try {
        const children = (await api.listBranches(source.projectId)).filter((branch) => branch.name === name);
        for (const branch of children) {
          assert(!branch.isDefault && !branch.protected && branch.id !== source.branchId);
          branchId ??= branch.id;
          await neon(["branches", "delete", branch.id, "--output", "json"]);
        }
      } catch {
        cleanupFailures.push("branch");
      }
      if (process.env.LOOM_CLOUD_SCHEMA_RECEIPT)
        await writeFile(
          process.env.LOOM_CLOUD_SCHEMA_RECEIPT,
          JSON.stringify(
            {
              projectId: source.projectId,
              parentBranchId: source.branchId,
              branchId,
              passed,
              checks,
              cleanup: cleanupFailures.length === 0,
              cleanupFailures,
            },
            null,
            2,
          ),
        );
      assert.deepEqual(cleanupFailures, []);
    }
  },
  300000,
);
