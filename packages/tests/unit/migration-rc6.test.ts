import { glob, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "vite-plus/test";
import { generateDrizzleJson } from "drizzle-kit/api-postgres";
import { index, pgSchema, text, uniqueIndex } from "drizzle-orm/pg-core";
import * as v from "valibot";
import { fromDrizzleSnapshot } from "../../../apps/kello-cli/src/tooling/migrations/snapshot";
import { planValidator, validateMigration } from "../../../apps/kello-cli/src/tooling/migrations/history";

const examples = resolve(import.meta.dirname, "../../examples");

test("RC6 preserves every committed example migration hash and safety classification", async () => {
  const paths = [];
  for await (const path of glob("**/plan.json", { cwd: examples })) paths.push(path);
  expect(paths).toHaveLength(8);
  for (const path of paths) {
    const plan = v.parse(planValidator, JSON.parse(await readFile(resolve(examples, path), "utf8")));
    await expect(validateMigration(plan)).resolves.toBeUndefined();
    expect(path).toContain(plan.hash);
  }
});

test("native v10 snapshots are validated before conversion into Kello's persisted format", async () => {
  const tasks = pgSchema("app").table("tasks", { title: text().notNull(), slug: text().notNull() }, (table) => [
    index("tasks_title_idx").on(table.title),
    uniqueIndex("tasks_slug_idx").on(table.slug),
  ]);
  const native = await generateDrizzleJson({ tasks });
  const before = JSON.stringify(native);
  expect(native.version).toBe("10");
  const nativeIndexes = native.ddl.filter((entity) => entity.entityType === "indexes");
  expect(nativeIndexes).toHaveLength(2);
  for (const entity of nativeIndexes) expect(entity).not.toHaveProperty("concurrently");
  const converted = fromDrizzleSnapshot(native);
  expect(converted).toEqual({
    ...native,
    version: "8",
    renames: [],
    ddl: native.ddl.map((entity) => (entity.entityType === "indexes" ? { ...entity, concurrently: false } : entity)),
  });
  expect(JSON.stringify(native)).toBe(before);
  expect(() => fromDrizzleSnapshot({ ...native, version: "9" })).toThrow();
  expect(() => fromDrizzleSnapshot({ ...native, unexpected: true })).toThrow();
  expect(() => fromDrizzleSnapshot({ ...native, ddl: [...native.ddl, { entityType: "policies" }] })).toThrow();
  const [first] = nativeIndexes;
  expect(() =>
    fromDrizzleSnapshot({
      ...native,
      ddl: native.ddl.map((entity) => (entity === first ? { ...entity, concurrently: true } : entity)),
    }),
  ).toThrow();
});
