import { describe, expect, it } from "vite-plus/test";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { PgDialect } from "drizzle-orm/pg-core";
import { createProjectContext } from "../../../apps/loom/src/core/server/index";
import { oc } from "../../../apps/loom/src/core/contract/index";
import { searchSchema, searchRelations, nestedSelection } from "../fixtures/search-schema";
import { searchContractDescriptor } from "../../../apps/loom/src/core/search/metadata";
import { prepareSearchPage } from "../../../apps/loom/src/core/search/pagination";
import { compileSearch } from "../../../apps/loom/src/core/search/compiler";
import type { SearchScope } from "../../../apps/loom/src/core/search/types";

const { validators } = createProjectContext(searchSchema, searchRelations);
const search = validators.tables.tasks.search({
  scope: { name: "task", version: "1", where: ({ table }) => eq(table.done, false) },
  columns: ["title", "done", "at", "count", "amount", "_id"],
  filter: ["title", "done", "projectId", "at", "count", "amount"],
  text: ["title"],
  order: ["title"],
  through: { taskLabels: { name: "junction", version: "1", where: ({ table }) => sql`${table._createdAt} > ${0}` } },
  relations: {
    labels: {
      scope: { name: "label", version: "1", where: ({ table }) => eq(table.name, "allowed") },
      columns: ["name"],
      filter: ["name"],
      text: ["name"],
    },
    project: {
      scope: "public",
      columns: ["name"],
      filter: ["name"],
      relations: {
        organization: {
          scope: "public",
          columns: ["name"],
          relations: {
            teams: {
              scope: "public",
              columns: ["name"],
              relations: {
                members: { scope: "public", columns: ["name"] },
              },
            },
          },
        },
      },
    },
  },
});
const descriptor = searchContractDescriptor(oc.input(search.input).output(search.output));
if (!descriptor) throw new Error("Missing search descriptor");
const db = drizzle.mock({ relations: searchRelations });

