import { expect, test } from "vite-plus/test";
import * as server from "../../../apps/kello/src/core/server/index";
import { call, os, Procedure } from "@orpc/server";
import type { AnyProcedure } from "@orpc/server";
import { defineRelations } from "drizzle-orm";
import type { AnyRelations } from "drizzle-orm";
import { pgTable, text } from "drizzle-orm/pg-core";
import * as v from "valibot";
import { carryLiveDependencies, getLiveDependencies } from "../../../apps/kello/src/core/server/rpc/live-dependencies";
import { createRpcAuthentication, defineRpcAuth } from "../../../apps/kello/src/core/server/auth/rpc-definition";
import { drizzle } from "drizzle-orm/node-postgres";
import type { DatabaseConnection } from "../../../apps/kello/src/core/server/database/connection";
import { bindRpcDatabaseProcedure } from "../../../apps/kello/src/core/server/rpc/database";
import { createDependencyRegistry } from "../../../apps/kello/src/core/server/realtime/dependencies";
import { bindRuntimeGraph } from "../../../apps/kello/src/core/server/rpc/runtime-graph";
import { createEffectRuntime } from "../../../apps/kello/src/core/server/effect/runtime";
import { createRevisionCoordinator } from "../../../apps/kello/src/core/server/realtime/coordinator";
import { Layer } from "effect";
import pg from "pg";

const bindingSchema = server.defineSchema((f) => ({ tasks: { title: f.text() }, permissions: { role: f.text() } }), {
  namespace: "binding_test",
});
const bindingGraph = defineRelations(bindingSchema.tables);
const bindingProject = server.createProjectProcedures(bindingSchema, bindingGraph);
const bindingBase = bindingProject.procedure.use(server.createDatabaseMiddleware(bindingGraph, "read", bindingSchema));
// Binding-only fixture: opening a transaction is an error; no database/provider access is performed.
const bindingPool = new pg.Pool();
const bindingConnection: DatabaseConnection<typeof bindingGraph> = {
  db: drizzle.mock({ relations: bindingGraph }),
  pool: bindingPool,
  transaction: async () => {
    throw new Error("Binding must not acquire a transaction");
  },
  close: () => bindingPool.end(),
};
const bindingRegistry = createDependencyRegistry("loom_binding", [{ scope: "", schema: bindingSchema }]);
const bindingOptions = {
  connection: bindingConnection,
  replay: { deployment: "binding-test", metadataNamespace: "loom_binding" },
  dependencies: { registry: bindingRegistry, authorization: [] },
  search: { branchId: "binding-test", key: "03".repeat(32) },
  authorize: async () => {},
};

test("binding rejects a foreign declaration graph even when all native tables are shared", () => {
  const foreign = defineRelations(bindingSchema.tables);
  for (const tables of [[], ["tasks"]] as const) {
    const procedure = server.withLiveDependencies(
      foreign,
      tables,
      bindingBase.handler(() => null),
    );
    expect(() => bindRpcDatabaseProcedure(procedure, bindingOptions)).toThrow(/graph/i);
    expect(() => bindRpcDatabaseProcedure(procedure, { ...bindingOptions, dependencies: undefined })).toThrow(/graph/i);
  }
});

test("generated search rejects a declaration for a same-table foreign graph without a database middleware", () => {
  const search = bindingProject.validators.tables.tasks.search({ columns: ["title"], scope: "public" });
  const procedure = server.withLiveDependencies(
    defineRelations(bindingSchema.tables),
    [],
    bindingProject.procedure
      .input(search.input)
      .output(search.output)
      .handler(() => {
        throw new Error("Not invoked");
      }),
  );
  expect(() => bindRpcDatabaseProcedure(procedure, bindingOptions)).toThrow(/graph/i);
});

test("database binding carries the declaration to its final native wrapper", () => {
  const procedure = server.withLiveDependencies(
    bindingGraph,
    [],
    bindingBase.handler(() => null),
  );
  const bound = bindRpcDatabaseProcedure(procedure, bindingOptions);
  expect(bound).toBeInstanceOf(Procedure);
  expect(bound).not.toBe(procedure);
  expect(getLiveDependencies(bound)).toBe(getLiveDependencies(procedure));
});

