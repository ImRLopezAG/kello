import { Effect } from "effect";
import { and, eq, desc } from "drizzle-orm";
import { auth } from "../_generated/rpc";
import { Database, Tables } from "../_generated/server";
export default auth.examples.router({
  greeting: auth.examples.greeting.effect(function* ({ input, context }) {
    const message = yield* Effect.promise(() => context.components.greeting.rpc.messages.create(input));
    return { message, owner: context.user.subject };
  }),
  notes: auth.examples.notes.effect(function* ({ context }) {
    const db = yield* Database;
    const tables = yield* Tables;
    return yield* Effect.promise(() =>
      db
        .select({ _id: tables.notes._id, text: tables.notes.text })
        .from(tables.notes)
        .where(and(eq(tables.notes.owner, context.user.subject), eq(tables.notes.issuer, context.user.issuer)))
        .orderBy(desc(tables.notes._createdAt), desc(tables.notes._id))
        .limit(50),
    );
  }),
  watch: auth.examples.watch.live(({ context: { db, tables, user } }) =>
    db
      .select({ _id: tables.notes._id, text: tables.notes.text })
      .from(tables.notes)
      .where(and(eq(tables.notes.owner, user.subject), eq(tables.notes.issuer, user.issuer)))
      .orderBy(desc(tables.notes._createdAt), desc(tables.notes._id))
      .limit(50),
  ),
  add: auth.examples.add.handler(async ({ input, context, errors }) => {
    const [note] = await context.db
      .insert(context.tables.notes)
      .values({ ...input, owner: context.user.subject, issuer: context.user.issuer })
      .returning({ _id: context.tables.notes._id, text: context.tables.notes.text });
    if (!note) throw errors.REJECTED();
    return note;
  }),
});