describe("authorized native search compilation", () => {
  it.each([
    ["contains", "%\\%\\_\\\\%"],
    ["startsWith", "\\%\\_\\\\%"],
    ["endsWith", "%\\%\\_\\\\"],
  ] as const)("escapes literal percent, underscore and backslash for %s", (operator, pattern) => {
    for (const insensitive of [false, true]) {
      const compiled = compileSearch(
        descriptor,
        { columns: { title: true }, where: { title: { [operator]: "%_\\", insensitive } } },
        null,
      );
      const query = new PgDialect().sqlToQuery(compiled.where(searchSchema.tables.tasks));
      expect(query.params).toEqual([false, pattern]);
      expect(query.sql).toContain(` ${insensitive ? "ilike" : "like"} $2 escape '\\'`);
    }
  });
  it("keeps root authorization outside client NOT for rows and count", () => {
    const compiled = compileSearch(descriptor, { where: { NOT: { done: { eq: true } } } }, null);
    const dialect = new PgDialect();
    const countPredicate = dialect.sqlToQuery(compiled.where(searchSchema.tables.tasks));
    const rowPredicate = dialect.sqlToQuery(compiled.config.where.RAW(searchSchema.tables.tasks));
    expect(rowPredicate).toEqual(countPredicate);
    expect(countPredicate.params).toEqual([false, true]);
    expect(countPredicate.sql).toMatch(/"done" = \$1\) and \(not \(/);
    expect(countPredicate.sql.slice(countPredicate.sql.indexOf("not ("))).not.toContain("$1");
  });
  it("projects exactly selected root and child fields without adding ordering or join keys", () => {
    const compiled = compileSearch(
      descriptor,
      {
        columns: { title: true },
        orderBy: [{ field: "title", direction: "desc" }],
        with: { labels: { columns: { name: true } }, project: { columns: { name: true } } },
      },
      null,
    );
    expect(compiled.config.columns).toEqual({ title: true });
    expect(Object.keys(compiled.config.with)).toEqual(["labels", "project"]);
    expect(compiled.config.with.labels?.columns).toEqual({ name: true });
    expect(compiled.config.with.project?.columns).toEqual({ name: true });
    expect(compiled.config.with.labels?.with).toEqual({});
    expect(compiled.config.with.project?.with).toEqual({});
  });
  it("parameterizes values and uses existential M2M membership without duplicating roots", () => {
    const compiled = compileSearch(
      descriptor,
      {
        columns: { title: true },
        where: {
          title: { contains: "%' OR 1=1 --_\\", insensitive: true },
          relations: { labels: { some: { name: { eq: "allowed" } }, none: { name: { eq: "forbidden" } } } },
        },
      },
      null,
    );
    const query = db.query.tasks.findMany(compiled.config).toSQL();
    expect(query.sql).toContain("exists (select 1");
    expect(query.sql).toContain("not (exists");
    expect(query.sql).not.toContain("OR 1=1");
    expect(query.params).toContain("%\\%' OR 1=1 --\\_\\\\%");
    expect(query.params.filter((value) => value === "allowed").length).toBeGreaterThanOrEqual(2);
    expect(query.sql).toContain('"task_labels"');
    expect(query.sql).not.toContain("distinct");
    expect(compiled.dependencies).toEqual(new Set(["tasks", "labels", "taskLabels"]));
  });
  it("keeps nested filters out of root membership and applies the native junction scope", () => {
    const compiled = compileSearch(
      descriptor,
      {
        columns: { title: true },
        with: { labels: { columns: { name: true }, where: { name: { eq: "other" } }, limit: 2 } },
      },
      null,
    );
    const query = db.query.tasks.findMany(compiled.config).toSQL();
    expect(query.sql).toContain('"tr0"."_createdAt"');
    expect(query.sql).toContain("left join lateral");
    expect(query.params).toContain("other");
    expect(query.params).toContain("allowed");
    expect(query.sql.slice(query.sql.lastIndexOf("where"))).not.toContain("other");
    expect(query.sql).not.toContain("exists (select 1");
  });
  it("compiles all boolean/scalar operators and four relation edges in one native statement", () => {
    const compiled = compileSearch(
      descriptor,
      {
        ...nestedSelection,
        columns: { at: true, count: true, amount: true },
        where: {
          AND: [
            { title: { eq: "A", ne: "B", in: ["A", "C"], notIn: ["B"], startsWith: "A", endsWith: "C" } },
            { done: { eq: false } },
          ],
          OR: [{ amount: { gt: "1.0000000001", gte: "1", lt: "10", lte: "9" } }, { projectId: { isNull: false } }],
          NOT: { count: { eq: 9007199254740993n } },
          at: { gte: new Date("2026-01-01") },
        },
      },
      null,
    );
    const query = db.query.tasks.findMany(compiled.config).toSQL();
    expect(query.sql.match(/left join lateral/g)).toHaveLength(5);
    expect(query.params).toContain(9007199254740993n);
    expect(query.params).toContain("1.0000000001");
    expect(query.sql).not.toContain('"projectId" as');
    expect(compiled.dependencies).toEqual(new Set(Object.keys(searchRelations)));
  });
  it("rejects invalid fields before invoking policies or constructing SQL", () => {
    expect(() => compileSearch(descriptor, { where: { hidden: { eq: "x" } } }, null)).toThrow(/selection/i);
  });
});

describe("policy dependency evidence", () => {
  it("keeps root, selected, filtered and junction dependencies with all declarations empty", () => {
    const pair = validators.tables.tasks.search({
      columns: ["title"],
      scope: { name: "root", version: "1", dependencies: [], where: () => sql`true` },
      through: {
        taskLabels: { name: "junction", version: "1", dependencies: [], where: () => sql`true` },
      },
      relations: {
        labels: {
          columns: ["name"],
          scope: { name: "child", version: "1", dependencies: [], where: () => sql`true` },
        },
      },
    });
    const descriptor = searchContractDescriptor(oc.input(pair.input).output(pair.output));
    if (!descriptor) throw new Error("Missing search descriptor");
    for (const input of [{}, { with: { labels: {} } }, { where: { relations: { labels: { some: {} } } } }]) {
      const compiled = compileSearch(descriptor, input, null);
      const expected = new Set(input.with || input.where ? ["tasks", "labels", "taskLabels"] : ["tasks"]);
      expect(compiled.dependencies).toEqual(expected);
      db.select({ count: sql`count(*)` })
        .from(searchSchema.tables.tasks)
        .where(compiled.where(searchSchema.tables.tasks))
        .toSQL();
      expect(compiled.dependencyEvidence.complete).toBe(true);
      expect(compiled.dependencies).toEqual(expected);
      db.query.tasks.findMany(compiled.config).toSQL();
      expect(compiled.dependencyEvidence.complete).toBe(true);
      expect(compiled.dependencies).toEqual(expected);
    }
  });
  function descriptorFor(
    rootDependencies?: readonly (keyof typeof searchRelations)[],
    childDependencies?: readonly (keyof typeof searchRelations)[],
  ) {
    const rootScope: SearchScope<typeof searchRelations.tasks, typeof searchRelations> = {
      name: "root",
      version: "1",
      where: () =>
        sql`exists (select 1 from ${searchSchema.tables.members} where ${searchSchema.tables.members.name} = ${"allowed"})`,
    };
    const childScope: SearchScope<typeof searchRelations.labels, typeof searchRelations> = {
      name: "child",
      version: "1",
      where: () => sql`true`,
    };
    const pair = validators.tables.tasks.search({
      columns: ["title"],
      scope: rootDependencies === undefined ? rootScope : { ...rootScope, dependencies: rootDependencies },
      through: {
        taskLabels: { name: "junction", version: "1", dependencies: ["organizations"], where: () => sql`true` },
      },
      relations: {
        labels: {
          columns: ["name"],
          scope: childDependencies === undefined ? childScope : { ...childScope, dependencies: childDependencies },
        },
      },
    });
    const descriptor = searchContractDescriptor(oc.input(pair.input).output(pair.output));
    if (!descriptor) throw new Error("Missing search descriptor");
    return descriptor;
  }
  it("retains lazy declaration union through rows and count in the page plan", async () => {
    const descriptor = descriptorFor(["members"], ["teams"]);
    const plan = await prepareSearchPage(
      descriptor,
      { with: { labels: {} }, count: true },
      { branchId: "test", namespace: "app", contract: "list", identity: null },
      "a".repeat(64),
    );
    const evidence = plan.dependencyEvidence;
    expect(evidence.dependencies).toBe(plan.dependencies);
    expect(evidence.dependencies).toEqual(new Set(["tasks", "labels", "taskLabels"]));
    const rowsQuery = db.query.tasks.findMany(plan.config).toSQL();
    expect(rowsQuery.sql).toContain('"members"');
    expect(rowsQuery.params).toContain("allowed");
    expect(evidence.complete).toBe(true);
    expect(evidence.dependencies).toEqual(
      new Set(["tasks", "labels", "taskLabels", "members", "teams", "organizations"]),
    );
    db.select({ count: sql`count(*)` })
      .from(searchSchema.tables.tasks)
      .where(plan.where(searchSchema.tables.tasks))
      .toSQL();
    expect(evidence.complete).toBe(true);
    expect(evidence.dependencies).toEqual(
      new Set(["tasks", "labels", "taskLabels", "members", "teams", "organizations"]),
    );
    const filtered = compileSearch(descriptor, { where: { relations: { labels: { some: {} } } } }, null);
    db.query.tasks.findMany(filtered.config).toSQL();
    expect(filtered.dependencyEvidence.complete).toBe(true);
    expect(filtered.dependencies).toEqual(evidence.dependencies);
  });
  it("marks missing root declarations unknown when the lazy count policy runs", () => {
    const compiled = compileSearch(descriptorFor(undefined, []), {}, null);
    expect(compiled.dependencyEvidence.complete).toBe(true);
    db.select({ count: sql`count(*)` })
      .from(searchSchema.tables.tasks)
      .where(compiled.where(searchSchema.tables.tasks))
      .toSQL();
    expect(compiled.dependencyEvidence.complete).toBe(false);
    db.query.tasks.findMany(compiled.config).toSQL();
    expect(compiled.dependencyEvidence.complete).toBe(false);
  });
  it("visits selected and filtered child policies and keeps unknown sticky", () => {
    const descriptor = descriptorFor([]);
    const root = compileSearch(descriptor, {}, null);
    db.query.tasks.findMany(root.config).toSQL();
    expect(root.dependencyEvidence.complete).toBe(true);
    const selected = compileSearch(descriptor, { with: { labels: {} } }, null);
    db.query.tasks.findMany(selected.config).toSQL();
    expect(selected.dependencyEvidence.complete).toBe(false);
    selected.where(searchSchema.tables.tasks);
    expect(selected.dependencyEvidence.complete).toBe(false);
    const filtered = compileSearch(descriptor, { where: { relations: { labels: { some: {} } } } }, null);
    db.query.tasks.findMany(filtered.config).toSQL();
    expect(filtered.dependencyEvidence.complete).toBe(false);
  });
  it("treats public policies as complete and missing junction declarations as unknown", () => {
    const pair = validators.tables.tasks.search({
      columns: ["title"],
      scope: "public",
      through: {
        taskLabels: { name: "junction", version: "1", where: () => sql`true` },
      },
      relations: { labels: { columns: ["name"], scope: "public" } },
    });
    const descriptor = searchContractDescriptor(oc.input(pair.input).output(pair.output));
    if (!descriptor) throw new Error("Missing search descriptor");
    const root = compileSearch(descriptor, {}, null);
    db.query.tasks.findMany(root.config).toSQL();
    expect(root.dependencyEvidence.complete).toBe(true);
    const joined = compileSearch(descriptor, { with: { labels: {} } }, null);
    db.query.tasks.findMany(joined.config).toSQL();
    expect(joined.dependencyEvidence.complete).toBe(false);
  });
});
