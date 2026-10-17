import { defineContract, oc } from "kello/contract";
import * as v from "valibot";
const base = oc.errors({ UNAUTHORIZED: {}, FORBIDDEN: {} });
export default defineContract(({ validators }) => {
  const project = v.strictObject({ _id: validators.id("projects"), name: v.string() });
  return {
    list: base.input(v.strictObject({})).output(v.array(project)).live(),
    create: base.input(validators.tables.projects.insert).output(project),
  };
});
