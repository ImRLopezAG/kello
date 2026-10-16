import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";
import { expect, test } from "bun:test";
import { call, ORPCError } from "@orpc/server";
import type { InferSchemaInput } from "@orpc/server";
import { Context } from "effect";
import { and, defineRelations, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { pgSchema } from "drizzle-orm/pg-core";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api-postgres";
import pg from "pg";
import * as v from "valibot";
import {
  bindRpcDatabaseProcedure,
  connectDatabase,
  createDatabaseMiddleware,
  createProjectContext,
  createProjectProcedures,
  defineSchema,
  defineTable,
  Invocation,
} from "../../../apps/kello/src/core/server/index";
import type { ProcedureContext } from "../../../apps/kello/src/core/server/index";
import { searchErrors } from "../../../apps/kello/src/core/search/errors";
import { fullTextLocalTarget } from "./full-text-local-target";

type NativeQueryCallback = (error: Error, result: pg.QueryResult | pg.QueryArrayResult<unknown[]>) => void;
type NativeQueryArguments =
  | [query: pg.Submittable]
  | [query: string | pg.QueryConfig, values?: pg.QueryConfigValues<unknown[]>]
  | [query: string | pg.QueryConfig, callback: NativeQueryCallback]
  | [query: string, values: pg.QueryConfigValues<unknown[]>, callback: NativeQueryCallback];
type NativeQueryResult = pg.Submittable | Promise<pg.QueryResult | pg.QueryArrayResult<unknown[]>> | void;
interface NativeQueryDispatch {
  apply(receiver: pg.PoolClient, args: NativeQueryArguments): NativeQueryResult;
}

// This is U3's owned executor proof. U4's full traversal/float-bit oracle and
// U5's representative index/live acceptance remain separate gates.
test("U3 PG18 owned full-text handler: authorization, rank, snapshot and remaining deadline", async () => {
  const connectionString = fullTextLocalTarget(process.env.LOOM_TEST_DATABASE_URL);
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const namespace = `fts_u3_${suffix}`;
  const metadataNamespace = `loom_fts_u3_${suffix}`;
  const role = `fts_u3_role_${suffix}`;
  const owner = new pg.Pool({ connectionString, max: 3 });
  let installed = false;
  let roleCreated = false;
  try {
    // Verify the actual server and database before any fixture DDL/DML.
    const target = await owner.query<{ version: number; database: string }>(
      "SELECT current_setting('server_version_num')::int AS version, current_database() AS database",
    );
    expect(target.rows).toEqual([{ version: 180006, database: "kello_test" }]);
    const schema = defineSchema(
      (f) => {
        const fields = {
          label: f.text().notNull(),
          owner: f.text().notNull(),
          title: f.text(),
          body: f.text(),
          published: f.boolean().notNull(),
        };
        const sources = [
          { field: "title", weight: "A" },
          { field: "body", weight: "D" },
        ] as const;
        return {
          english: defineTable(fields, {
            fullText: { content: { config: "pg_catalog.english", fields: sources, version: "1" } },
          }),
          simple: defineTable(fields, {
            fullText: { content: { config: "pg_catalog.simple", fields: sources, version: "1" } },
          }),
        };
      },
      { namespace },
    );
    const relations = defineRelations(schema.tables);
    const empty = await generateDrizzleJson({}, undefined, [namespace]);
    const snapshot = await generateDrizzleJson({ namespace: pgSchema(namespace), ...schema.tables }, empty.id, [
      namespace,
    ]);
    installed = true; // Cleanup also owns partial installation if a statement fails.
    for (const statement of await generateMigration(empty, snapshot)) await owner.query(statement);
    await owner.query(`CREATE SCHEMA "${metadataNamespace}"`);
    await owner.query(`CREATE ROLE "${role}" LOGIN PASSWORD 'fts-u3-test-only'`);
    roleCreated = true;
    await owner.query(`GRANT USAGE ON SCHEMA "${namespace}" TO "${role}"`);
    await owner.query(`GRANT SELECT ON ALL TABLES IN SCHEMA "${namespace}" TO "${role}"`);
    // A native authorization predicate can wait in rows and count independently.
    // No executor SQL/result is replaced, and no production test hook is added.
    await owner.query(`CREATE FUNCTION "${namespace}".search_gate(root_key bigint, count_key bigint)
      RETURNS boolean LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog AS $gate$
      BEGIN
        IF position('count(*)' in current_query()) > 0 THEN
          PERFORM pg_advisory_xact_lock(count_key);
        ELSE
          PERFORM pg_advisory_xact_lock(root_key);
        END IF;
        RETURN true;
      END $gate$`);
    await owner.query(`REVOKE ALL ON FUNCTION "${namespace}".search_gate(bigint, bigint) FROM PUBLIC`);
    await owner.query(`GRANT EXECUTE ON FUNCTION "${namespace}".search_gate(bigint, bigint) TO "${role}"`);
    const seed = drizzle({ client: owner, relations });
    const rows = [
      { label: "hidden-high", owner: "bob", title: "quasar quasar quasar", body: "quasar", published: true },
      { label: "title", owner: "alice", title: "quasar", body: null, published: true },
      { label: "body", owner: "alice", title: null, body: "quasar", published: true },
      { label: "draft", owner: "alice", title: null, body: "quasar", published: false },
      { label: "null", owner: "alice", title: null, body: null, published: true },
      { label: "stem", owner: "alice", title: "running", body: null, published: true },
      { label: "stopwords", owner: "alice", title: "the and of", body: null, published: true },
      { label: "unicode", owner: "alice", title: "CAFÉ, naïve 東京", body: null, published: true },
      { label: "plain", owner: "alice", title: "cat", body: null, published: true },
    ];
    await seed.insert(schema.tables.english).values(rows);
    await seed.insert(schema.tables.simple).values(rows);
    const address = new URL(connectionString);
    address.username = role;
    address.password = "fts-u3-test-only";
    const connection = await connectDatabase({ schema, relations, connectionString: address.href, maxConnections: 1 });
    const statements: { text: string; values: unknown[] }[] = [];
    let beforeCount: (() => Promise<void>) | undefined;
    const observed = new WeakSet<pg.PoolClient>();
    connection.pool.on("acquire", (client) => {
      if (observed.has(client)) return;
      observed.add(client);
      client.query = new Proxy(client.query, {
        apply(target, receiver, args: NativeQueryArguments) {
          // Forward the original argument tuple, including callbacks, with its caller's receiver.
          const dispatch: NativeQueryDispatch = target;
          const parsed = v.safeParse(
            v.union([
              v.pipe(
                v.string(),
                v.transform((text) => ({ text, values: [] })),
              ),
              v.pipe(
                v.looseObject({ text: v.string(), values: v.optional(v.array(v.unknown())) }),
                v.transform(({ text, values }) => ({ text, values: values ?? [] })),
              ),
            ]),
            args[0],
          );
          const entry = parsed.success ? parsed.output : { text: "", values: [] };
          // Drizzle supplies parameters as the second pg.query argument.
          const parameters = v.safeParse(v.array(v.unknown()), args[1]);
          if (parameters.success) entry.values = parameters.output;
          statements.push(entry);
          if (entry.text.includes("count(*)") && beforeCount) {
            const barrier = beforeCount;
            beforeCount = undefined;
            return barrier().then<NativeQueryResult>(() => dispatch.apply(receiver, args));
          }
          return dispatch.apply(receiver, args);
        },
      });
    });
    try {
      const { validators } = createProjectContext(schema, relations);
      const { procedure } = createProjectProcedures(schema, relations);
      const searchProcedure = procedure.errors(searchErrors);
      const read = createDatabaseMiddleware(relations, "read", schema);
      const grants = {
        columns: ["label", "title", "body"],
        filter: ["title", "body", "published"],
        text: ["title", "body"],
        fullText: ["content"],
      } as const;
      const scope = {
        name: "owner",
        version: "1",
        where: ({ table, identity }: { table: typeof schema.tables.english; identity: ProcedureContext["identity"] }) =>
          eq(table.owner, identity?.subject ?? "anonymous"),
      };
      const english = validators.tables.english.search({ ...grants, scope });
      const simple = validators.tables.simple.search({
        ...grants,
        scope: {
          ...scope,
          where: ({ table, identity }) => eq(table.owner, identity?.subject ?? "anonymous"),
        },
      });
      const rootKey = Number.parseInt(suffix.slice(0, 8), 16);
      const countKey = rootKey + 1;
      const gated = validators.tables.english.search({
        ...grants,
        budgets: { fullTextTimeoutMs: 2000 },
        scope: {
          ...scope,
          name: "owner-native-lock",
          where: ({ table, identity }) =>
            and(
              eq(table.owner, identity?.subject ?? "anonymous"),
              sql`${sql.identifier(namespace)}.search_gate(${rootKey}::bigint, ${countKey}::bigint)`,
            )!,
        },
      });
      const cancellation = validators.tables.english.search({
        ...grants,
        budgets: { fullTextTimeoutMs: 10_000 },
        scope: {
          ...scope,
          name: "owner-native-cancellation",
          where: ({ table, identity }) =>
            and(
              eq(table.owner, identity?.subject ?? "anonymous"),
              sql`${sql.identifier(namespace)}.search_gate(${rootKey}::bigint, ${countKey}::bigint)`,
            )!,
        },
      });
      let authorizations = 0;
      const options = {
        connection,
        replay: { metadataNamespace, deployment: "fts-u3" },
        search: { branchId: "fts-u3-local", key: "06".repeat(32), contract: "fts-u3/search" },
        authorize: async ({ identity }: ProcedureContext) => {
          authorizations++;
          if (!identity) throw new ORPCError("UNAUTHORIZED");
        },
      };
      const list = bindRpcDatabaseProcedure(
        searchProcedure
          .use(read)
          .input(english.input)
          .output(english.output)
          .handler(({ context, input }) => context.search.english.paginate(input)),
        options,
      );
      const simpleList = bindRpcDatabaseProcedure(
        searchProcedure
          .use(read)
          .input(simple.input)
          .output(simple.output)
          .handler(({ context, input }) => context.search.simple.paginate(input)),
        options,
      );
      const gatedList = bindRpcDatabaseProcedure(
        searchProcedure
          .use(read)
          .input(gated.input)
          .output(gated.output)
          .handler(({ context, input }) => context.search.english.paginate(input)),
        options,
      );
      const cancellationList = bindRpcDatabaseProcedure(
        searchProcedure
          .use(read)
          .input(cancellation.input)
          .output(cancellation.output)
          .handler(({ context, input }) => context.search.english.paginate(input)),
        options,
      );
      const contextFor = (subject: string | null, signal = new AbortController().signal): ProcedureContext => {
        const invocation = {
          identity: subject ? { issuer: "https://fts.test", subject } : null,
          requestId: crypto.randomUUID(),
          signal,
        };
        return { ...invocation, "effect/context": Context.make(Invocation, invocation) };
      };
      const alice = contextFor("alice");
      const input = {
        columns: { label: true },
        fullText: { document: "content", query: "quasar" },
        limit: 1,
        count: true,
      } as const;
      const request = (selection: InferSchemaInput<typeof english.input> = input, context = alice) =>
        call(list, selection, { context, path: ["english", "search"] });
      const searchSimple = (query: string) =>
        call(
          simpleList,
          { ...input, limit: 10, fullText: { document: "content", query } },
          { context: alice, path: ["simple", "search"] },
        );
      const searchEnglish = (query: string) =>
        request({ ...input, limit: 10, fullText: { document: "content", query } });

      // Independent SQL establishes that hidden-high really precedes the visible
      // title hit, and that title weight outranks body weight (no shared builder).
      const oracle = await owner.query<{ label: string; rank: number }>(
        `SELECT label,
        ts_rank_cd(ARRAY[0.1,0.2,0.4,1.0]::real[],
          setweight(to_tsvector('pg_catalog.english', coalesce(title, '')), 'A') ||
          setweight(to_tsvector('pg_catalog.english', coalesce(body, '')), 'D'),
          plainto_tsquery('pg_catalog.english', $1), 32)::real AS rank
        FROM "${namespace}".english WHERE label IN ('hidden-high', 'title', 'body') ORDER BY rank DESC, _id ASC`,
        ["quasar"],
      );
      expect(oracle.rows.map((row) => row.label)).toEqual(["hidden-high", "title", "body"]);
      expect(oracle.rows[0]!.rank).toBeGreaterThan(oracle.rows[1]!.rank);
      expect(oracle.rows[1]!.rank).toBeGreaterThan(oracle.rows[2]!.rank);
      const ties = await owner.query<{ label: string }>(
        `SELECT label FROM "${namespace}".english WHERE label IN ('body', 'draft') ORDER BY _id ASC`,
      );
      expect(ties.rows).toHaveLength(2);
      const first = await request();
      expect(first).toEqual({
        rows: [{ label: "title" }],
        count: "3",
        nextCursor: expect.any(String),
        previousCursor: null,
      });
      const second = await request({ ...input, cursor: first.nextCursor });
      expect(second.rows).toEqual([ties.rows[0]!]);
      expect(second.count).toBe("3");
      assert(second.nextCursor);
      const last = await request({ ...input, cursor: second.nextCursor });
      expect(last.rows).toEqual([ties.rows[1]!]);
      expect(last.nextCursor).toBeNull();
      expect(last.count).toBe("3");
      assert(second.previousCursor);
      const previous = await request({ ...input, cursor: second.previousCursor, direction: "backward" });
      expect(previous.rows).toEqual(first.rows);
      expect(previous.previousCursor).toBeNull();
      const visible = await request({ ...input, limit: 10, where: { published: { eq: true } } });
      expect(visible).toEqual({
        rows: [{ label: "title" }, { label: "body" }],
        count: "2",
        nextCursor: null,
        previousCursor: null,
      });
      expect((await request(input, contextFor("bob"))).rows).toEqual([{ label: "hidden-high" }]);
      expect((await request(input, contextFor("bob"))).count).toBe("1");
      expect((await request({ ...input, where: { NOT: { published: { eq: false } } } })).count).toBe("2");
      expect(
        (
          await request({
            ...input,
            limit: 10,
            columns: { label: true, title: true, body: true },
            where: { published: { eq: true } },
          })
        ).rows,
      ).toEqual([
        { label: "title", title: "quasar", body: null },
        { label: "body", title: null, body: "quasar" },
      ]);
      expect((await searchEnglish("run")).rows).toEqual([{ label: "stem" }]);
      expect((await searchSimple("run")).rows).toEqual([]);
      expect((await searchSimple("running")).rows).toEqual([{ label: "stem" }]);
      expect((await searchSimple("the")).rows).toEqual([{ label: "stopwords" }]);
      expect((await searchSimple("café naïve 東京")).rows).toEqual([{ label: "unicode" }]);
      expect((await searchEnglish("QUASAR!!!")).count).toBe("3");
      expect((await searchEnglish("-cat")).rows).toEqual([{ label: "plain" }]);
      expect((await searchSimple("cafe")).rows).toEqual([]); // No implicit accent removal.

      statements.length = 0;
      expect(await request({ ...input, count: false })).not.toHaveProperty("count");
      expect(statements.some(({ text }) => text.includes("count(*)"))).toBe(false);
      for (const query of ["", " \t\n", "!!!", "the and of"]) {
        statements.length = 0;
        const before = authorizations;
        expect(await searchEnglish(query)).toEqual({ rows: [], count: "0", nextCursor: null, previousCursor: null });
        expect(authorizations).toBeGreaterThan(before);
        // Native rows and count retain authorization and a constant-false
        // predicate, so an empty parse cannot become an unrestricted scan.
        const emptyReads = statements.filter(
          ({ text }) => /\bselect\b/i.test(text) && text.includes(`"${namespace}"."english"`),
        );
        expect(emptyReads).toHaveLength(2);
        expect(emptyReads.filter(({ text }) => text.includes("count(*)"))).toHaveLength(1);
        for (const { text, values } of emptyReads) {
          expect(text).toMatch(/\band\s+(?:\(\s*)*false\b/i);
          expect(text).toContain('"owner"');
          expect(values).toContain("alice");
        }
        statements.length = 0;
        await assert.rejects(request({ ...input, fullText: { document: "content", query } }, contextFor(null)), {
          code: "UNAUTHORIZED",
        });
        expect(
          statements.some(({ text }) => text.includes("plainto_tsquery") || text.includes(`"${namespace}"."english"`)),
        ).toBe(false);
      }
      beforeCount = async () => {
        await seed
          .insert(schema.tables.english)
          .values({ label: "concurrent", owner: "alice", title: "quasar", body: null, published: true });
        await seed
          .insert(schema.tables.english)
          .values({ label: "concurrent-hidden", owner: "bob", title: "quasar quasar", body: null, published: true });
      };
      const snapshotPage = await request({ ...input, limit: 10 });
      expect(snapshotPage.count).toBe("3");
      const labels = v.array(v.strictObject({ label: v.string() }));
      expect(
        v
          .parse(labels, snapshotPage.rows)
          .map((row) => row.label)
          .sort(),
      ).toEqual(["body", "draft", "title"]);
      expect(beforeCount).toBeUndefined();
      const fresh = await request({ ...input, limit: 10 });
      expect(fresh.count).toBe("4");
      expect(
        v
          .parse(labels, fresh.rows)
          .map((row) => row.label)
          .sort(),
      ).toEqual(["body", "concurrent", "draft", "title"]);

      const waitFor = async (predicate: () => Promise<boolean>) => {
        const end = performance.now() + 5000;
        while (!(await predicate())) {
          assert(performance.now() < end, "Native database barrier did not arrive");
          await setTimeout(10); // Poll a causal database condition, never a guessed delay.
        }
      };
      const bounded = async <Result>(work: Promise<Result>): Promise<Result> => {
        const timer = new AbortController();
        try {
          return await Promise.race([
            work,
            setTimeout(5000, undefined, { signal: timer.signal }).then(() => {
              throw new Error("Native search failed to reject while its lock remained held");
            }),
          ]);
        } finally {
          timer.abort();
        }
      };
      for (const scenario of ["cancel-root", "remaining-count-deadline"] as const) {
        const blocker = await owner.connect();
        const controller = new AbortController();
        let pending: Promise<unknown> | undefined;
        let published = false;
        statements.length = 0;
        try {
          await blocker.query("SELECT pg_advisory_lock($1::bigint), pg_advisory_lock($2::bigint)", [rootKey, countKey]);
          pending = call(scenario === "cancel-root" ? cancellationList : gatedList, input, {
            context: contextFor("alice", controller.signal),
            path: ["english", "gated"],
          }).then((page) => {
            published = true;
            return page;
          });
          // Attach rejection handling before waiting on external SQL barriers.
          const outcome = pending.then(
            () => ({ code: "unexpected-success" }),
            (cause: unknown) => v.parse(v.instance(Error), cause),
          );
          const blocked = () =>
            owner
              .query(
                "SELECT 1 FROM pg_stat_activity WHERE usename = $1 AND state = 'active' AND wait_event_type = 'Lock'",
                [role],
              )
              .then((result) => result.rowCount === 1);
          await waitFor(blocked);
          if (scenario === "cancel-root") {
            // The 5s completion bound precedes this contract's 10s query
            // timeout, so a timeout cannot masquerade as cancellation.
            controller.abort(new Error("Cancelled native ranked root read"));
            await assert.rejects(bounded(pending), (error: Error) => !error.message.includes("Native search failed"));
            expect(controller.signal.aborted).toBe(true);
          } else {
            // Deliberately consume the invocation budget in a native locked row
            // read. Keep count locked; it must inherit the remaining allowance.
            await blocker.query("SELECT pg_sleep(0.7)");
            await blocker.query("SELECT pg_advisory_unlock($1::bigint)", [rootKey]);
            await waitFor(async () => statements.some(({ text }) => text.includes("count(*)")) && (await blocked()));
            const allowances = statements
              .filter(({ text }) => text.includes("set_config('statement_timeout'"))
              .flatMap(({ values }) =>
                values.flatMap((value) => {
                  const allowance = v.safeParse(v.pipe(v.string(), v.regex(/^\d+ms$/)), value);
                  return allowance.success ? [Number.parseInt(allowance.output, 10)] : [];
                }),
              );
            expect(allowances.length).toBeGreaterThanOrEqual(3); // preflight, rows, count
            expect(allowances.at(-1)!).toBeGreaterThan(0);
            expect(allowances.at(-1)!).toBeLessThan(allowances[0]! - 500);
            expect(await bounded(outcome)).toMatchObject({ code: "QUERY_BUDGET_EXCEEDED" });
          }
          expect(published).toBe(false);
          // Locks remain held while proving cancellation/timeout drained SQL.
          await waitFor(
            async () =>
              (
                await owner.query(
                  "SELECT 1 FROM pg_stat_activity WHERE usename = $1 AND (state = 'active' OR state LIKE 'idle in transaction%')",
                  [role],
                )
              ).rowCount === 0,
          );
          await waitFor(async () => connection.pool.idleCount === connection.pool.totalCount);
          expect(connection.pool.waitingCount).toBe(0);
        } finally {
          await blocker.query("SELECT pg_advisory_unlock($1::bigint), pg_advisory_unlock($2::bigint)", [
            rootKey,
            countKey,
          ]);
          blocker.release();
          await pending?.catch(() => {});
        }
        expect(published).toBe(false);
        expect((await request()).count).toBe("4");
      }
    } finally {
      await connection.close();
    }
  } finally {
    try {
      if (installed) {
        await owner.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
        await owner.query(`DROP SCHEMA IF EXISTS "${metadataNamespace}" CASCADE`);
      }
      if (roleCreated) await owner.query(`DROP ROLE "${role}"`);
    } finally {
      await owner.end();
    }
  }
}, 60_000);
