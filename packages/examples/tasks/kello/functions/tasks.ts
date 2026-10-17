import { os } from "../_generated/rpc";
import { and, eq, sql } from "drizzle-orm";
import { ownedProjects } from "../access";
export default os.tasks.router({
  search: os.tasks.search.handler(({ context, input }) => context.search.tasks.paginate(input)),
  // Membership is enforced in SQL: the owned-project join is part of the live predicate.
  list: os.tasks.list.live(({ context: { db, tables, identity }, input }) =>
    db
      .select({
        _id: tables.tasks._id,
        projectId: sql<typeof tables.tasks.projectId._.data>`${tables.tasks.projectId}`.as("projectId"),
        title: tables.tasks.title,
        done: tables.tasks.done,
      })
      .from(tables.tasks)
      .innerJoin(tables.projects, eq(tables.tasks.projectId, tables.projects._id))
      .where(and(ownedProjects(identity), eq(tables.tasks.projectId, input.projectId)))
      .orderBy(tables.tasks._createdAt, tables.tasks._id)
      .limit(100),
  ),
  create: os.tasks.create.handler(
    async ({
      context: {
        db,
        tables: { projects, tasks },
        identity,
        components,
      },
      input,
      errors,
    }) => {
      const [project] = await db
        .select({ _id: projects._id })
        .from(projects)
        .where(and(ownedProjects(identity), eq(projects._id, input.projectId)))
        .limit(1);
      if (!project) throw errors.FORBIDDEN();
      const title = await components.titles.rpc.title.prepare(input.title);
      const [task] = await db
        .insert(tasks)
        .values({ ...input, title })
        .returning({ _id: tasks._id, projectId: tasks.projectId, title: tasks.title, done: tasks.done });
      if (!task) throw new Error("Task insert did not return a row");
      return task;
    },
  ),
  setDone: os.tasks.setDone.handler(
    async ({
      context: {
        db,
        tables: { projects, tasks },
        identity,
      },
      input,
      errors,
    }) => {
      const [owned] = await db
        .select({ _id: tasks._id })
        .from(tasks)
        .innerJoin(projects, eq(tasks.projectId, projects._id))
        .where(and(ownedProjects(identity), eq(tasks._id, sql`${input.id}`)))
        .limit(1);
      if (!owned) throw errors.FORBIDDEN();
      const [task] = await db
        .update(tasks)
        .set({ done: input.done })
        .where(eq(tasks._id, owned._id))
        .returning({ _id: tasks._id, projectId: tasks.projectId, title: tasks.title, done: tasks.done });
      if (!task) throw errors.FORBIDDEN();
      return task;
    },
  ),
});
