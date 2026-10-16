import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { createProjectContext } from "kello/server";
import { oc } from "kello/contract";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { pgSchema } from "drizzle-orm/pg-core";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api-postgres";
import pg from "pg";
import * as v from "valibot";
import { createSearchFixture } from "../fixtures/search-schema";
import { compileSearch } from "../../../apps/kello/src/core/search/compiler";
import { searchContractDescriptor } from "../../../apps/kello/src/core/search/metadata";
import type { SearchPublicSelection } from "../../../apps/kello/src/core/search/public";
import { prepareSearchPage, finishSearchPage } from "../../../apps/kello/src/core/search/pagination";
import { storageRows } from "../../../apps/kello/src/core/validation/encoding";

const connectionString = process.env.LOOM_TEST_DATABASE_URL;
test.skipIf(!connectionString)(
  "search membership and exact projections match a real PostgreSQL oracle (P022-P036)",
  async () => {
    if (!connectionString) throw new Error("Missing database URL");
    const namespace = `loom_search_${crypto.randomUUID().replaceAll("-", "")}`;
    const { schema, relations } = createSearchFixture(namespace);
    const setup = new pg.Pool({ connectionString });
    const queries: string[] = [];
    const db = drizzle({
      client: setup,
      relations,
      logger: {
        logQuery(query) {
          queries.push(query);
        },
      },
    });
    const { validators } = createProjectContext(schema, relations);
    const search = validators.tables.tasks.search({
      scope: {
        name: "owner",
        version: "1",
        where: ({ table, identity }) => eq(table.owner, identity?.subject ?? "anonymous"),
      },
      columns: ["title", "done", "at", "count", "amount"],
      filter: ["title", "done", "projectId", "at", "count", "amount"],
      order: ["title", "amount"],
      text: ["title"],
      through: {
        taskLabels: {
          name: "link-owner",
          version: "1",
          where: ({ table, identity }) => eq(table.owner, identity?.subject ?? "anonymous"),
        },
      },
      relations: {
        labels: {
          scope: {
            name: "label-owner",
            version: "1",
            where: ({ table, identity }) => eq(table.owner, identity?.subject ?? "anonymous"),
          },
          columns: ["name"],
          filter: ["name"],
          order: ["name"],
          text: ["name"],
          through: {
            taskLabels: {
              name: "nested-link-owner",
              version: "1",
              where: ({ table, identity }) => eq(table.owner, identity?.subject ?? "anonymous"),
            },
          },
          relations: {
            tasks: {
              scope: { name: "nested-owner", version: "1", where: ({ table }) => eq(table.owner, "alice") },
              columns: ["title"],
            },
          },
        },
        secondaryLabels: {
          scope: { name: "secondary-owner", version: "1", where: ({ table }) => eq(table.owner, "alice") },
          columns: ["name"],
          order: ["name"],
        },
        author: {
          scope: "public",
          columns: ["name"],
          filter: ["name"],
          relations: { manager: { scope: "public", columns: ["name"] } },
        },
        reviewer: { scope: "public", columns: ["name"], filter: ["name"] },
        project: {
          scope: "public",
          columns: ["name"],
          filter: ["name"],
          relations: {
            organization: {
              scope: { name: "visible", version: "1", where: ({ table }) => eq(table.visible, true) },
              columns: ["name"],
              relations: {
                teams: {
                  scope: "public",
                  columns: ["name"],
                  relations: { members: { scope: "public", columns: ["name"] } },
                },
              },
            },
          },
        },
      },
    });
    const descriptor = searchContractDescriptor(oc.input(search.input).output(search.output));
    if (!descriptor) throw new Error("Missing descriptor");
    const identity = { issuer: "https://identity.test", subject: "alice" };
    async function execute(input: SearchPublicSelection) {
      const compiled = compileSearch(descriptor!, input, identity);
      queries.length = 0;
      const rows = v.parse(v.array(v.record(v.string(), v.unknown())), await db.query.tasks.findMany(compiled.config));
      expect(queries).toHaveLength(1); // Nested projections never query once per root.
      const count = await db
        .select({ count: sql<number>`count(*)::integer` })
        .from(schema.tables.tasks)
        .where(compiled.where(schema.tables.tasks));
      expect(count[0]?.count).toBe(rows.length);
      return rows;
    }
    const titles = async (where: SearchPublicSelection["where"]) => {
      const input: SearchPublicSelection = {
        columns: { title: true },
        orderBy: [{ field: "title", direction: "asc" }],
      };
      const rows = where === undefined ? await execute(input) : await execute({ ...input, where });
      return rows.map((row) => row.title);
    };
    try {
      const empty = await generateDrizzleJson({}, undefined, [namespace]);
      const snapshot = await generateDrizzleJson({ namespace: pgSchema(namespace), ...schema.tables }, empty.id, [
        namespace,
      ]);
      for (const statement of await generateMigration(empty, snapshot)) await setup.query(statement);
      const [organization, hiddenOrganization] = await db
        .insert(schema.tables.organizations)
        .values([
          { name: "Visible", visible: true },
          { name: "Hidden", visible: false },
        ])
        .returning();
      if (!organization || !hiddenOrganization) throw new Error("Missing fixture");
      const [project, hiddenProject, inactiveProject] = await db
        .insert(schema.tables.projects)
        .values([
          { name: "Project", active: true, organizationId: organization._id },
          { name: "Hidden project", active: true, organizationId: hiddenOrganization._id },
          { name: "Inactive", active: false, organizationId: organization._id },
        ])
        .returning();
      const [team] = await db
        .insert(schema.tables.teams)
        .values({ name: "Team", organizationId: organization._id })
        .returning();
      const [manager] = await db.insert(schema.tables.users).values({ name: "Manager" }).returning();
      if (!project || !hiddenProject || !inactiveProject || !team || !manager) throw new Error("Missing fixture");
      await db.insert(schema.tables.members).values({ name: "Member", teamId: team._id });
      const [author, reviewer] = await db
        .insert(schema.tables.users)
        .values([{ name: "Author", managerId: manager._id }, { name: "Reviewer" }])
        .returning();
      if (!author || !reviewer) throw new Error("Missing fixture");
      const base = {
        owner: "alice",
        done: false,
        at: new Date("2026-01-01T00:00:00.000Z"),
        count: 9007199254740993n,
        amount: "1.0000000001",
      };
      const [a, b, c, d, e] = await db
        .insert(schema.tables.tasks)
        .values([
          { ...base, title: "A", projectId: project._id, authorId: author._id, reviewerId: reviewer._id },
          { ...base, title: "B", projectId: hiddenProject._id, done: true },
          { ...base, title: "C", projectId: inactiveProject._id },
          { ...base, title: "D%_\\'雪" },
          { ...base, title: "E", owner: "bob" },
        ])
        .returning();
      const [label1, label2, privateLabel] = await db
        .insert(schema.tables.labels)
        .values([
          { name: "alpha", owner: "alice" },
          { name: "beta", owner: "alice" },
          { name: "private", owner: "bob" },
        ])
        .returning();
      if (!a || !b || !c || !d || !e || !label1 || !label2 || !privateLabel) throw new Error("Missing fixture");
      await db.insert(schema.tables.taskLabels).values([
        { taskId: a._id, labelId: label1._id, owner: "alice" },
        { taskId: a._id, labelId: label2._id, owner: "alice" },
        { taskId: a._id, labelId: privateLabel._id, owner: "alice" },
        { taskId: b._id, labelId: label1._id, owner: "bob" },
      ]);
      expect(
        await titles({ AND: [{ done: { eq: false } }, { OR: [{ title: { eq: "A" } }, { title: { eq: "B" } }] }] }),
      ).toEqual(["A"]);
      expect(await titles({ NOT: { done: { eq: true } } })).toEqual(["A", "C", "D%_\\'雪"]);
      expect(await titles({ NOT: { title: { eq: "A" } } })).not.toContain("E");
      expect(await titles({ title: { in: [] } })).toEqual([]);
      expect(await titles({ OR: [] })).toEqual([]);
      expect(await titles({ title: { eq: "A", ne: "A" } })).toEqual([]);
      expect(await titles({ projectId: { isNull: true } })).toEqual(["D%_\\'雪"]);
      expect(await titles({ projectId: { isNull: false } })).toEqual(["A", "B", "C"]);
      expect(() => compileSearch(descriptor, { where: { projectId: { eq: null } } }, identity)).toThrow();
      expect(await titles({ title: { contains: "%_\\'雪" } })).toEqual(["D%_\\'雪"]);
      expect(await titles({ title: { startsWith: "d", insensitive: true, endsWith: "雪" } })).toEqual(["D%_\\'雪"]);
      expect(await titles({ title: { eq: "A' OR true --" } })).toEqual([]);
      expect(
        await titles({
          count: { gte: 9007199254740993n },
          amount: { gt: "1.0000000000", lte: "1.0000000001" },
          at: { eq: new Date("2026-01-01") },
        }),
      ).toEqual(["A", "B", "C", "D%_\\'雪"]);
      expect(await titles({ relations: { labels: { some: {} } } })).toEqual(["A"]);
      expect(await titles({ relations: { labels: { none: {} } } })).toEqual(["B", "C", "D%_\\'雪"]);
      expect(await titles({ relations: { labels: { some: { name: { eq: "private" } } } } })).toEqual([]);
      expect(await titles({ NOT: { relations: { labels: { some: {} } } } })).toEqual(["B", "C", "D%_\\'雪"]);
      expect(await titles({ relations: { project: { is: { name: { eq: "Inactive" } } } } })).toEqual([]);
      expect(
        await titles({
          relations: { author: { is: { name: { eq: "Author" } } }, reviewer: { is: { name: { eq: "Reviewer" } } } },
        }),
      ).toEqual(["A"]);
      expect(await titles({ relations: { author: { isNot: {} } } })).toEqual(["B", "C", "D%_\\'雪"]);
      const projected = await execute({
        columns: { title: true, at: true, count: true, amount: true },
        orderBy: [{ field: "title", direction: "asc" }],
        with: {
          labels: { columns: { name: true }, orderBy: [{ field: "name", direction: "desc" }], limit: 1 },
          author: { columns: { name: true }, with: { manager: { columns: { name: true } } } },
          reviewer: { columns: { name: true } },
          project: {
            columns: { name: true },
            with: {
              organization: {
                columns: { name: true },
                with: { teams: { columns: { name: true }, with: { members: { columns: { name: true } } } } },
              },
            },
          },
        },
      });
      expect(projected[0]).toEqual({
        title: "A",
        at: base.at,
        count: base.count,
        amount: base.amount,
        labels: [{ name: "beta" }],
        author: { name: "Author", manager: { name: "Manager" } },
        reviewer: { name: "Reviewer" },
        project: {
          name: "Project",
          organization: { name: "Visible", teams: [{ name: "Team", members: [{ name: "Member" }] }] },
        },
      });
      expect(projected[1]).toMatchObject({ labels: [], project: { name: "Hidden project", organization: null } });
      expect(projected[2]?.project).toBeNull();
      expect(projected[3]).toMatchObject({ labels: [], author: null, reviewer: null, project: null });
      const nestedJunctions = await execute({
        columns: { title: true },
        where: { title: { eq: "A" } },
        with: {
          labels: {
            columns: { name: true },
            orderBy: [{ field: "name", direction: "asc" }],
            with: { tasks: { columns: { title: true } } },
          },
          secondaryLabels: { columns: { name: true }, orderBy: [{ field: "name", direction: "asc" }] },
        },
      });
      expect(nestedJunctions).toEqual([
        {
          title: "A",
          labels: [
            { name: "alpha", tasks: [{ title: "A" }] },
            { name: "beta", tasks: [{ title: "A" }] },
          ],
          secondaryLabels: [{ name: "alpha" }, { name: "beta" }],
        },
      ]);
      const users = validators.tables.users.search({
        scope: "public",
        columns: ["name"],
        order: ["name"],
        relations: { manager: { scope: "public", columns: ["name"], filter: ["name"] } },
      });
      const userDescriptor = searchContractDescriptor(oc.input(users.input).output(users.output));
      if (!userDescriptor) throw new Error("Missing user descriptor");
      const userSearch = compileSearch(
        userDescriptor,
        { columns: { name: true }, where: { relations: { manager: { is: { name: { eq: "Manager" } } } } } },
        identity,
      );
      expect(
        v.parse(v.array(v.record(v.string(), v.unknown())), await db.query.users.findMany(userSearch.config)),
      ).toEqual([{ name: "Author" }]);
      const userCount = await db
        .select({ count: sql<number>`count(*)::integer` })
        .from(schema.tables.users)
        .where(userSearch.where(schema.tables.users));
      expect(userCount).toEqual([{ count: 1 }]);
      // A related table can own a separate endpoint and independent root cursors.
      // Nested projections themselves do not introduce child cursor controls.
      const childContext = { branchId: "br-test", namespace, contract: "users.list", identity };
      const childInput = { columns: { name: true }, orderBy: [{ field: "name", direction: "asc" }], limit: 1 } as const;
      const childKey = "03".repeat(32);
      async function childPage(cursor: string | null) {
        const plan = await prepareSearchPage(userDescriptor!, { ...childInput, cursor }, childContext, childKey);
        return finishSearchPage(plan, v.parse(storageRows, await db.query.users.findMany(plan.config)));
      }
      const childFirst = await childPage(null);
      expect(childFirst.rows).toEqual([{ name: "Author" }]);
      expect(childFirst.nextCursor).not.toBeNull();
      const childSecond = await childPage(childFirst.nextCursor);
      expect(childSecond.rows).toEqual([{ name: "Manager" }]);
      const childLast = await childPage(childSecond.nextCursor);
      expect(childLast.rows).toEqual([{ name: "Reviewer" }]);
      expect(childLast.nextCursor).toBeNull();
      await assert.rejects(
        () =>
          prepareSearchPage(
            descriptor,
            { columns: { title: true }, cursor: childFirst.nextCursor },
            { ...childContext, contract: "tasks.list" },
            childKey,
          ),
        { code: "INVALID_CURSOR" },
      );
      expect(
        await execute({
          columns: { title: true },
          with: { labels: { columns: { name: true }, where: { name: { eq: "private" } } } },
        }),
      ).toHaveLength(4);
      await db.delete(schema.tables.taskLabels).where(eq(schema.tables.taskLabels.labelId, label1._id));
      await db.delete(schema.tables.taskLabels).where(eq(schema.tables.taskLabels.labelId, label2._id));
      await db.delete(schema.tables.labels).where(eq(schema.tables.labels._id, label2._id));
      expect(await titles({ relations: { labels: { some: {} } } })).toEqual([]);
      expect(() => compileSearch(descriptor, { orderBy: [{ field: "done", direction: "asc" }] }, identity)).toThrow();
      expect(() => compileSearch(descriptor, { with: { labels: { cursor: "child-cursor" } } }, identity)).toThrow();
      expect(() => compileSearch(descriptor, { where: { 'title";drop schema': { eq: "A" } } }, identity)).toThrow();
    } finally {
      await setup.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
      await setup.end();
    }
  },
  60_000,
);
