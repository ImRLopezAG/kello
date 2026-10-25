import { expect, test } from "vite-plus/test";
import { defineSchema, defineTable } from "kello/server";
import { createSnapshot, planMigration } from "kello/tooling";

test("migration planning is deterministic and separates safe additions from required backfills", async () => {
  const before = await createSnapshot(defineSchema((f) => ({ tasks: { title: f.text() } })));
  const optional = defineSchema((f) => ({ tasks: { title: f.text(), description: f.text() } }));
  const first = await planMigration(before, optional);
  const second = await planMigration(before, optional);
  expect(first.hash).toBe(second.hash);
  expect(first.safety.automatic).toBe(true);
  expect(first.statements.join("\n")).toContain('ADD COLUMN "description"');
  const required = await planMigration(
    before,
    defineSchema((f) => ({ tasks: { title: f.text(), description: f.text().notNull() } })),
  );
  expect(required.safety.automatic).toBe(false);
  expect(required.safety.issues.map((issue) => issue.reason)).toContain("backfill-required");
});

test("migration planning refuses rename guesses and marks explicit renames for review", async () => {
  const before = await createSnapshot(defineSchema((f) => ({ tasks: { title: f.text() } })));
  const renamed = defineSchema((f) => ({ tasks: { name: f.text() } }));
  await expect(planMigration(before, renamed)).rejects.toMatchObject({ code: "missing_hints" });
  const plan = await planMigration(before, renamed, [
    { type: "rename", kind: "column", from: ["public", "tasks", "title"], to: ["public", "tasks", "name"] },
  ]);
  expect(plan.statements.join("\n")).toContain('RENAME COLUMN "title" TO "name"');
  expect(plan.statements.join("\n")).not.toContain("DROP");
  expect(plan.safety.automatic).toBe(false);
});

test("migration planning treats constraint, type and deletion changes as reviewed changes", async () => {
  const before = await createSnapshot(defineSchema((f) => ({ tasks: { title: f.text(), count: f.integer() } })));
  const changed = await planMigration(
    before,
    defineSchema((f) => ({ tasks: { title: f.text().unique(), count: f.bigint() } })),
  );
  expect(changed.safety.automatic).toBe(false);
  expect(changed.safety.issues.map((issue) => issue.reason)).toContain("constraint-validation");
  expect(changed.safety.issues.map((issue) => issue.reason)).toContain("type-change");
  const dropped = await planMigration(
    before,
    defineSchema((f) => ({ tasks: { title: f.text() } })),
  );
  expect(dropped.safety.issues.map((issue) => issue.reason)).toContain("deletion");
});

test("committed migration artifacts reject altered SQL and broken lineage", async () => {
  const { mkdtemp, readFile, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { emptySnapshot, writeMigration, readMigrations } = await import("kello/tooling");
  const root = await mkdtemp(path.join(tmpdir(), "loom-history-"));
  try {
    const schema = defineSchema(
      (f) => ({
        projects: { name: f.text().unique() },
        tasks: defineTable(
          {
            title: f.text(),
            projectId: f.reference("projects"),
            state: f.enum(["open", "closed"]),
            amount: f.numeric({ precision: 12, scale: 2 }),
            metadata: f.json(),
          },
          { indexes: [{ fields: ["title", "state"] }] },
        ),
      }),
      { namespace: "app" },
    );
    const initial = await planMigration(await emptySnapshot("app"), schema);
    await writeMigration(root, "migrations", "initial", initial);
    expect((await readMigrations(root, "migrations"))[0]?.plan.hash).toBe(initial.hash);
    await expect(writeMigration(root, "migrations", "duplicate", initial)).rejects.toThrow("baseline");
    const sqlFile = path.join(root, "migrations", `${initial.hash}_initial`, "migration.sql");
    const sql = await readFile(sqlFile, "utf8");
    await writeFile(sqlFile, sql + "\nDROP SCHEMA app CASCADE;\n");
    await expect(readMigrations(root, "migrations")).rejects.toThrow("SQL artifact");
    await writeFile(sqlFile, sql);
    const planFile = path.join(root, "migrations", `${initial.hash}_initial`, "plan.json");
    await writeFile(planFile, JSON.stringify({ ...initial, snapshot: { ...initial.snapshot, ddl: [] } }));
    await expect(readMigrations(root, "migrations")).rejects.toThrow("hash mismatch");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
