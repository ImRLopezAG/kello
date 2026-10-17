import { defineContract, oc } from "kello/contract";
import * as v from "valibot";
const base = oc.errors({ UNAUTHORIZED: {}, REJECTED: { message: "Could not create note" } });
const note = v.object({ _id: v.pipe(v.string(), v.uuid()), text: v.string() });
export default defineContract({
  greeting: base
    .input(v.object({ name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(80)) }))
    .output(v.object({ message: v.string(), owner: v.string() })),
  notes: base.output(v.array(note)),
  add: base.input(v.object({ text: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200)) })).output(note),
  watch: base.output(v.array(note)).live(),
});
