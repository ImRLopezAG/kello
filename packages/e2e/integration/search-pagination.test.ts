import { test, expect } from "bun:test";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { pgSchema } from "drizzle-orm/pg-core";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api-postgres";
import { eq } from "drizzle-orm";
import { createProjectContext } from "kello/server";
import { oc } from "kello/contract";
import * as v from "valibot";
import { createSearchFixture } from "../fixtures/search-schema";
import { searchContractDescriptor } from "../../../apps/kello/src/core/search/metadata";
import { prepareSearchPage, finishSearchPage } from "../../../apps/kello/src/core/search/pagination";
import { searchOrdering, searchOrderSQL } from "../../../apps/kello/src/core/search/ordering";
import type { SearchPublicSelection } from "../../../apps/kello/src/core/search/public";
import { storageRows } from "../../../apps/kello/src/core/validation/encoding";

const connectionString = process.env.LOOM_TEST_DATABASE_URL;
test.skipIf(!connectionString)(
  "bidirectional exact pagination matches the Neon ordering oracle (P037-P061)",
  async () => {
    if (!connectionString) throw new Error("Missing database URL");
    const namespace = `loom_pages_${crypto.randomUUID().replaceAll("-", "")}`;
    const { schema, relations } = createSearchFixture(namespace);
    const pool = new pg.Pool({ connectionString, options: "-c timezone=America/New_York" });
    const db = drizzle({ client: pool, relations });
    const { validators } = createProjectContext(schema, relations);
    const search = validators.tables.tasks.search({
      scope: {
        name: "owner",
        version: "1",
        where: ({ table, identity }) => eq(table.owner, identity?.subject ?? "anonymous"),
      },
      columns: ["title"],
      filter: ["title"],
      order: ["rank", "title", "at", "count", "amount", "_createdAt", "_id"],
    });
    const descriptor = searchContractDescriptor(oc.input(search.input).output(search.output));
    if (!descriptor) throw new Error("Missing descriptor");
    const context = {
      branchId: "br-test",
      namespace,
      contract: "tasks.list",
      identity: { issuer: "https://auth.test", subject: "alice" },
    };
    const key = "03".repeat(32);
    async function page(input: SearchPublicSelection) {
      const plan = await prepareSearchPage(descriptor!, input, context, key);
      return finishSearchPage(plan, v.parse(storageRows, await db.query.tasks.findMany(plan.config)));
    }
    async function taskId(value: string) {
      const result = await schema.id("tasks")["~standard"].validate(value);
      if (result.issues) throw new Error("Invalid fixture ID");
      return result.value;
    }
    async function rejects(input: SearchPublicSelection, code: string) {
      let rejected = false;
      try {
        await page(input);
      } catch (cause) {
        rejected = true;
        expect(cause).toMatchObject({ code });
      }
      expect(rejected).toBe(true);
    }
    try {
      const empty = await generateDrizzleJson({}, undefined, [namespace]);
      const snapshot = await generateDrizzleJson({ namespace: pgSchema(namespace), ...schema.tables }, empty.id, [
        namespace,
      ]);
      for (const statement of await generateMigration(empty, snapshot)) await pool.query(statement);
      expect(await page({})).toEqual({ rows: [], nextCursor: null, previousCursor: null });
      const values = await Promise.all(
        Array.from({ length: 9 }, async (_, index) => ({
          _id: await taskId(`00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`),
          _createdAt: 1234567890,
          title: String(index),
          owner: "alice",
          done: false,
          rank: index % 3 ? index % 2 : null,
          at: new Date(`2026-01-01T00:00:0${index % 3}.123Z`),
          count: index % 2 ? 9223372036854775807n : -9223372036854775808n,
          amount: index % 2 ? "999999999999999999.0000000001" : "-999999999999999999.0000000001",
        })),
      );
      await db.insert(schema.tables.tasks).values(values.slice(0, 1));
      expect(await page({ limit: 1 })).toEqual({ rows: [{ title: "0" }], nextCursor: null, previousCursor: null });
      await db.insert(schema.tables.tasks).values(values.slice(1));
      await db
        .insert(schema.tables.tasks)
        .values({ ...values[0]!, _id: await taskId(crypto.randomUUID()), title: "forbidden", owner: "bob" });
      for (const direction of ["asc", "desc"] as const)
        for (const nulls of ["first", "last"] as const) {
          const input = {
            orderBy: [
              { field: "rank", direction, nulls },
              { field: "title", direction: "desc" },
            ],
          } as const;
          const expected = (
            await db
              .select({ title: schema.tables.tasks.title })
              .from(schema.tables.tasks)
              .where(eq(schema.tables.tasks.owner, "alice"))
              .orderBy(...searchOrderSQL(schema.tables.tasks, searchOrdering(descriptor, input), "forward"))
          ).map(({ title }) => title);
          for (const limit of [1, 2, 3, 5, 100]) {
            const forward: unknown[] = [];
            const backward: unknown[] = [];
            let cursor: string | null = null;
            let iterations = 0;
            do {
              const current = await page({ ...input, limit, cursor });
              expect(current.rows?.every((row) => Object.keys(row).join(",") === "title")).toBe(true);
              forward.push(...(current.rows ?? []).map((row) => row.title));
              cursor = current.nextCursor;
              expect(++iterations).toBeLessThanOrEqual(10);
            } while (cursor);
            cursor = null;
            iterations = 0;
            do {
              const current = await page({ ...input, limit, cursor, direction: "backward" });
              backward.unshift(...(current.rows ?? []).map((row) => row.title));
              cursor = current.previousCursor;
              expect(++iterations).toBeLessThanOrEqual(10);
            } while (cursor);
            expect(forward).toEqual(expected);
            expect(backward).toEqual(expected);
          }
        }
      for (const field of ["at", "count", "amount", "title", "_createdAt", "_id"]) {
        const input = { orderBy: [{ field, direction: "asc" }] } as const;
        const expected = (
          await db
            .select({ title: schema.tables.tasks.title })
            .from(schema.tables.tasks)
            .where(eq(schema.tables.tasks.owner, "alice"))
            .orderBy(...searchOrderSQL(schema.tables.tasks, searchOrdering(descriptor, input), "forward"))
        ).map(({ title }) => title);
        const found: unknown[] = [];
        let cursor: string | null = null;
        do {
          const current = await page({ ...input, limit: 2, cursor });
          found.push(...(current.rows ?? []).map((row) => row.title));
          cursor = current.nextCursor;
        } while (cursor);
        expect(found).toEqual(expected);
      }
      const first = await page({ limit: 2 });
      expect(first.rows).toEqual([{ title: "0" }, { title: "1" }]);
      const second = await page({ limit: 3, cursor: first.nextCursor });
      expect(second.rows).toEqual([{ title: "2" }, { title: "3" }, { title: "4" }]);
      expect((await page({ limit: 2, cursor: second.previousCursor, direction: "backward" })).rows).toEqual(first.rows);
      await db.delete(schema.tables.tasks).where(eq(schema.tables.tasks._id, values[1]!._id));
      expect((await page({ limit: 2, cursor: first.nextCursor })).rows).toEqual([{ title: "2" }, { title: "3" }]);
      const last = await page({ direction: "backward", limit: 1 });
      expect(last.rows).toEqual([{ title: "8" }]);
      expect(last.nextCursor).toBeNull();
      // Issue a valid boundary at the final row to exercise terminal continuation explicitly.
      const finalPlan = await prepareSearchPage(descriptor, { limit: 1 }, context, key);
      const finalToken = await finalPlan.codec.issue([1234567890, values[8]!._id], "forward");
      expect(await page({ limit: 1, cursor: finalToken })).toEqual({
        rows: [],
        nextCursor: null,
        previousCursor: null,
      });
      const all = await page({ limit: 100 });
      expect(all.nextCursor).toBeNull();
      expect(all.previousCursor).toBeNull();
      for (const limit of [0, -1, 1.5, NaN, Infinity, 101]) await rejects({ limit }, "INVALID_SELECTION");
      await rejects(
        { cursor: first.nextCursor, columns: { title: true }, where: { title: { eq: "other" } } },
        "INVALID_CURSOR",
      );
      // Direct SQL can store microseconds even though native selected Date values are millisecond based.
      for (const [index, value] of values.entries())
        await pool.query(`UPDATE "${namespace}".tasks SET at=$1::timestamptz WHERE _id=$2`, [
          `2026-01-01T00:00:00.00000${index + 1}Z`,
          value._id,
        ]);
      const exactInput = { orderBy: [{ field: "at", direction: "asc" }] } as const;
      const exact = (
        await db
          .select({ title: schema.tables.tasks.title })
          .from(schema.tables.tasks)
          .where(eq(schema.tables.tasks.owner, "alice"))
          .orderBy(schema.tables.tasks.at, schema.tables.tasks._id)
      ).map(({ title }) => title);
      const precise: unknown[] = [];
      let cursor: string | null = null;
      let iterations = 0;
      do {
        const result = await page({ ...exactInput, limit: 2, cursor });
        precise.push(...(result.rows ?? []).map((row) => row.title));
        cursor = result.nextCursor;
        expect(++iterations).toBeLessThanOrEqual(5);
      } while (cursor);
      expect(precise).toEqual(exact);
      // Native Date values include extended and BC years; SQL boundaries retain their microseconds.
      for (const [index, value] of values.entries())
        await pool.query(`UPDATE "${namespace}".tasks SET at=$1::timestamptz WHERE _id=$2`, [
          `${index < 3 ? "0002" : "10000"}-01-01T00:00:00.00000${index + 1}Z${index < 3 ? " BC" : ""}`,
          value._id,
        ]);
      const extendedExpected = (
        await db
          .select({ title: schema.tables.tasks.title })
          .from(schema.tables.tasks)
          .where(eq(schema.tables.tasks.owner, "alice"))
          .orderBy(schema.tables.tasks.at, schema.tables.tasks._id)
      ).map(({ title }) => title);
      const extendedFound: unknown[] = [];
      cursor = null;
      iterations = 0;
      do {
        const result = await page({ ...exactInput, limit: 2, cursor });
        extendedFound.push(...(result.rows ?? []).map((row) => row.title));
        cursor = result.nextCursor;
        expect(++iterations).toBeLessThanOrEqual(5);
      } while (cursor);
      expect(extendedFound).toEqual(extendedExpected);
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
      await pool.end();
    }
  },
  120_000,
);
