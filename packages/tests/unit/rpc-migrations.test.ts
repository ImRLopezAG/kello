import { expect, test } from "vite-plus/test";
import * as v from "valibot";
import {
  defineSchema,
  createProjectProcedures,
  defineJobMigration,
  compileJobMigrations,
  encodeRpcJobCall,
  decodeRpcJobInput,
} from "kello/server";

test("migration validates both contracts without running procedure effects", async () => {
  const { procedure } = createProjectProcedures(defineSchema(() => ({})));
  let executions = 0;
  const target = procedure
    .input(v.strictObject({ count: v.pipe(v.number(), v.minValue(1)) }))
    .use(async ({ next }) => {
      executions++;
      return next();
    })
    .handler(() => {
      executions++;
      return null;
    });
  const from = {
    protocol: "kello-legacy-1" as const,
    version: "a".repeat(64),
    name: "jobs:run",
    kind: "action" as const,
  };
  const migration = defineJobMigration({
    from,
    input: v.strictObject({ value: v.number() }),
    to: target,
    transform: (input) => ({ count: input.value }),
  });
  const options = {
    version: "b".repeat(64),
    internal: [{ path: ["jobs", "run"], procedure: target }],
    migrations: [migration],
  };
  const compiled = compileJobMigrations(options);
  const original = { version: from.version, name: from.name, kind: from.kind, args: { value: 2 } };
  expect(decodeRpcJobInput(await compiled.resolve(original))).toEqual({ count: 2 });
  expect(original.args).toEqual({ value: 2 });
  await expect(compiled.resolve({ ...original, args: { value: "wrong" } })).rejects.toThrow("migration schema");
  await expect(compiled.resolve({ ...original, args: { value: 0 } })).rejects.toThrow();
  await expect(compiled.resolve(encodeRpcJobCall(options.version, ["jobs", "run"], { count: 0 }))).rejects.toThrow();
  expect(executions).toBe(0);
  expect(() => compileJobMigrations({ ...options, internal: [] })).toThrow("registered internal");
  expect(() => compileJobMigrations({ ...options, migrations: [migration, migration] })).toThrow("Duplicate");
  await expect(compileJobMigrations({ ...options, migrations: [] }).resolve(original)).rejects.toThrow(
    "explicit migration",
  );
});

test("native migration matches the complete old route and preserves rich inputs", async () => {
  const { procedure } = createProjectProcedures(defineSchema(() => ({})));
  const target = procedure.input(v.strictObject({ at: v.date(), count: v.bigint() })).handler(() => null);
  const from = { protocol: "kello-orpc-2" as const, version: "a".repeat(64), path: ["old", "run"] };
  const migration = defineJobMigration({
    from,
    input: v.strictObject({ at: v.date() }),
    to: target,
    transform: (input) => ({ at: input.at, count: 1n }),
  });
  from.path[0] = "changed";
  const compiled = compileJobMigrations({
    version: "b".repeat(64),
    internal: [{ path: ["new", "run"], procedure: target }],
    migrations: [migration],
  });
  const original = encodeRpcJobCall(from.version, ["old", "run"], { at: new Date(0) });
  const converted = await compiled.resolve(original);
  expect(converted.path).toEqual(["new", "run"]);
  expect(decodeRpcJobInput(converted)).toEqual({ at: new Date(0), count: 1n });
  await expect(
    compiled.resolve(encodeRpcJobCall(from.version, ["different", "run"], { at: new Date(0) })),
  ).rejects.toThrow("explicit migration");
});
