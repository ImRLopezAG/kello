import { expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/node-postgres";
import { defineSchema, defineTable } from "kello/server";
import { emptySnapshot, inspectSnapshot, planMigration } from "kello-cli";
import pg from "pg";

const connectionString = process.env.LOOM_TEST_DATABASE_URL;
test.skipIf(!connectionString)(
  "live introspection plans from actual catalog changes without moving the release baseline",
  async () => {
    const namespace = `app_${crypto.randomUUID().replaceAll("-", "")}`;
    const client = new pg.Client({ connectionString });
    await client.connect();
    try {
      await client.query("SET search_path = pg_catalog");
      const db = drizzle({ client });
      const schema = defineSchema(
        (f) => ({
          tasks: defineTable(
            {
              title: f.text().unique(),
              state: f.enum(["open", "closed"]),
              select: f.enum(["O'Reilly", "C:\\tmp", "a,b", "🐈"]),
              count: f.integer().default(0),
              enabled: f.boolean().default(true),
              amount: f.numeric({ precision: 12, scale: 2 }),
              data: f.json(),
            },
            { indexes: [{ fields: ["state"] }] },
          ),
        }),
        { namespace },
      );
      const initial = await planMigration(await emptySnapshot(namespace), schema);
      for (const statement of initial.statements) await client.query(statement);
      const live = await inspectSnapshot(db, namespace);
      const unchanged = await planMigration(live, schema);
      expect(unchanged.statements).toEqual([]);
      expect(unchanged.safety.issues).toEqual([]);
      await client.query(`ALTER TABLE "${namespace}".tasks ADD COLUMN description text`);
      const expanded = defineSchema(
        (f) => ({
          tasks: defineTable(
            {
              title: f.text().unique(),
              state: f.enum(["open", "closed"]),
              select: f.enum(["O'Reilly", "C:\\tmp", "a,b", "🐈"]),
              count: f.integer().default(0),
              enabled: f.boolean().default(true),
              amount: f.numeric({ precision: 12, scale: 2 }),
              data: f.json(),
              description: f.text(),
            },
            { indexes: [{ fields: ["state"] }] },
          ),
        }),
        { namespace },
      );
      const changedLive = await inspectSnapshot(db, namespace);
      expect((await planMigration(changedLive, expanded)).statements).toEqual([]);
      const additive = await planMigration(live, expanded);
      expect(additive.safety.automatic).toBe(true);
      expect(additive.statements).toHaveLength(1);
      const destructive = await planMigration(changedLive, schema);
      expect(destructive.safety.issues.map((issue) => issue.reason)).toContain("deletion");
      expect((await planMigration(initial.snapshot, expanded)).statements.join("\n")).toContain(
        'ADD COLUMN "description"',
      );
      expect(changedLive.ddl.every((entity) => !("schema" in entity) || entity.schema === namespace)).toBe(true);
      await client.query(`ALTER TABLE "${namespace}".tasks DROP CONSTRAINT tasks_state_enum,
        ADD CONSTRAINT tasks_state_enum CHECK (state = ANY (ARRAY['open'::text, 'different'::text]))`);
      const changedConstraint = await planMigration(await inspectSnapshot(db, namespace), expanded);
      expect(changedConstraint.statements.join("\n")).toContain("ADD CONSTRAINT");
      expect(changedConstraint.safety.automatic).toBe(false);
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
      await client.end();
    }
  },
);
