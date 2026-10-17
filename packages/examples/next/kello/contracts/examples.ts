import { defineContract, oc } from "kello/contract";
import { z } from "zod";
const base = oc.errors({ UNAUTHORIZED: {}, REJECTED: { message: "Could not create note" } });
const note = z.object({ _id: z.uuid(), text: z.string() });
export default defineContract({
  greeting: base
    .input(z.object({ name: z.string().trim().min(1).max(80) }))
    .output(z.object({ message: z.string(), owner: z.string() })),
  notes: base.output(z.array(note)),
  watch: base.output(z.array(note)).live(),
  add: base.input(z.object({ text: z.string().trim().min(1).max(200) })).output(note),
});
