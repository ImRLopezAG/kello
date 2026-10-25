import { describe, expect, it } from "vite-plus/test";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { PgDialect } from "drizzle-orm/pg-core";
import { createProjectContext } from "../../../apps/kello/src/core/server/index";
import { oc } from "../../../apps/kello/src/core/contract/index";
import { searchSchema, searchRelations, nestedSelection } from "../fixtures/search-schema";
import { searchContractDescriptor } from "../../../apps/kello/src/core/search/metadata";
import { prepareSearchPage } from "../../../apps/kello/src/core/search/pagination";
import { compileSearch } from "../../../apps/kello/src/core/search/compiler";

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
    expect(query.sql).toContain('from "app"."labels" as "s1" inner join "app"."task_labels" as "j2" on ');
    expect(query.sql).toContain("not (exists");
    expect(query.sql).not.toContain("OR 1=1");
    expect(query.params).toContain("%\\%' OR 1=1 --\\_\\\\%");
    expect(query.params.filter((value) => value === "allowed").length).toBeGreaterThanOrEqual(2);
    expect(query.sql).toContain('"task_labels"');
    expect(query.sql).not.toContain("distinct");
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
  });
  it("rejects invalid fields before invoking policies or constructing SQL", () => {
    expect(() => compileSearch(descriptor, { where: { hidden: { eq: "x" } } }, null)).toThrow(/selection/i);
  });
});

describe("finite policy SQL after revision-engine removal", () => {
  it("keeps side-read authorization in row and count SQL without dependency declarations", async () => {
    const pair = validators.tables.tasks.search({
      columns: ["title"],
      scope: {
        name: "membership",
        version: "1",
        where: () =>
          sql`exists (select 1 from ${searchSchema.tables.members} where ${searchSchema.tables.members.name} = ${"allowed"})`,
      },
      through: { taskLabels: { name: "junction", version: "1", where: () => sql`true` } },
      relations: {
        labels: {
          columns: ["name"],
          scope: { name: "child", version: "1", where: ({ table }) => eq(table.name, "visible") },
        },
      },
    });
    const descriptor = searchContractDescriptor(oc.input(pair.input).output(pair.output));
    if (!descriptor) throw new Error("Missing search descriptor");
    const plan = await prepareSearchPage(
      descriptor,
      { with: { labels: {} }, count: true },
      { branchId: "test", namespace: "app", contract: "list", identity: null },
      "a".repeat(64),
    );
    const rows = db.query.tasks.findMany(plan.config).toSQL();
    const count = db
      .select({ count: sql`count(*)` })
      .from(searchSchema.tables.tasks)
      .where(plan.where(searchSchema.tables.tasks))
      .toSQL();
    for (const query of [rows, count]) {
      expect(query.sql).toContain('"members"');
      expect(query.params).toContain("allowed");
    }
    expect(rows.params).toContain("visible");
    expect(Object.hasOwn(plan, "dependencyEvidence")).toBe(false);
    expect(Object.hasOwn(plan, "dependencies")).toBe(false);
  });
});
