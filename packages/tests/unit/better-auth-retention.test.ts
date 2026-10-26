import { expect, test } from "vite-plus/test";
import { compileBetterAuthSchema } from "kello/better-auth";
import { createNativeSnapshot, emptySnapshot, planMigration } from "kello-cli";
import { organization } from "better-auth/plugins";

function native(options: Parameters<typeof compileBetterAuthSchema>[0]) {
  const schema = compileBetterAuthSchema(options, "auth_retention");
  return { namespace: schema.namespace, tables: schema.ownedTables, retainRemoved: true };
}

test("plugin removal retains tables and re-addition emits no destructive SQL", async () => {
  const initial = await createNativeSnapshot(native({ plugins: [organization()] }));
  const removed = await planMigration(initial, native({}));
  expect(removed.statements).toEqual([]);
  expect(removed.after).toBe(removed.before);
  const restored = await planMigration(removed.snapshot, native({ plugins: [organization()] }));
  expect(restored.statements).toEqual([]);
});

test("nullable removed fields survive and incompatible required fields block activation", async () => {
  const optional = await createNativeSnapshot(
    native({ user: { additionalFields: { nickname: { type: "string", required: false } } } }),
  );
  expect((await planMigration(optional, native({}))).statements).toEqual([]);
  const required = await createNativeSnapshot(
    native({ user: { additionalFields: { requiredValue: { type: "string" } } } }),
  );
  await expect(planMigration(required, native({}))).rejects.toThrow("retained required column");
});

test("auth changes still receive the existing migration safety classification", async () => {
  const initial = await planMigration(
    await emptySnapshot("auth_retention"),
    native({ user: { additionalFields: { value: { type: "string", required: false } } } }),
  );
  expect(initial.statements.some((sql) => sql.includes("CREATE TABLE"))).toBe(true);
  const changed = await planMigration(
    initial.snapshot,
    native({ user: { additionalFields: { value: { type: "number", required: false } } } }),
  );
  expect(changed.safety.automatic).toBe(false);
});