test("one authored procedure binds separately at two mounts and keeps final runtime declarations", async () => {
  const procedure = server.withLiveDependencies(
    bindingGraph,
    ["permissions"],
    bindingBase.handler(() => null),
  );
  const registry = createDependencyRegistry("loom_binding", [
    { scope: "", schema: bindingSchema },
    { scope: "left", schema: bindingSchema },
    { scope: "right", schema: bindingSchema },
  ]);
  const effects = createEffectRuntime(Layer.empty);
  const coordinator = createRevisionCoordinator({ intervalMs: 60000, readRevisions: async () => ({}) });
  const resolvedScopes: string[] = [];
  const observedRegistry = {
    ...registry,
    resolve: (scope: string, graph: AnyRelations | undefined, names: Iterable<string>) => {
      const localNames = [...names];
      if (localNames.includes("permissions")) resolvedScopes.push(scope);
      return registry.resolve(scope, graph, localNames);
    },
  };
  const runtime = bindRuntimeGraph({
    entries: [
      { scope: "left", visibility: "exported", path: ["read"], procedure },
      { scope: "right", visibility: "exported", path: ["read"], procedure },
    ],
    scopes: [
      { name: "", dependencies: {} },
      { name: "left", dependencies: {} },
      { name: "right", dependencies: {} },
    ],
    exposures: [
      { scope: "left", prefix: "left" },
      { scope: "right", prefix: "right" },
    ],
    database: { ...bindingOptions, dependencies: { registry: observedRegistry, authorization: [] } },
    effects,
    coordinator,
    activate: async () => {},
    authorize: async () => {},
  });
  const nativeRoute = v.object({ read: v.custom<AnyProcedure>((value) => value instanceof Procedure) });
  const left = v.parse(nativeRoute, runtime.router.left).read;
  const right = v.parse(nativeRoute, runtime.router.right).read;
  expect(left).not.toBe(right);
  expect(getLiveDependencies(left)).toBe(getLiveDependencies(procedure));
  expect(getLiveDependencies(right)).toBe(getLiveDependencies(procedure));
  expect(registry.resolve("left", bindingGraph, ["permissions"])).toEqual([
    JSON.stringify(["binding_test", "permissions"]),
  ]);
  expect(getLiveDependencies(procedure)?.graph).toBe(bindingGraph);
  expect(resolvedScopes).toEqual(["left", "right"]);
  await runtime.stop();
  await coordinator.stop();
  await effects.stop();
});

test("binding preserves omission and ignores procedure metadata pretending to declare dependencies", () => {
  const original = bindingBase.handler(() => null);
  const procedure = new Procedure({
    ...original["~orpc"],
    meta: { ...original["~orpc"].meta, liveDependencies: { graph: bindingGraph, tables: [] } },
  });
  const bound = bindRpcDatabaseProcedure(procedure, bindingOptions);
  expect(getLiveDependencies(procedure)).toBeUndefined();
  expect(getLiveDependencies(bound)).toBeUndefined();
});

test("bindings resolve local names for each native graph namespace without mutating declarations", () => {
  for (const namespace of ["binding_left", "binding_right"]) {
    const schema = server.defineSchema((f) => ({ tasks: { title: f.text() }, permissions: { role: f.text() } }), {
      namespace,
    });
    const graph = defineRelations(schema.tables);
    const project = server.createProjectProcedures(schema, graph);
    const base = project.procedure.use(server.createDatabaseMiddleware(graph, "read", schema));
    const procedure = server.withLiveDependencies(
      graph,
      ["permissions"],
      base.handler(() => null),
    );
    const registry = createDependencyRegistry("loom_binding", [{ scope: namespace, schema }]);
    const bound = bindRpcDatabaseProcedure(procedure, {
      ...bindingOptions,
      scope: namespace,
      dependencies: { registry, authorization: [] },
    });
    expect(getLiveDependencies(bound)).toBe(getLiveDependencies(procedure));
    const declaration = getLiveDependencies(bound);
    if (!declaration) throw new Error("Expected carried declaration");
    expect(registry.resolve(namespace, graph, declaration.tables)).toEqual([
      JSON.stringify([namespace, "permissions"]),
    ]);
    expect(getLiveDependencies(procedure)?.tables).toEqual(["permissions"]);
  }
});

test("server exports the procedure completeness helper", () => {
  expect(server).toHaveProperty("withLiveDependencies", expect.any(Function));
  expect(server).not.toHaveProperty("getLiveDependencies");
  expect(server).not.toHaveProperty("carryLiveDependencies");
});

const tasks = pgTable("tasks", { title: text().notNull() });
const permissions = pgTable("permissions", { role: text().notNull() });
const graph = defineRelations({ tasks, permissions });

test("wrapping preserves native identity and caller values with canonical frozen local names", async () => {
  const procedure = os
    .input(v.string())
    .output(v.string())
    .handler(({ input }) => input.toUpperCase());
  const tables: (keyof typeof graph)[] = ["tasks", "permissions", "tasks"];
  const wrapped = server.withLiveDependencies(graph, tables, procedure);
  tables.length = 0;
  expect(wrapped).toBe(procedure);
  expect(await call(wrapped, "hello")).toBe("HELLO");
  expect(getLiveDependencies(wrapped)).toEqual({ graph, tables: ["permissions", "tasks"] });
  expect(Object.isFrozen(getLiveDependencies(wrapped))).toBe(true);
  expect(Object.isFrozen(getLiveDependencies(wrapped)?.tables)).toBe(true);
  expect(Object.keys(wrapped)).toEqual(["~orpc"]);
});

