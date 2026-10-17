import { defineContract, oc } from "kello/contract";
import * as v from "valibot";
const entry = v.object({ _id: v.pipe(v.string(), v.uuid()), text: v.string() });
const base = oc.errors({ UNAUTHORIZED: {}, REJECTED: { message: "Could not save entry" } });
export default defineContract({
  list: base.output(v.array(entry)),
  add: base.input(v.object({ text: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200)) })).output(entry),
  watch: base.output(v.array(entry)).live(),
});
