import { expect, test } from "vite-plus/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineSchema } from "kello/server";
import { emptySnapshot, planMigration, planCustomMigration, readMigrations, writeMigration } from "kello-cli";

const schema = defineSchema((f) => ({ tasks: { title: f.text() } }), { namespace: "app" });

test("custom SQL uses PostgreSQL statement boundaries and always requires review", async () => {
  const initial = await planMigration(await emptySnapshot("app"), schema);
  const custom = await planCustomMigration(
    initial.snapshot,
    schema,
    "-- é; comment\nUPDATE app.tasks SET title = $$é; COMMIT$$; /* ; */ UPDATE app.tasks SET title = 'done;';",
    "transactional",
    initial.hash,
  );
  expect(custom.statements).toHaveLength(2);
  expect(custom.statements[0]).toContain("$$é; COMMIT$$");
  expect(custom.statements[1]).toContain("'done;'");
  expect(custom.safety.automatic).toBe(false);
  expect(custom.before).toBe(custom.after);
  expect(custom.parent).toBe(initial.hash);
  await expect(planCustomMigration(initial.snapshot, schema, "COMMIT;", "transactional", initial.hash)).rejects.toThrow(
    "unsupported",
  );
  await expect(
    planCustomMigration(initial.snapshot, schema, "SET ROLE postgres;", "transactional", initial.hash),
  ).rejects.toThrow("unsupported");
  await expect(
    planCustomMigration(initial.snapshot, schema, "-- only comment", "transactional", initial.hash),
  ).rejects.toThrow("requires SQL");
  await expect(
    planCustomMigration(initial.snapshot, schema, "UPDATE SET", "transactional", initial.hash),
  ).rejects.toThrow();
});

test("concurrent indexes require an explicit nontransactional artifact", async () => {
  const initial = await planMigration(await emptySnapshot("app"), schema);
  const sql = "CREATE INDEX CONCURRENTLY task_title ON app.tasks(title);";
  await expect(planCustomMigration(initial.snapshot, schema, sql, "transactional", initial.hash)).rejects.toThrow(
    "nontransactional mode",
  );
  const custom = await planCustomMigration(initial.snapshot, schema, sql, "nontransactional", initial.hash);
  expect(custom.safety.transactional).toBe(false);
  expect(custom.safety.automatic).toBe(false);
});

test("data-only migration history follows artifact parents and rejects stale writers", async () => {
  const root = await mkdtemp(join(tmpdir(), "loom-custom-"));
  try {
    const initial = await planMigration(await emptySnapshot("app"), schema);
    await writeMigration(root, "migrations", "initial", initial);
    const first = await planCustomMigration(
      initial.snapshot,
      schema,
      "UPDATE app.tasks SET title = 'first'",
      "transactional",
      initial.hash,
    );
    await writeMigration(root, "migrations", "first", first);
    const second = await planCustomMigration(
      first.snapshot,
      schema,
      "UPDATE app.tasks SET title = 'second'",
      "transactional",
      first.hash,
    );
    await writeMigration(root, "migrations", "second", second);
    expect((await readMigrations(root, "migrations")).map((artifact) => artifact.plan.hash)).toEqual([
      initial.hash,
      first.hash,
      second.hash,
    ]);
    await expect(writeMigration(root, "migrations", "stale", first)).rejects.toThrow("history head");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
