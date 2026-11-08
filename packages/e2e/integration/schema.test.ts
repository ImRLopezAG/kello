import assert from "node:assert/strict";
import { expect, test } from "bun:test";
import { defineSchema, systemFieldSql } from "kello/server";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api-postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { pgSchema } from "drizzle-orm/pg-core";

const connectionString = process.env.KELLO_TEST_DATABASE_URL;
test.skipIf(!connectionString)(
  "compiled schema persists typed rows and protects system fields against SQL writes",
  async () => {
    const namespace = `kello_schema_${crypto.randomUUID().replaceAll("-", "")}`;
    const schema = defineSchema(
      (s) => ({
        projects: { name: s.text().notNull() },
        tasks: {
          title: s.text().notNull(),
          projectId: s.reference("projects").notNull(),
          state: s.enum(["open", "closed"]).default("open"),
        },
      }),
      { namespace },
    );
    const pool = new pg.Pool({ connectionString });
    const db = drizzle({ client: pool });
    try {
      const empty = await generateDrizzleJson({}, undefined, [namespace]);
      const snapshot = await generateDrizzleJson({ namespace: pgSchema(namespace), ...schema.tables }, empty.id, [
        namespace,
      ]);
      for (const statement of await generateMigration(empty, snapshot)) await pool.query(statement);
      for (const statement of systemFieldSql(schema.metadata)) await pool.query(statement);
      const [project] = await db.insert(schema.tables.projects).values({ name: "Kello" }).returning();
      if (!project) throw new Error("Missing project");
      const [task] = await db
        .insert(schema.tables.tasks)
        .values({ title: "Compile", projectId: project._id })
        .returning();
      expect(task?._id[14]).toBe("7");
      expect(task?.state).toBe("open");
      expect(Number.isSafeInteger(task?._createdAt)).toBe(true);
      await assert.rejects(pool.query(`UPDATE "${namespace}".tasks SET "_createdAt" = 1`), /immutable/);
      await assert.rejects(pool.query(`UPDATE "${namespace}".tasks SET "_id" = uuidv7()`), /immutable/);
      await assert.rejects(
        pool.query(`INSERT INTO "${namespace}".tasks(title, project_id) VALUES ('bad', uuidv7())`),
        /foreign key/,
      );
      await assert.rejects(pool.query(`UPDATE "${namespace}".tasks SET state = 'unknown'`), /check constraint/);
      await assert.rejects(pool.query(`DELETE FROM "${namespace}".projects`), /foreign key/);
      await pool.query(`UPDATE "${namespace}".tasks SET title = 'Updated'`);
      expect((await db.select().from(schema.tables.tasks))[0]?.title).toBe("Updated");
      await pool.query(`INSERT INTO "${namespace}".projects(name, "_createdAt") VALUES ('Overflow', 9007199254740992)`);
      await assert.rejects(db.select().from(schema.tables.projects).execute(), /safe integer/);
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
      await pool.end();
    }
  },
);
