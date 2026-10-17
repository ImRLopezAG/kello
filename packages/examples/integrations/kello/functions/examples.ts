import { Effect } from "effect";
import { and, eq, desc } from "drizzle-orm";
import { auth } from "../_generated/rpc";
import { Database, Tables } from "../_generated/server";
import { Greeting } from "../services";
export default auth.examples.router({
  zod: auth.examples.zod.handler(({ input, context }) => ({
    message: `Hello, ${input.name}!`,
    owner: context.user.subject,
  })),
  mixed: auth.examples.mixed.handler(async ({ input, context }) => ({
    message: `Hello, ${input.name}!`,
    owner: context.user.subject,
  })),
  effect: auth.examples.effect.effect(function* ({ input, context, errors }) {
    const greeting = yield* Greeting;
    if (input.name === "reject") return yield* Effect.fail(errors.REJECTED());
    return { message: `${greeting.prefix}, ${input.name}!`, owner: context.user.subject };
  }),
  effectSchema: auth.examples.effectSchema.effect(function* ({ input, context }) {
    const greeting = yield* Greeting;
    return { message: `${greeting.prefix}, ${input.name}!`, owner: context.user.subject };
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
  add: auth.examples.add.handler(async ({ input, context, errors }) => {
    const [note] = await context.db
      .insert(context.tables.notes)
      .values({ ...input, owner: context.user.subject, issuer: context.user.issuer })
      .returning({ _id: context.tables.notes._id, text: context.tables.notes.text });
    if (!note) throw errors.REJECTED();
    return note;
  }),
  watch: auth.examples.watch.live(({ context }) =>
    context.db
      .select({ _id: context.tables.notes._id, text: context.tables.notes.text })
      .from(context.tables.notes)
      .where(
        and(eq(context.tables.notes.owner, context.user.subject), eq(context.tables.notes.issuer, context.user.issuer)),
      )
      .orderBy(desc(context.tables.notes._createdAt), desc(context.tables.notes._id))
      .limit(50),
  ),
});
