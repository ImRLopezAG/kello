import { defineContract, oc } from "kello/contract";
import * as v from "valibot";
const base = oc.errors({ UNAUTHORIZED: {} });
export default defineContract(({ validators }) => ({
  list: base
    .output(
      v.array(
        v.strictObject({
          _id: validators.id("tasks"),
          title: v.string(),
          done: v.boolean(),
        }),
      ),
    )
    .live(),
  create: base.input(validators.tables.tasks.command).output(validators.tables.tasks.public),
  greeting: base.input(v.strictObject({ name: v.pipe(v.string(), v.minLength(1)) })).output(v.string()),
}));
