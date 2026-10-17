import { defineContract, oc } from "kello/contract";
import { Schema } from "effect";
import * as v from "valibot";
import { z } from "zod";
const base = oc.errors({ UNAUTHORIZED: {}, REJECTED: { message: "Choose another name" } });
const input = z.object({ name: z.string().trim().min(1).max(80) });
const greeting = z.object({ message: z.string(), owner: z.string() });
const note = z.object({ _id: z.uuid(), text: z.string() });
export default defineContract({
  zod: base.input(input).output(greeting),
  mixed: base.input(input).output(v.object({ message: v.string(), owner: v.string() })),
  effect: base.input(input).output(greeting),
  effectSchema: base.input(Schema.toStandardSchemaV1(Schema.Struct({ name: Schema.String }))).output(greeting),
  notes: base.output(z.array(note)),
  add: base.input(z.object({ text: z.string().trim().min(1).max(200) })).output(note),
  watch: base.output(v.array(v.object({ _id: v.pipe(v.string(), v.uuid()), text: v.string() }))).live(),
});
