import * as v from "valibot";
import { createProjectProcedures, defineSchema, defineJobMigration } from "kello/server";

const { procedure } = createProjectProcedures(defineSchema(() => ({})));
const target = procedure.input(v.strictObject({ count: v.number() })).handler(() => null);
const from = {
  protocol: "kello-legacy-1" as const,
  version: "a".repeat(64),
  name: "jobs:run",
  kind: "action" as const,
};
defineJobMigration({
  from,
  input: v.strictObject({ value: v.string() }),
  to: target,
  transform: (input) => ({ count: Number(input.value) }),
});
defineJobMigration({
  from,
  input: v.strictObject({ value: v.string() }),
  to: target,
  // @ts-expect-error target input is inferred from the procedure, not widened by the converter
  transform: (input) => ({ count: input.value }),
});
defineJobMigration({
  from,
  input: v.strictObject({ value: v.string() }),
  to: target,
  // @ts-expect-error the old input contract supplies the converter parameter type
  transform: (input: { value: number }) => ({ count: input.value }),
});
