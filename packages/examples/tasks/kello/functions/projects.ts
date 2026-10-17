import { os } from "../_generated/rpc";
import { ownedProjects, requireIdentity } from "../access";
export default os.projects.router({
  list: os.projects.list.live(({ context: { db, tables, identity } }) =>
    db
      .select({ _id: tables.projects._id, name: tables.projects.name })
      .from(tables.projects)
      .where(ownedProjects(identity))
      .orderBy(tables.projects._createdAt, tables.projects._id)
      .limit(100),
  ),
  create: os.projects.create.handler(
    async ({
      context: {
        db,
        tables: { projects },
        identity,
      },
      input,
    }) => {
      const owner = requireIdentity(identity);
      const [project] = await db
        .insert(projects)
        .values({ ...input, ownerIssuer: owner.issuer, ownerId: owner.subject })
        .returning({ _id: projects._id, name: projects.name });
      if (!project) throw new Error("Project insert did not return a row");
      return project;
    },
  ),
});
