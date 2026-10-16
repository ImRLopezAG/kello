import { expect, test, vi } from "vite-plus/test";
import { defineRelations } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { DatabaseSchema } from "../../../apps/loom/src/core/server/database/connection";
import * as relations from "../../../apps/loom/src/core/server/database/relations";
import { defineSchema } from "../../../apps/loom/src/core/schema/define-schema";
import { createDependencyRegistry } from "../../../apps/loom/src/core/server/realtime/dependencies";
import { createRevisionReader } from "../../../apps/loom/src/core/server/realtime/revisions";

test("registry resolves logical names to qualified physical keys across mounts", () => {
  const root = defineSchema((f) => ({ taskItems: { title: f.text() } }), { namespace: "app_root" });
  const child = defineSchema((f) => ({ taskItems: { title: f.text() } }), { namespace: "app_child" });
  const sibling = defineSchema((f) => ({ taskItems: { title: f.text() } }), { namespace: "app_sibling" });
  const graph = defineRelations(root.tables);
  const childGraph = defineRelations(child.tables);
  const siblingGraph = defineRelations(sibling.tables);
  const registry = createDependencyRegistry("loom_test", [
    { scope: "", schema: root },
    { scope: "child", schema: child },
    { scope: "sibling", schema: sibling },
  ]);
  expect(registry.resolve("", graph, ["taskItems", "taskItems"])).toEqual([JSON.stringify(["app_root", "task_items"])]);
  expect(registry.keys).toEqual([
    JSON.stringify(["app_child", "task_items"]),
    JSON.stringify(["app_root", "task_items"]),
    JSON.stringify(["app_sibling", "task_items"]),
  ]);
  expect(registry.resolve("child", childGraph, ["taskItems"])).toEqual([JSON.stringify(["app_child", "task_items"])]);
  expect(registry.resolve("sibling", siblingGraph, ["taskItems"])).toEqual([
    JSON.stringify(["app_sibling", "task_items"]),
  ]);
  expect(() => registry.resolve("child", graph, ["taskItems"])).toThrow();
  expect(() => registry.resolve("", graph, ["task_items"])).toThrow();
  expect(() => registry.resolve("missing", graph, [])).toThrow();
});

test("registry canonicalizes sorted dependencies and shared physical identities", () => {
  const schema = defineSchema((f) => ({ zItems: { title: f.text() }, aItems: { title: f.text() } }));
  const graph = defineRelations(schema.tables);
  const registry = createDependencyRegistry("loom_test", [
    { scope: "", schema },
    { scope: "alias", schema },
  ]);
  expect(registry.keys).toEqual(['["public","a_items"]', '["public","z_items"]']);
  expect(registry.resolve("alias", graph, ["zItems", "aItems", "zItems"])).toEqual(registry.keys);
  expect(Object.isFrozen(registry)).toBe(true);
  expect(Object.isFrozen(registry.keys)).toBe(true);
  expect(Object.keys(registry)).toEqual(["keys", "resolve", "read"]);
});

test("registry rejects duplicate scopes and ambiguous logical names", () => {
  const schema = defineSchema((f) => ({ taskItems: { title: f.text() }, otherItems: { title: f.text() } }));
  expect(() =>
    createDependencyRegistry("loom_test", [
      { scope: "", schema },
      { scope: "", schema },
    ]),
  ).toThrow(/Duplicate dependency scope/);
  const ambiguous = {
    ...schema,
    metadata: {
      ...schema.metadata,
      entities: [
        ...schema.metadata.entities.filter((entity) => entity.name === "taskItems"),
        ...schema.metadata.entities
          .filter((entity) => entity.name !== "taskItems")
          .map((entity) => ({ ...entity, name: "taskItems" })),
      ],
    },
  };
  expect(() => createDependencyRegistry("loom_test", [{ scope: "", schema: ambiguous }])).toThrow(/Ambiguous/);
});

test("registry checks physical table identity against schema metadata", () => {
  const schema = defineSchema((f) => ({ taskItems: { title: f.text() } }));
  const mismatched = {
    ...schema,
    metadata: {
      ...schema.metadata,
      entities: schema.metadata.entities.map((entity) => ({ ...entity, sqlName: "other_items" })),
    },
  };
  expect(() => createDependencyRegistry("loom_test", [{ scope: "", schema: mismatched }])).toThrow();
});

function manyTables(count: number, offset = 0, namespace = "public") {
  return defineSchema(
    (f) =>
      Object.fromEntries(Array.from({ length: count }, (_, index) => [`item${offset + index}`, { title: f.text() }])),
    { namespace },
  );
}

test("1000-table budget applies to the deduplicated physical namespace across all scopes", () => {
  const first = manyTables(500);
  const second = manyTables(500, 500);
  const scopes = [
    { scope: "", schema: first },
    { scope: "child", schema: second },
  ];
  expect(createDependencyRegistry("loom_test", [...scopes, { scope: "alias", schema: first }]).keys).toHaveLength(1000);
  expect(() =>
    createDependencyRegistry("loom_test", [...scopes, { scope: "extra", schema: manyTables(1, 1000) }]),
  ).toThrow();
  expect(() => createDependencyRegistry("loom_test", [{ scope: "", schema: manyTables(1001) }])).toThrow();
  expect(
    createDependencyRegistry("loom_test", [
      ...scopes,
      { scope: "separate", schema: manyTables(1, 1000, "app_separate") },
    ]).keys,
  ).toHaveLength(1001);
});

