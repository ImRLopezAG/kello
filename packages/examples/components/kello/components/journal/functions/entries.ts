import { os } from "../_generated/rpc";
import { and, desc, eq } from "drizzle-orm";
import { Effect } from "effect";
export default os.entries.router({
  list: os.entries.list.handler(({ context, errors }) => {
    if (!context.identity) throw errors.UNAUTHORIZED();
    const { entries } = context.tables;
    return context.db
      .select({ _id: entries._id, text: entries.text })
      .from(entries)
      .where(and(eq(entries.owner, context.identity.subject), eq(entries.issuer, context.identity.issuer)))
      .orderBy(desc(entries._createdAt), desc(entries._id))
      .limit(50);
  }),
  add: os.entries.add.effect(function* ({ context, input }) {
    return yield* Effect.promise(() => context.internal.entries.insert(input));
  }),
  watch: os.entries.watch.live(({ context, errors }) => {
    if (!context.identity) throw errors.UNAUTHORIZED();
    const { entries } = context.tables;
    return context.db
      .select({ _id: entries._id, text: entries.text })
      .from(entries)
      .where(and(eq(entries.owner, context.identity.subject), eq(entries.issuer, context.identity.issuer)))
      .orderBy(desc(entries._createdAt), desc(entries._id))
      .limit(50);
  }),
});
