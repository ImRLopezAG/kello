import { glob, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "vite-plus/test";
import { generateDrizzleJson } from "drizzle-kit/api-postgres";
import { pgSchema, text } from "drizzle-orm/pg-core";
import * as v from "valibot";
import { fromDrizzleSnapshot } from "../../../apps/kello-cli/src/tooling/migrations/snapshot";
import { planValidator, validateMigration } from "../../../apps/kello-cli/src/tooling/migrations/history";

const examples = resolve(import.meta.dirname, "../../examples");

test("RC5 preserves every committed example migration hash and safety classification", async () => {
  const paths = [];
  for await (const path of glob("**/plan.json", { cwd: examples })) paths.push(path);
  expect(paths).toHaveLength(8);
  for (const path of paths) {
    const plan = v.parse(planValidator, JSON.parse(await readFile(resolve(examples, path), "utf8")));
    await expect(validateMigration(plan)).resolves.toBeUndefined();
    expect(path).toContain(plan.hash);
  }
});

test("native v9 snapshots are validated before conversion into Kello's persisted format", async () => {
  const tasks = pgSchema("app").table("tasks", { title: text().notNull() });
  const native = await generateDrizzleJson({ tasks });
  const before = JSON.stringify(native);
  expect(native.version).toBe("9");
  const converted = fromDrizzleSnapshot(native);
  expect(converted).toEqual({ ...native, version: "8", renames: [] });
  expect(JSON.stringify(native)).toBe(before);
  expect(() => fromDrizzleSnapshot({ ...native, version: "10" })).toThrow();
  expect(() => fromDrizzleSnapshot({ ...native, unexpected: true })).toThrow();
  expect(() => fromDrizzleSnapshot({ ...native, ddl: [...native.ddl, { entityType: "policies" }] })).toThrow();
});
