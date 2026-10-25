import assert from "node:assert/strict";
import { describe, expect, test } from "bun:test";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api-postgres";
import { integer, pgTable, text } from "drizzle-orm/pg-core";

describe("Drizzle programmatic migration compatibility", () => {
  test("generates an additive nullable column without a terminal", async () => {
    const before = await generateDrizzleJson({
      tasks: pgTable("tasks", { id: integer().primaryKey() }),
    });
    const after = await generateDrizzleJson(
      {
        tasks: pgTable("tasks", { id: integer().primaryKey(), description: text() }),
      },
      before.id,
    );
    const statements = await generateMigration(before, after);
    expect(statements.join("\n")).toContain('ADD COLUMN "description" text');
  });

  test("rejects an ambiguous table rename before returning SQL", async () => {
    const before = await generateDrizzleJson({
      projects: pgTable("projects", { id: integer().primaryKey() }),
    });
    const after = await generateDrizzleJson(
      {
        workspaces: pgTable("workspaces", { id: integer().primaryKey() }),
      },
      before.id,
    );
    await assert.rejects(generateMigration(before, after), /Schema changes require hints/);
  });

  test("rejects an ambiguous column rename before returning SQL", async () => {
    const before = await generateDrizzleJson({
      tasks: pgTable("tasks", { id: integer().primaryKey(), title: text() }),
    });
    const after = await generateDrizzleJson(
      {
        tasks: pgTable("tasks", { id: integer().primaryKey(), name: text() }),
      },
      before.id,
    );
    await assert.rejects(generateMigration(before, after), /Schema changes require hints/);
  });

  test("generates an explicitly mapped column rename without dropping data", async () => {
    const before = await generateDrizzleJson({
      tasks: pgTable("tasks", { id: integer().primaryKey(), title: text() }),
    });
    const after = await generateDrizzleJson(
      {
        tasks: pgTable("tasks", { id: integer().primaryKey(), name: text() }),
      },
      before.id,
    );
    const statements = await generateMigration(before, after, {
      hints: [{ type: "rename", kind: "column", from: ["public", "tasks", "title"], to: ["public", "tasks", "name"] }],
    });
    expect(statements.join("\n")).toContain('RENAME COLUMN "title" TO "name"');
    expect(statements.join("\n")).not.toContain("DROP");
  });

  test("generates an explicit table rename and rejects an invalid source", async () => {
    const before = await generateDrizzleJson({ projects: pgTable("projects", { id: integer().primaryKey() }) });
    const after = await generateDrizzleJson(
      { workspaces: pgTable("workspaces", { id: integer().primaryKey() }) },
      before.id,
    );
    const statements = await generateMigration(before, after, {
      hints: [{ type: "rename", kind: "table", from: ["public", "projects"], to: ["public", "workspaces"] }],
    });
    expect(statements.join("\n")).toContain('RENAME TO "workspaces"');
    expect(statements.join("\n")).not.toContain("DROP");
    await assert.rejects(
      generateMigration(before, after, {
        hints: [{ type: "rename", kind: "table", from: ["public", "missing"], to: ["public", "workspaces"] }],
      }),
      /doesn't match any deleted table/,
    );
  });
});
