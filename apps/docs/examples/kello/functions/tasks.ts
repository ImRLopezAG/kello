import { and, eq } from "drizzle-orm";
import { os } from "../_generated/rpc";

export default os.tasks.router({
  list: os.tasks.list.live(({ context: { db, tables, identity }, errors }) => {
    if (!identity) throw errors.UNAUTHORIZED();
    return db
      .select({ _id: tables.tasks._id, title: tables.tasks.title, done: tables.tasks.done })
      .from(tables.tasks)
      .where(and(eq(tables.tasks.ownerId, identity.subject), eq(tables.tasks.ownerIssuer, identity.issuer)))
      .orderBy(tables.tasks._createdAt, tables.tasks._id)
      .limit(100);
  }),
  create: os.tasks.create.handler(async ({ context: { db, tables, identity }, input, errors }) => {
    if (!identity) throw errors.UNAUTHORIZED();
    const [task] = await db
      .insert(tables.tasks)
      .values({ ...input, ownerId: identity.subject, ownerIssuer: identity.issuer })
      .returning();
    if (!task) throw new Error("Task insert did not return a row");
    return task;
  }),
  greeting: os.tasks.greeting.handler(({ input }) => `Hello, ${input.name}`),
});
