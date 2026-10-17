import { defineContract, oc } from "../_generated/contract";
import { z } from "zod";
const entry = z.object({ _id: z.uuid(), text: z.string() });
const base = oc.errors({ UNAUTHORIZED: {}, REJECTED: { message: "Could not save entry" } });
export default defineContract({
  list: base.output(z.array(entry)),
  add: base.input(z.object({ text: z.string().trim().min(1).max(200) })).output(entry),
  watch: base.output(z.array(entry)).live(),
});
