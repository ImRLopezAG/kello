import assert from "node:assert/strict";
import { test } from "bun:test";
import pg from "pg";
import * as v from "valibot";
import { createRequire } from "node:module";
import { bootstrapDatabase } from "kello/tooling";

const identifier = v.pipe(v.string(), v.regex(/^[a-zA-Z0-9_-]+$/));

/** Keep connection strings and provider diagnostics out of test output. */
async function neon(args: string[]): Promise<string> {
  const cli = createRequire(import.meta.resolve("kello/tooling")).resolve("neon/dist/index.js");
  const child = Bun.spawn(["node", cli, ...args], { stdout: "pipe", stderr: "pipe" });
  const timeout = setTimeout(() => child.kill(), 30000);
  try {
    const [stdout, _stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw new Error("Neon CLI cloud prerequisite failed");
    return stdout.trim();
  } finally {
    clearTimeout(timeout);
  }
}

test.skipIf(!process.env.LOOM_CLOUD_PROJECT_ID)(
  "Neon PostgreSQL 18 bootstraps and preserves runtime role isolation",
  async () => {
    const projectId = v.parse(identifier, process.env.LOOM_CLOUD_PROJECT_ID);
    const branchId = v.parse(identifier, process.env.LOOM_CLOUD_BRANCH_ID);
    const branches = v.parse(
      v.array(
        v.object({
          id: identifier,
          project_id: identifier,
          name: v.string(),
          default: v.boolean(),
          protected: v.boolean(),
          parent_id: v.optional(identifier),
          init_source: v.optional(v.string()),
        }),
      ),
      JSON.parse(await neon(["branches", "list", "--project-id", projectId, "--output", "json"])),
    );
    const matches = branches.filter((entry) => entry.id === branchId);
    const branch = matches[0];
    if (
      matches.length !== 1 ||
      !branch ||
      branch.project_id !== projectId ||
      branch.default ||
      branch.protected ||
      (!branch.parent_id && branch.init_source !== "parent-schema") ||
      !branch.name.startsWith("loom-acceptance-")
    )
      throw new Error("Cloud tests require an explicit nondefault, unprotected loom-acceptance- child branch");
    const connectionString = await neon([
      "connection-string",
      branchId,
      "--project-id",
      projectId,
      "--ssl",
      "verify-full",
      "--role-name",
      process.env.LOOM_CLOUD_MIGRATION_ROLE ?? "neondb_owner",
    ]);
    const address = URL.parse(connectionString);
    if (
      !address ||
      address.protocol !== "postgresql:" ||
      !address.hostname.endsWith(".neon.tech") ||
      address.hostname.includes("-pooler.") ||
      address.searchParams.get("sslmode") !== "verify-full"
    )
      throw new Error("Cloud test requires a direct TLS-verified Neon connection");
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const metadataNamespace = `loom_${suffix}`;
    const runtimeRole = `runtime_${suffix}`;
    const owner = new pg.Client({ connectionString, connectionTimeoutMillis: 15000, statement_timeout: 15000 });
    let connected = false;
    let stage = "connect";
    try {
      await owner.connect();
      connected = true;
      const version = await owner.query<{ version: number }>(
        "SELECT current_setting('server_version_num')::integer AS version",
      );
      assert.equal(Math.floor((version.rows[0]?.version ?? 0) / 10000), 18);
      stage = "bootstrap";
      await bootstrapDatabase({ connectionString, metadataNamespace, runtimeRole });
      const history = await owner.query<{ version: number; hash: string }>(
        `SELECT version, hash FROM "${metadataNamespace}".framework_migrations ORDER BY version`,
      );
      assert.deepEqual(
        history.rows.map(({ version }) => version),
        Array.from({ length: 29 }, (_, index) => index + 1),
      );
      await bootstrapDatabase({ connectionString, metadataNamespace, runtimeRole });
      assert.deepEqual(
        (await owner.query(`SELECT version, hash FROM "${metadataNamespace}".framework_migrations ORDER BY version`))
          .rows,
        history.rows,
      );
      stage = "runtime role isolation";
      const role = await owner.query<{ rolsuper: boolean; rolbypassrls: boolean; rolcreatedb: boolean }>(
        "SELECT rolsuper, rolbypassrls, rolcreatedb FROM pg_roles WHERE rolname=$1",
        [runtimeRole],
      );
      assert.deepEqual(role.rows, [{ rolsuper: false, rolbypassrls: false, rolcreatedb: false }]);
      stage = "runtime login";
      const password = crypto.randomUUID().replaceAll("-", "");
      await owner.query(`ALTER ROLE "${runtimeRole}" LOGIN PASSWORD '${password}'`);
      const runtimeAddress = new URL(address);
      runtimeAddress.username = runtimeRole;
      runtimeAddress.password = password;
      const runtime = new pg.Client({
        connectionString: runtimeAddress.href,
        connectionTimeoutMillis: 15000,
        statement_timeout: 15000,
      });
      try {
        await runtime.connect();
        stage = "runtime jobs read";
        assert.equal((await runtime.query(`SELECT count(*) FROM "${metadataNamespace}".jobs`)).rows[0].count, "0");
        for (const sql of [
          `CREATE TABLE "${metadataNamespace}".forbidden (id integer)`,
          `UPDATE "${metadataNamespace}".deployment_activations SET state='active'`,
          `DELETE FROM "${metadataNamespace}".framework_migrations`,
        ]) {
          stage = "runtime write refusal";
          await assert.rejects(
            runtime.query(sql),
            (error) => v.safeParse(v.object({ code: v.literal("42501") }), error).success,
          );
        }
      } finally {
        await runtime.end();
      }
    } catch (cause) {
      const code = v.safeParse(v.object({ code: v.pipe(v.string(), v.regex(/^[A-Z0-9]{5}$/)) }), cause);
      throw new Error(
        `Neon cloud database verification failed during ${stage}${code.success ? ` (${code.output.code})` : ""}`,
      );
    } finally {
      try {
        if (connected) {
          await owner.query(`DROP SCHEMA IF EXISTS "${metadataNamespace}" CASCADE`);
          await owner.query(`DROP ROLE IF EXISTS "${runtimeRole}"`);
        }
      } finally {
        await owner.end();
      }
    }
  },
  120000,
);
