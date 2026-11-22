import { defineSchema, defineTable, fields } from "kello/server";
import type { Id, JsonValue } from "kello/server";
import { defineRelations } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres";

const projects = defineTable({ name: fields.text().notNull(), featured: fields.reference("tasks") });
const schema = defineSchema((s) => ({
  projects,
  tasks: {
    projectId: s.reference("projects").notNull(),
    title: s.text().notNull(),
    state: s.enum(["open", "closed"]).notNull().default("open"),
    details: s.json(),
  },
}));
type Task = typeof schema.tables.tasks.$inferSelect;
type Insert = typeof schema.tables.tasks.$inferInsert;
declare const task: Task;
const projectId: Id<"projects"> = task.projectId;
const taskId: Id<"tasks"> = task._id;
const created: number = task._createdAt;
const details: JsonValue = task.details;
const valid: Insert = { projectId, title: "Build" };
// @ts-expect-error task IDs cannot stand in for project IDs
const wrongReference: Insert = { projectId: taskId, title: "Build" };
// @ts-expect-error required title cannot be omitted
const missing: Insert = { projectId };
// @ts-expect-error enums retain their literals
const invalidState: Insert = { projectId, title: "Build", state: "missing" };
// @ts-expect-error default must match storage type
fields.integer().default("one");
// @ts-expect-error indexes must reference declared fields
defineTable({ name: fields.text() }, { indexes: [{ fields: ["missing"] }] });
const relations = defineRelations(schema.tables, (r) => ({
  tasks: { project: r.one.projects({ from: r.tasks.projectId, to: r.projects._id }) },
}));
const db = drizzle({ connection: "postgres://unused", relations });
const rows = await db.query.tasks.findMany({ with: { project: true } });
const name: string | undefined = rows[0]?.project?.name;
void [created, details, valid, wrongReference, missing, invalidState, name];