test("empty scope resolves and reads without constructing an empty revision reader", async () => {
  const schema = defineSchema(() => ({}));
  const graph = defineRelations(schema.tables);
  const registry = createDependencyRegistry("loom_test", [{ scope: "", schema }]);
  const db = drizzle.mock();
  const execute = vi.spyOn(db, "execute");
  expect(registry.keys).toEqual([]);
  expect(registry.resolve("", graph, [])).toEqual([]);
  expect(await registry.read(db)).toEqual({});
  expect(execute).not.toHaveBeenCalled();
});

test("graph validation is generation/scope owned and notices mutation after a successful resolve", () => {
  const schema = defineSchema((f) => ({ taskItems: { title: f.text() } }));
  const graph = defineRelations(schema.tables);
  const validate = vi.spyOn(relations, "validateSchemaRelations");
  try {
    const registry = createDependencyRegistry("loom_test", [
      { scope: "", schema },
      { scope: "alias", schema },
    ]);
    registry.resolve("", graph, ["taskItems"]);
    const calls = validate.mock.calls.length;
    registry.resolve("", graph, ["taskItems"]);
    expect(validate).toHaveBeenCalledTimes(calls);
    registry.resolve("alias", graph, ["taskItems"]);
    expect(validate).toHaveBeenCalledTimes(calls + 1);
    createDependencyRegistry("loom_test", [{ scope: "", schema }]).resolve("", graph, []);
    expect(validate.mock.calls.length).toBeGreaterThan(calls + 1);
    const foreign = defineSchema((f) => ({ taskItems: { title: f.text() } }));
    graph.taskItems.table = foreign.tables.taskItems;
    expect(() => registry.resolve("", graph, [])).toThrow(/compiled table/);
    expect(() => registry.resolve("", graph, [])).toThrow(/compiled table/);
    graph.taskItems.table = schema.tables.taskItems;
    expect(registry.resolve("", graph, ["taskItems"])).toEqual(['["public","task_items"]']);
  } finally {
    validate.mockRestore();
  }
});

test("cached validation rejects changed relation targets and added graph tables", () => {
  const schema = defineSchema((f) => ({
    tasks: { projectId: f.reference("projects") },
    projects: { title: f.text() },
  }));
  const graph = defineRelations(schema.tables, (r) => ({
    tasks: { project: r.one.projects({ from: r.tasks.projectId, to: r.projects._id }) },
  }));
  const registry = createDependencyRegistry("loom_test", [{ scope: "", schema }]);
  registry.resolve("", graph, ["tasks"]);
  const foreign = defineSchema((f) => ({ projects: { title: f.text() } }));
  graph.tasks.relations.project.targetTable = foreign.tables.projects;
  expect(() => registry.resolve("", graph, [])).toThrow(/target is outside schema/);
  graph.tasks.relations.project.targetTable = schema.tables.projects;
  expect(registry.resolve("", graph, [])).toEqual([]);
  Object.assign(graph, { foreign: defineRelations(foreign.tables).projects });
  expect(() => registry.resolve("", graph, [])).toThrow(/compiled table/);
});

function revisionDatabase(rows: { table_name: string; revision: string }[]) {
  const db = drizzle.mock();
  const nativeExecute = db.execute.bind(db);
  const execute = vi.spyOn(db, "execute").mockImplementation((query) => {
    const result = nativeExecute(query);
    vi.spyOn(result, "execute").mockResolvedValue({
      command: "SELECT",
      rowCount: rows.length,
      oid: 0,
      fields: [],
      rows,
    });
    return result;
  });
  return { db, execute };
}

test("selected reads group/deduplicate namespaces and retain exact decimal strings", async () => {
  const root = defineSchema((f) => ({ taskItems: { title: f.text() } }), { namespace: "app_root" });
  const child = defineSchema((f) => ({ taskItems: { title: f.text() } }), { namespace: "app_child" });
  const registry = createDependencyRegistry("loom_test", [
    { scope: "", schema: root },
    { scope: "child", schema: child },
  ]);
  const decimal = "9223372036854775807";
  const { db, execute } = revisionDatabase([{ table_name: "task_items", revision: decimal }]);
  expect(await registry.read(db, [...registry.keys, ...registry.keys])).toEqual({
    '["app_child","task_items"]': decimal,
    '["app_root","task_items"]': decimal,
  });
  expect(execute).toHaveBeenCalledTimes(2);
  execute.mockClear();
  const selected = await registry.read(db, ['["app_child","task_items"]']);
  expect(selected).toEqual({ '["app_child","task_items"]': decimal });
  expect(selected).not.toHaveProperty('["app_root","task_items"]');
  expect(Object.isFrozen(selected)).toBe(true);
  expect(execute).toHaveBeenCalledTimes(1);
  expect(await registry.read(db, [])).toEqual({});
  await expect(registry.read(db, ['["missing","task_items"]'])).rejects.toThrow(/Unknown qualified/);
});

test("missing rows remain errors through the registry and the public reader stays unqualified", async () => {
  const schema: DatabaseSchema = defineSchema((f) => ({ taskItems: { title: f.text() } }));
  const registry = createDependencyRegistry("loom_test", [{ scope: "", schema }]);
  const missing = revisionDatabase([]);
  await expect(registry.read(missing.db)).rejects.toThrow(/Missing tracked table revision/);
  const decimal = "9007199254740993";
  const present = revisionDatabase([{ table_name: "task_items", revision: decimal }]);
  const reader = createRevisionReader({ namespace: "public", metadataNamespace: "loom_test", tables: ["task_items"] });
  expect(await reader(present.db)).toEqual({ task_items: decimal });
});
