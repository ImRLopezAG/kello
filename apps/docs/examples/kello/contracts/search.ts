import { defineContract, oc, searchErrors } from "kello/contract";
import { taskSearchPolicy } from "../search";

export default defineContract(({ validators }) => {
  const finite = validators.tables.tasks.search(taskSearchPolicy);
  const base = oc.errors(searchErrors);
  return {
    list: base.input(finite.input).output(finite.output),
  };
});
