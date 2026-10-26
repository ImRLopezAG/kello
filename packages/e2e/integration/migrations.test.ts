import { expect, test } from "bun:test";
import { defineSchema } from "kello/server";
import { emptySnapshot, planMigration, snapshotHash } from "kello-cli";
import pg from "pg";
import { fileURLToPath } from "node:url";

const connectionString = process.env.LOOM_TEST_DATABASE_URL;
test.skipIf(!connectionString)(
  "release planning retains its committed baseline after live schema evolution and preserves renamed data",
  async () => {
    const namespace = `loom_migration_${crypto.randomUUID().replaceAll("-", "")}`;
    const pool = new pg.Pool({ connectionString });
    const baseline = defineSchema((f) => ({ tasks: { title: f.text().notNull() } }), { namespace });
    const expanded = defineSchema((f) => ({ tasks: { title: f.text().notNull(), description: f.text() } }), {
      namespace,
    });
    try {
      const initial = await planMigration(await emptySnapshot(namespace), baseline);
      expect(initial.safety.automatic).toBe(true);
      expect(initial.statements.join("\n")).toContain("CREATE SCHEMA");
      for (const statement of initial.statements) await pool.query(statement);
      await pool.query(`INSERT INTO "${namespace}".tasks (title) VALUES ('preserve me')`);
      const releaseBeforeSync = await planMigration(initial.snapshot, expanded);
      for (const statement of releaseBeforeSync.statements) await pool.query(statement);
      const releaseAfterSync = await planMigration(initial.snapshot, expanded);
      expect(releaseAfterSync.hash).toBe(releaseBeforeSync.hash);
      expect(releaseAfterSync.statements.join("\n")).toContain('ADD COLUMN "description"');
      const renamed = defineSchema((f) => ({ tasks: { name: f.text().notNull(), description: f.text() } }), {
        namespace,
      });
      const rename = await planMigration(releaseAfterSync.snapshot, renamed, [
        { type: "rename", kind: "column", from: [namespace, "tasks", "title"], to: [namespace, "tasks", "name"] },
      ]);
      for (const statement of rename.statements) await pool.query(statement);
      expect((await pool.query<{ name: string }>(`SELECT name FROM "${namespace}".tasks`)).rows).toEqual([
        { name: "preserve me" },
      ]);
      const noChange = await planMigration(rename.snapshot, renamed);
      expect(noChange.statements).toEqual([]);
      expect(snapshotHash(noChange.snapshot)).toBe(rename.after);
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
      await pool.end();
    }
  },
);

test("programmatic Drizzle rename resolution does not write progress to stdout", async () => {
  const source = `import { pgTable, text } from "drizzle-orm/pg-core";
    import { generateDrizzleJson, generateMigration } from "drizzle-kit/api-postgres";
    const before = await generateDrizzleJson({ tasks: pgTable("tasks", { title: text() }) });
    const after = await generateDrizzleJson({ tasks: pgTable("tasks", { name: text() }) }, before.id);
    await generateMigration(before, after, { hints: [{type:"rename",kind:"column",from:["public","tasks","title"],to:["public","tasks","name"]}] });
    console.log("complete");`;
  const child = Bun.spawn([process.execPath, "--eval", source], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await new Response(child.stderr).text()).toBe("");
  expect(await new Response(child.stdout).text()).toBe("complete\n");
  expect(await child.exited).toBe(0);
});
