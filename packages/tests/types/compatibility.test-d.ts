import { defineRelations } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres";
import { pgTable, text, uuid } from "drizzle-orm/pg-core";

const projects = pgTable("projects", { _id: uuid().primaryKey(), name: text().notNull() });
const tasks = pgTable("tasks", {
  _id: uuid().primaryKey(),
  projectId: uuid().references(() => projects._id),
  title: text().notNull(),
});
const relations = defineRelations({ projects, tasks }, (r) => ({
  tasks: { project: r.one.projects({ from: r.tasks.projectId, to: r.projects._id }) },
  projects: { tasks: r.many.tasks() },
}));
const db = drizzle({ connection: "postgresql://unused", relations });
const selection = db.query.tasks.findMany({
  where: { title: { ilike: "%task%" } },
  with: { project: true },
  orderBy: { title: "asc" },
});
type Task = Awaited<typeof selection>[number];

export function verifyInferredResult(task: Task) {
  const title: string = task.title;
  const projectName: string | undefined = task.project?.name;
  const projectId: string | null = task.projectId;
  // @ts-expect-error Nullable FK must not narrow to a required value.
  const requiredProjectId: string = task.projectId;
  // @ts-expect-error Result must not acquire undeclared fields.
  const secret = task.secret;
  return { title, projectName, projectId, requiredProjectId, secret };
}
