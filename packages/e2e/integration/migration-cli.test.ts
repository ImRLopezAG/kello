import { initializeProject } from "kello-cli";
import { expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, symlink, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readMigrations } from "kello-cli";
import pg from "pg";
import * as v from "valibot";

const connectionString = process.env.LOOM_TEST_DATABASE_URL;
test.skipIf(!connectionString)(
  "CLI generates, applies and diagnoses migration artifacts without exposing credentials",
  async () => {
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const namespace = `app_${suffix}`;
    const metadataNamespace = `loom_meta_${suffix}`;
    const runtimeRole = `loom_runtime_${suffix}`;
    const root = await mkdtemp(join(tmpdir(), "loom-migration-cli-"));
    const admin = new pg.Client({ connectionString });
    await admin.connect();
    const cli = fileURLToPath(new URL("../../../apps/kello-cli/src/cli.ts", import.meta.url));
    async function run(args: string[], exitCode = 0) {
      const child = Bun.spawn([process.execPath, cli, ...args, "--cwd", root, "--json"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = await new Response(child.stdout).text();
      const stderr = await new Response(child.stderr).text();
      expect(await child.exited).toBe(exitCode);
      expect(stdout + stderr).not.toContain("loom-local-only");
      if (exitCode === 0) expect(stderr).toBe("");
      return stdout + stderr;
    }
    try {
      await initializeProject(root, "migration-fixture");
      await mkdir(join(root, "node_modules/@kello"), { recursive: true });
      for (const name of ["kello", "kello-cli", "valibot", "drizzle-orm"]) {
        await symlink(
          await realpath(fileURLToPath(new URL(`../../tests/node_modules/${name}`, import.meta.url))),
          join(root, "node_modules", name),
        );
      }
      await writeFile(
        join(root, "kello.config.ts"),
        `import { defineConfig } from "kello-cli"; export default defineConfig(${JSON.stringify({ project: "migration-fixture", database: { namespace, metadataNamespace, migrationUrlEnv: "LOOM_TEST_DATABASE_URL" } })});`,
      );
      const schemaFile = join(root, "kello/schema.ts");
      await writeFile(
        schemaFile,
        (await readFile(schemaFile, "utf8")).replace('namespace: "app"', `namespace: "${namespace}"`),
      );
      expect(await run(["migrations", "apply"], 2)).toContain("MISSING_VALUE");
      expect(await run(["migrations", "declare-compatibility"], 2)).toContain("USAGE");
      expect(await run(["migrations", "declare-compatibility", "--release", "missing.json", "--dry-run"], 2)).toContain(
        "USAGE",
      );
      expect(await run(["migrations", "declare-compatibility", "--release", "missing.json"], 4)).toContain(
        "MIGRATION_FAILED",
      );
      expect(await run(["migrations", "apply", "--runtime-role", runtimeRole], 4)).toContain("UNGENERATED_SCHEMA");
      expect(await run(["migrations", "generate", "--name", "initial"])).toContain('"ok":true');
      expect(await run(["migrations", "status"])).toContain('"initialized":false');
      const target = await admin.query<{ database: string }>("SELECT current_database() AS database");
      const applied = JSON.parse(await run(["migrations", "apply", "--runtime-role", runtimeRole]));
      expect(applied.receipt.target.database).toBe(target.rows[0]?.database);
      expect(await run(["migrations", "status"])).toContain('"pending":[]');
      await admin.query(`INSERT INTO "${namespace}".tasks(title) VALUES ('before')`);
      await writeFile(join(root, "backfill.sql"), `UPDATE "${namespace}".tasks SET title = 'custom'`);
      expect(await run(["migrations", "generate", "--name", "backfill", "--sql", "backfill.sql"], 2)).toContain(
        "USAGE",
      );
      expect(
        await run(["migrations", "generate", "--name", "backfill", "--sql", "backfill.sql", "--mode", "transactional"]),
      ).toContain('"kind":"custom"');
      expect(await run(["migrations", "apply", "--runtime-role", runtimeRole], 4)).toContain("REVIEW_REQUIRED");
      const custom = (await readMigrations(root, "kello/_generated/migrations")).at(-1);
      if (!custom) throw new Error("Missing custom artifact");
      expect(
        await run(["migrations", "apply", "--runtime-role", runtimeRole, "--reviewed-hash", custom.plan.hash]),
      ).toContain(custom.plan.hash);
      expect((await admin.query(`SELECT title FROM "${namespace}".tasks`)).rows).toEqual([{ title: "custom" }]);
      await writeFile(
        schemaFile,
        (await readFile(schemaFile, "utf8")).replace(
          "publicFields:",
          'indexes: [{ fields: ["title"], unique: true }], publicFields:',
        ),
      );
      await writeFile(
        join(root, "index.sql"),
        `CREATE UNIQUE INDEX CONCURRENTLY tasks_0_idx ON "${namespace}".tasks (title)`,
      );
      await run([
        "migrations",
        "generate",
        "--name",
        "unique_title",
        "--sql",
        "index.sql",
        "--mode",
        "nontransactional",
      ]);
      const concurrent = (await readMigrations(root, "kello/_generated/migrations")).at(-1);
      if (!concurrent) throw new Error("Missing concurrent artifact");
      const recover = [
        "migrations",
        "apply",
        "--runtime-role",
        runtimeRole,
        "--reviewed-hash",
        concurrent.plan.hash,
        "--recover-nontransactional",
      ];
      await admin.query(`INSERT INTO "${namespace}".tasks(title) VALUES ('custom')`);
      await run(recover, 4);
      expect(await run(["migrations", "status"], 4)).toContain("NONTRANSACTIONAL_IN_PROGRESS");
      await admin.query(
        `DELETE FROM "${namespace}".tasks WHERE "_id" IN (SELECT "_id" FROM "${namespace}".tasks LIMIT 1)`,
      );
      expect(await run(recover)).toContain(concurrent.plan.hash);
      expect(await run(["migrations", "status"])).toContain('"pending":[]');
      expect(await run(["migrations", "status", "--recover-nontransactional"], 2)).toContain("USAGE");
      await admin.query(`ALTER TABLE "${namespace}".tasks ADD COLUMN external_change text`);
      expect(await run(["migrations", "status"], 4)).toContain("LIVE_DRIFT");
      expect(await run(["migrations", "apply", "--runtime-role", runtimeRole], 4)).toContain("INCONSISTENT_DATABASE");
      await admin.query(`ALTER TABLE "${namespace}".tasks DROP COLUMN external_change`);
      await admin.query(`INSERT INTO "${namespace}".tasks(title) VALUES ('second'), ('third')`);
      await writeFile(
        join(root, "rows.sql"),
        `UPDATE "${namespace}".tasks SET title=title||'!' WHERE "_id"=ANY($1::uuid[]) RETURNING "_id"`,
      );
      await run([
        "backfill",
        "generate",
        "--name",
        "titles",
        "--table",
        "tasks",
        "--sql",
        "rows.sql",
        "--batch-size",
        "1",
      ]);
      const backfillFile = "backfills/titles.json";
      const saved = await readFile(join(root, backfillFile), "utf8");
      const backfill = v.parse(v.object({ hash: v.string() }), JSON.parse(saved));
      await run(["backfill", "generate", "--name", "titles", "--table", "tasks", "--sql", "rows.sql"], 4);
      expect(await readFile(join(root, backfillFile), "utf8")).toBe(saved);
      expect(await run(["backfill", "status", "--backfill", backfillFile])).toContain('"receipt":null');
      const apply = [
        "backfill",
        "apply",
        "--backfill",
        backfillFile,
        "--runtime-role",
        runtimeRole,
        "--reviewed-hash",
        backfill.hash,
      ];
      expect(await run([...apply, "--max-batches", "1"])).toContain('"state":"running"');
      expect(await run(["backfill", "status", "--backfill", backfillFile])).toContain('"processed":1');
      expect(await run(apply)).toContain('"state":"complete"');
      await run(apply);
      expect((await admin.query(`SELECT title FROM "${namespace}".tasks ORDER BY title`)).rows).toEqual([
        { title: "custom!" },
        { title: "second!" },
        { title: "third!" },
      ]);
      expect(await run([...apply, "--max-batches", "0"], 2)).toContain("USAGE");
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
      await admin.query(`DROP SCHEMA IF EXISTS "${metadataNamespace}" CASCADE`);
      await admin.query(`DROP ROLE IF EXISTS "${runtimeRole}"`);
      await admin.end();
      await rm(root, { recursive: true, force: true });
    }
  },
  30000,
);
