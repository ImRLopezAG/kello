import assert from "node:assert/strict";
import { expect, test } from "bun:test";
import { defineRelations, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { bigint, pgSchema, text, uuid } from "drizzle-orm/pg-core";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api-postgres";
import pg from "pg";

const connectionString = process.env.LOOM_TEST_DATABASE_URL;

test.skipIf(!connectionString)("PostgreSQL 18 native IDs, constraints, migration replay and RQB v2", async () => {
  const namespace = `loom_compat_${crypto.randomUUID().replaceAll("-", "")}`;
  const schema = pgSchema(namespace);
  const projects = schema.table("projects", {
    _id: uuid()
      .primaryKey()
      .default(sql`uuidv7()`),
    name: text().notNull(),
  });
  const tasks = schema.table("tasks", {
    _id: uuid()
      .primaryKey()
      .default(sql`uuidv7()`),
    _createdAt: bigint({ mode: "number" })
      .notNull()
      .default(sql`floor(extract(epoch from clock_timestamp()) * 1000)`),
    projectId: uuid().references(() => projects._id),
    title: text().notNull(),
  });
  const relations = defineRelations({ projects, tasks }, (r) => ({
    tasks: { project: r.one.projects({ from: r.tasks.projectId, to: r.projects._id }) },
    projects: { tasks: r.many.tasks() },
  }));
  const pool = new pg.Pool({ connectionString });
  const db = drizzle({ client: pool, relations });
  try {
    const version = await pool.query<{ server_version_num: string }>("SHOW server_version_num");
    expect(Number(version.rows[0]?.server_version_num)).toBeGreaterThanOrEqual(180000);
    const empty = await generateDrizzleJson({}, undefined, [namespace]);
    const snapshot = await generateDrizzleJson({ schema, projects, tasks }, empty.id, [namespace]);
    for (const statement of await generateMigration(empty, snapshot)) await pool.query(statement);
    const [project] = await db.insert(projects).values({ name: "Kello" }).returning();
    if (!project) throw new Error("Missing inserted project");
    await db.insert(tasks).values({ projectId: project._id, title: "Verify relations" });
    const result = await db.query.tasks.findMany({ with: { project: true }, orderBy: { title: "asc" } });
    expect(result[0]?.project?.name).toBe("Kello");
    expect(result[0]?._id[14]).toBe("7");
    expect(Number.isSafeInteger(result[0]?._createdAt)).toBe(true);
    await assert.rejects(db.insert(tasks).values({ projectId: crypto.randomUUID(), title: "Invalid FK" }).execute());
    const renamedTasks = schema.table("tasks", {
      _id: uuid()
        .primaryKey()
        .default(sql`uuidv7()`),
      _createdAt: bigint({ mode: "number" })
        .notNull()
        .default(sql`floor(extract(epoch from clock_timestamp()) * 1000)`),
      projectId: uuid().references(() => projects._id),
      name: text().notNull(),
    });
    const renamed = await generateDrizzleJson({ schema, projects, tasks: renamedTasks }, snapshot.id, [namespace]);
    const renameSql = await generateMigration(snapshot, renamed, {
      hints: [
        { type: "rename", kind: "column", from: [namespace, "tasks", "title"], to: [namespace, "tasks", "name"] },
      ],
    });
    for (const statement of renameSql) await pool.query(statement);
    const rows = await db.select().from(renamedTasks);
    expect(rows[0]?.name).toBe("Verify relations");
  } finally {
    // Namespace is generated locally from a UUID, never supplied by a caller.
    await pool.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
    await pool.end();
  }
});
