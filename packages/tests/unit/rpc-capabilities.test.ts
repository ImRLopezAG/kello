import { expect, test } from "vite-plus/test";
import * as v from "valibot";
import {
  defineSchema,
  createProjectProcedures,
  procedureCron,
  procedureObjectCreated,
  defineProcedureStorage,
  compileProcedureCapabilities,
  storageObjectCreatedValidator,
  decodeRpcJobInput,
} from "kello/server";

test("durable declarations capture inputs and reject public or ambiguous procedure targets", () => {
  const { procedure } = createProjectProcedures(defineSchema(() => ({})));
  const task = procedure.input(v.object({ at: v.date() })).handler(() => null);
  const event = procedure.input(storageObjectCreatedValidator).handler(() => null);
  const input = { at: new Date(0) };
  const cron = procedureCron("* * * * *", task, input, { maxAttempts: 2 });
  input.at.setFullYear(2030);
  const storage = defineProcedureStorage({ buckets: { uploads: { onObjectCreated: procedureObjectCreated(event) } } });
  const options = {
    version: "a".repeat(64),
    internal: [
      { path: ["task"], procedure: task },
      { path: ["event"], procedure: event },
    ],
    crons: { minute: cron },
    storage,
    maxAttempts: 2,
  };
  const compiled = compileProcedureCapabilities(options);
  expect(decodeRpcJobInput(compiled.crons.minute!.call)).toEqual({ at: new Date(0) });
  expect(compiled.handlers.uploads?.path).toEqual(["event"]);
  expect(() => compileProcedureCapabilities({ ...options, internal: [] })).toThrow("registered internal");
  expect(() =>
    compileProcedureCapabilities({ ...options, internal: [...options.internal, { path: ["alias"], procedure: task }] }),
  ).toThrow("multiple paths");
  expect(() => compileProcedureCapabilities({ ...options, maxAttempts: 1 })).toThrow("configured attempts");
});