test("equivalent redeclarations are allowed but changed tables or graph identity conflict", () => {
  const procedure = os.handler(() => null);
  server.withLiveDependencies(graph, ["tasks", "permissions"], procedure);
  expect(server.withLiveDependencies(graph, ["permissions", "tasks", "tasks"], procedure)).toBe(procedure);
  expect(() => server.withLiveDependencies(graph, [], procedure)).toThrow(/conflict/i);
  const foreignGraph = defineRelations({ tasks, permissions });
  expect(() => server.withLiveDependencies(foreignGraph, ["tasks", "permissions"], procedure)).toThrow(/conflict/i);
  expect(getLiveDependencies(procedure)?.graph).toBe(graph);
});

test("native derivations remain undeclared and canonical clones require explicit carry", () => {
  const source = server.withLiveDependencies(
    graph,
    [],
    os.handler(() => null),
  );
  const derived = source.use(({ next }) => next());
  const clone = new Procedure({ ...source["~orpc"] });
  expect(getLiveDependencies(derived)).toBeUndefined();
  expect(getLiveDependencies(clone)).toBeUndefined();
  carryLiveDependencies(source, clone);
  expect(getLiveDependencies(clone)).toBe(getLiveDependencies(source));
  expect(getLiveDependencies(source)?.tables).toEqual([]);
  carryLiveDependencies(source, clone);
  const undeclared = os.handler(() => null);
  carryLiveDependencies(undeclared, derived);
  expect(getLiveDependencies(derived)).toBeUndefined();
  const conflicting = server.withLiveDependencies(
    graph,
    ["permissions"],
    os.handler(() => null),
  );
  expect(() => carryLiveDependencies(source, conflicting)).toThrow(/conflict/i);
  expect(getLiveDependencies(conflicting)?.tables).toEqual(["permissions"]);
});

test("declarations reject nonnative graphs and tables, unknown names, and incomplete builders", () => {
  const procedure = os.handler(() => null);
  // @ts-expect-error malformed JavaScript authoring is rejected at runtime
  expect(() => server.withLiveDependencies(null, [], procedure)).toThrow(/relations/i);
  const invalidGraph = { tasks: { ...graph.tasks, table: {} } };
  // @ts-expect-error nonnative table supplied by JavaScript authoring
  expect(() => server.withLiveDependencies(invalidGraph, ["tasks"], procedure)).toThrow(/relations/i);
  expect(() =>
    // @ts-expect-error unknown graph name is intentionally rejected
    server.withLiveDependencies(graph, ["typo"], procedure),
  ).toThrow(/table/i);
  expect(() =>
    // @ts-expect-error inherited property is not a graph name
    server.withLiveDependencies(graph, ["toString"], procedure),
  ).toThrow(/table/i);
  for (const candidate of [os.input(v.string()), {}, null]) {
    // @ts-expect-error incomplete and nonnative procedures are intentionally rejected
    expect(() => server.withLiveDependencies(graph, [], candidate)).toThrow(/completed/i);
  }
  expect(getLiveDependencies(procedure)).toBeUndefined();
});

test("procedure dependency lists reject malformed runtime input", () => {
  const procedure = os.handler(() => null);
  const sparse: string[] = [];
  sparse.length = 2;
  sparse[1] = "tasks";
  for (const dependencies of ["tasks", null, [42], sparse]) {
    expect(() =>
      // @ts-expect-error malformed JavaScript declaration boundary
      server.withLiveDependencies(graph, dependencies, procedure),
    ).toThrow();
  }
  expect(getLiveDependencies(procedure)).toBeUndefined();
});

test("auth distinguishes absent and empty declarations and rejects malformed lists", () => {
  const omitted = defineRpcAuth({ authorize: () => {} });
  const empty = defineRpcAuth({ authorize: () => {}, dependencies: [] });
  expect(omitted).not.toHaveProperty("dependencies");
  expect(createRpcAuthentication({}, omitted)).not.toHaveProperty("dependencies");
  expect(createRpcAuthentication({}, empty).dependencies).toEqual([]);
  expect(Object.isFrozen(empty.dependencies)).toBe(true);
  const sparse: string[] = [];
  sparse.length = 2;
  sparse[1] = "permissions";
  for (const dependencies of [null, "permissions", [42], sparse]) {
    expect(() =>
      // @ts-expect-error malformed JavaScript authorization declaration boundary
      defineRpcAuth({ authorize: () => {}, dependencies }),
    ).toThrow();
  }
});

test("auth completeness declarations survive runtime authentication construction", () => {
  const dependencies = ["permissions"];
  const definition = defineRpcAuth({ authorize: () => {}, dependencies });
  dependencies.push("changed");
  const auth = createRpcAuthentication({}, definition);
  expect(auth.dependencies).toEqual(["permissions"]);
  expect(Object.isFrozen(auth.dependencies)).toBe(true);
  expect(auth.dependencies).toBe(definition.dependencies);
});
