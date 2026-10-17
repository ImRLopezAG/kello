import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";
import { test, expect } from "bun:test";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { pgSchema } from "drizzle-orm/pg-core";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api-postgres";
import { eq, sql, getTableName } from "drizzle-orm";
import { call, ORPCError } from "@orpc/server";
import type { RouterClient, InferSchemaInput } from "@orpc/server";
import { createORPCClient } from "@orpc/client";
import { RPCLink as HttpLink } from "@orpc/client/fetch";
import { RPCHandler as HttpHandler } from "@orpc/server/fetch";
import { Context, Effect } from "effect";
import * as v from "valibot";
import {
  bindRpcDatabaseProcedure,
  createDatabaseMiddleware,
  createProjectProcedures,
  createProjectServices,
  connectDatabase,
  runFunctionTransaction,
  Invocation,
} from "kello/server";
import type { ProcedureContext } from "kello/server";
import { bootstrapDatabase } from "kello/tooling";
import { createSearchFixture } from "../fixtures/search-schema";

const connectionString = process.env.LOOM_TEST_DATABASE_URL;
test.skipIf(!connectionString)(
  "search owns authorization, exact output and a read snapshot (U5)",
  async () => {
    if (!connectionString) throw new Error("Missing database URL");
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const namespace = `loom_search_tx_${suffix}`;
    const metadataNamespace = `loom_search_meta_${suffix}`;
    const role = `loom_search_reader_${suffix}`;
    const { schema, relations } = createSearchFixture(namespace);
    const owner = new pg.Pool({ connectionString });
    const seed = drizzle({ client: owner, relations });
    try {
      const empty = await generateDrizzleJson({}, undefined, [namespace]);
      const snapshot = await generateDrizzleJson({ namespace: pgSchema(namespace), ...schema.tables }, empty.id, [
        namespace,
      ]);
      for (const statement of await generateMigration(empty, snapshot)) await owner.query(statement);
      await bootstrapDatabase({ connectionString, metadataNamespace, runtimeRole: role });
      const actor = await owner.query<{ name: string }>("SELECT current_user AS name");
      const ownerName = actor.rows[0]?.name;
      if (!ownerName) throw new Error("Missing fixture owner");
      await owner.query(`GRANT "${role}" TO "${ownerName.replaceAll('"', '""')}"`);
      await owner.query(`ALTER ROLE "${role}" LOGIN PASSWORD 'loom-test-only'`);
      const tables = Object.values(schema.tables)
        .map((table) => `"${namespace}"."${getTableName(table)}"`)
        .join(", ");
      await owner.query(`GRANT USAGE ON SCHEMA "${namespace}" TO "${role}"`);
      await owner.query(`GRANT SELECT ON TABLE ${tables} TO "${role}"`);
      const base = { done: false, at: new Date("2026-01-01"), count: 9007199254740993n, amount: "1.0001" };
      await seed
        .insert(schema.tables.tasks)
        .values([
          ...["A", "B", "C", "D", "E"].map((title) => ({ ...base, title, owner: "alice" })),
          { ...base, title: "Z", owner: "bob" },
        ]);
      const [label] = await seed.insert(schema.tables.labels).values({ name: "visible", owner: "alice" }).returning();
      const tasks = await seed.query.tasks.findMany({ orderBy: { title: "asc" } });
      if (!label || !tasks[0] || !tasks[1]) throw new Error("Missing seed");
      await seed.insert(schema.tables.taskLabels).values([
        { taskId: tasks[0]._id, labelId: label._id, owner: "alice" },
        { taskId: tasks[1]._id, labelId: label._id, owner: "bob" },
      ]);
      const address = new URL(connectionString);
      address.username = role;
      address.password = "loom-test-only";
      const connection = await connectDatabase({
        schema,
        relations,
        connectionString: address.href,
        maxConnections: 1,
      });
      const statements: string[] = [];
      let beforeCount: (() => Promise<void>) | undefined;
      let countLock: number | undefined;
      const observed = new WeakSet<pg.PoolClient>();
      connection.pool.on("acquire", (client) => {
        if (observed.has(client)) return;
        observed.add(client);
        client.query = new Proxy(client.query, {
          apply(target, receiver, args) {
            const config = v.safeParse(v.union([v.string(), v.object({ text: v.string() })]), args[0]);
            const text = config.success ? (v.is(v.string(), config.output) ? config.output : config.output.text) : "";
            statements.push(text);
            if (text.includes("count(*)::text") && countLock !== undefined) {
              // Keep the native count running inside PostgreSQL, after its root
              // query has finished, until the independent session releases it.
              args[0] = {
                ...args[0],
                text: text.replace("count(*)::text", `count(*)::text, pg_advisory_xact_lock(${countLock}::bigint)`),
              };
            }
            if (text.includes("count(*)::text") && beforeCount) {
              const barrier = beforeCount;
              beforeCount = undefined;
              return barrier().then(() => Function.prototype.apply.call(target, receiver, args));
            }
            return Function.prototype.apply.call(target, receiver, args);
          },
        });
      });
      try {
        const { procedure, validators } = createProjectProcedures(schema, relations);
        const read = createDatabaseMiddleware(relations, "read", schema);
        const policy = {
          scope: {
            name: "owner",
            version: "1",
            where: ({
              table,
              identity,
            }: {
              table: typeof schema.tables.tasks;
              identity: ProcedureContext["identity"];
            }) => eq(table.owner, identity?.subject ?? "anonymous"),
          },
          columns: ["title", "done", "at", "count", "amount"],
          filter: ["title", "done"],
          order: ["title"],
          through: {
            taskLabels: {
              name: "link-owner",
              version: "1",
              where: ({
                table,
                identity,
              }: {
                table: typeof schema.tables.taskLabels;
                identity: ProcedureContext["identity"];
              }) => eq(table.owner, identity?.subject ?? "anonymous"),
            },
          },
          relations: {
            labels: {
              columns: ["name"],
              filter: ["name"],
              scope: {
                name: "label-owner",
                version: "1",
                where: ({
                  table,
                  identity,
                }: {
                  table: typeof schema.tables.labels;
                  identity: ProcedureContext["identity"];
                }) => eq(table.owner, identity?.subject ?? "anonymous"),
              },
            },
          },
        } as const;
        const finite = validators.tables.tasks.search(policy);
        const options = {
          connection,
          replay: { metadataNamespace, deployment: "search-test" },
          search: { branchId: "br-wispy-dew-awdp5g3y", key: "04".repeat(32), contract: "tasks/list" },
          authorize: async ({ identity }: ProcedureContext) => {
            if (!identity) throw new ORPCError("UNAUTHORIZED");
          },
        };
        let readonly = false;
        const authoredList = procedure
          .use(read)
          .input(finite.input)
          .output(finite.output)
          .handler(async ({ context, input }) => {
            const status = await context.db.execute<{ mode: string }>(
              sql`select current_setting('transaction_read_only') as mode`,
            );
            readonly = status.rows[0]?.mode === "on";
            return context.search.tasks.paginate(input);
          });
        const list = bindRpcDatabaseProcedure(authoredList, options);
        const { Search } = createProjectServices<typeof schema, typeof relations>();
        const effectList = bindRpcDatabaseProcedure(
          procedure
            .use(read)
            .input(finite.input)
            .output(finite.output)
            .effect(function* ({ input }) {
              const search = yield* Search;
              return yield* Effect.promise(() => search.tasks.paginate(input));
            }),
          options,
        );
        const contextFor = (subject: string | null): ProcedureContext => {
          const invocation = {
            identity: subject ? { issuer: "https://auth.test", subject } : null,
            requestId: crypto.randomUUID(),
            signal: new AbortController().signal,
          };
          return { ...invocation, "effect/context": Context.make(Invocation, invocation) };
        };
        const alice = contextFor("alice");
        const bob = contextFor("bob");
        const input = {
          columns: { title: true },
          orderBy: [{ field: "title", direction: "asc" }],
          limit: 2,
          count: true,
        } as const;
        const request = (selection: InferSchemaInput<typeof finite.input> = input, context = alice) =>
          call(list, selection, { context, path: ["tasks", "list"] });
        const first = await request();
        expect(first.rows).toEqual([{ title: "A" }, { title: "B" }]);
        expect(first.count).toBe("5");
        expect(await request(input, bob)).toMatchObject({ rows: [{ title: "Z" }], count: "1" });
        expect(
          (await request({ ...input, where: { OR: [{ title: { eq: "Z" } }, { NOT: { title: { eq: "none" } } }] } }))
            .count,
        ).toBe("5");
        await request(input, { ...alice, operation: "mutation" });
        expect(readonly).toBe(true);
        expect(await call(effectList, input, { context: alice, path: ["tasks", "list"] })).toMatchObject({
          rows: first.rows,
          count: first.count,
          nextCursor: expect.any(String),
          previousCursor: null,
        });
        statements.length = 0;
        expect(await request({ ...input, count: false })).not.toHaveProperty("count");
        expect(statements.some((text) => text.includes("count(*)"))).toBe(false);
        const membership = await request({
          ...input,
          where: { relations: { labels: { some: { name: { eq: "visible" } } } } },
          with: { labels: {} },
        });
        expect(membership.count).toBe("1");
        expect(membership.rows).toEqual([{ title: "A", labels: [{ name: "visible" }] }]);
        // Rows have completed when the driver reaches count. An independent writer
        // commits before the count is sent, proving both reads share a snapshot.
        beforeCount = async () => {
          await seed.insert(schema.tables.tasks).values({ ...base, title: "F", owner: "alice" });
        };
        expect((await request()).count).toBe("5");
        expect((await request()).count).toBe("6");
        expect(beforeCount).toBeUndefined();
        let enter: () => void = () => {};
        let release: () => void = () => {};
        const entered = new Promise<void>((resolve) => {
          enter = resolve;
        });
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        beforeCount = async () => {
          enter();
          await gate;
        };
        const forgotten = bindRpcDatabaseProcedure(
          procedure
            .use(read)
            .input(finite.input)
            .output(finite.output)
            .handler(({ context, input }) => {
              // Deliberately unawaited: the invocation must still own and drain this read.
              void context.search.tasks.paginate(input);
              return { rows: [{ title: "manual" }], count: "6", nextCursor: null, previousCursor: null };
            }),
          options,
        );
        let completed = false;
        const pending = call(forgotten, input, { context: alice }).then((result) => {
          completed = true;
          return result;
        });
        await entered;
        expect(completed).toBe(false);
        release();
        expect((await pending).count).toBe("6");
        const failedForgotten = bindRpcDatabaseProcedure(
          procedure
            .use(read)
            .input(finite.input)
            .output(finite.output)
            .handler(({ context, input }) => {
              // Force an async executor failure after starting otherwise valid work.
              void context.search.tasks.paginate(input);
              return { rows: [{ title: "manual" }], count: "6", nextCursor: null, previousCursor: null };
            }),
          { ...options, search: { ...options.search, key: "invalid" } },
        );
        await assert.rejects(call(failedForgotten, input, { context: alice }));
        const pathless = bindRpcDatabaseProcedure(authoredList, {
          ...options,
          search: { branchId: options.search.branchId, key: options.search.key },
        });
        const beforePathless = statements.length;
        await assert.rejects(call(pathless, input, { context: alice }), { code: "INTERNAL_SERVER_ERROR" });
        expect(statements.length).toBe(beforePathless);
        const another = bindRpcDatabaseProcedure(authoredList, {
          ...options,
          search: { ...options.search, contract: "tasks/another" },
        });
        await assert.rejects(call(another, { ...input, cursor: first.nextCursor }, { context: alice }));
        await seed.insert(schema.tables.tasks).values([
          { ...base, title: "0", owner: "alice" },
          { ...base, title: "BB", owner: "alice" },
        ]);
        expect((await request({ ...input, cursor: first.nextCursor, limit: 10 })).rows).toEqual(
          ["BB", "C", "D", "E", "F"].map((title) => ({ title })),
        );
        await seed.delete(schema.tables.tasks).where(eq(schema.tables.tasks.title, "C"));
        await seed.update(schema.tables.tasks).set({ title: "CC" }).where(eq(schema.tables.tasks.title, "A"));
        await seed.update(schema.tables.tasks).set({ owner: "bob" }).where(eq(schema.tables.tasks.title, "D"));
        expect((await request({ ...input, cursor: first.nextCursor, limit: 10 })).rows).toEqual(
          ["BB", "CC", "E", "F"].map((title) => ({ title })),
        );
        expect((await request({ ...input, limit: 10 })).rows).toEqual(
          ["0", "B", "BB", "CC", "E", "F"].map((title) => ({ title })),
        );
        let escaped: (() => Promise<object>) | undefined;
        const capture = bindRpcDatabaseProcedure(
          procedure
            .use(read)
            .input(finite.input)
            .output(finite.output)
            .handler(({ context, input }) => {
              escaped = () => context.search.tasks.paginate(input);
              return { rows: [{ title: "manual" }], nextCursor: null, previousCursor: null };
            }),
          options,
        );
        await call(capture, { columns: { title: true } }, { context: alice });
        expect(() => escaped?.()).toThrow("active search");
        const cancelled = new AbortController();
        cancelled.abort();
        await assert.rejects(request(input, { ...alice, signal: cancelled.signal }));
        const bounded = <Result>(pending: Promise<Result>, milliseconds: number, message: string) => {
          const timer = new AbortController();
          return Promise.race([
            pending,
            setTimeout(milliseconds, undefined, { signal: timer.signal }).then(() => {
              throw new Error(message);
            }),
          ]).finally(() => timer.abort());
        };
        for (const scenario of ["root-cancel", "count-deadline", "forgotten-count-cancel"] as const) {
          const blocker = await owner.connect();
          const key = Number.parseInt(crypto.randomUUID().slice(0, 8), 16);
          const controller = new AbortController();
          const signal = controller.signal;
          let published = false;
          let pending: Promise<unknown> | undefined;
          const waitFor = async (predicate: () => Promise<boolean>) => {
            const expires = performance.now() + 3000;
            while (!(await predicate())) {
              if (performance.now() > expires) throw new Error(`Database barrier timed out: ${scenario}`);
              await setTimeout(10);
            }
          };
          try {
            await blocker.query("BEGIN");
            if (scenario === "root-cancel") {
              await blocker.query(`LOCK TABLE "${namespace}"."tasks" IN ACCESS EXCLUSIVE MODE`);
            } else {
              await blocker.query("SELECT pg_advisory_xact_lock($1::bigint)", [key]);
              countLock = key;
            }
            pending = call(scenario === "forgotten-count-cancel" ? forgotten : list, input, {
              context: { ...alice, signal },
              path: ["tasks", "list"],
            }).then((result) => {
              published = true;
              return result;
            });
            // Observe a real blocked SELECT before aborting. The lock remains
            // held until rejection and transaction-disposal assertions finish.
            await waitFor(async () => {
              const activity = await owner.query(
                "SELECT 1 FROM pg_stat_activity WHERE usename = $1 AND state = 'active' AND wait_event_type = 'Lock' AND query LIKE $2",
                [role, scenario === "root-cancel" ? `%"${namespace}"."tasks"%` : "%pg_advisory_xact_lock%"],
              );
              return activity.rowCount === 1;
            });
            const abortedAt = performance.now();
            if (scenario === "count-deadline") {
              // Arm the native deadline only after the count is demonstrably
              // blocked, so connection latency cannot consume the test budget.
              const deadline = AbortSignal.timeout(100);
              deadline.addEventListener("abort", () => controller.abort(deadline.reason), { once: true });
            } else controller.abort(new Error(`Cancelled ${scenario}`));
            await assert.rejects(
              bounded(pending, 3500, `Search did not stop while SQL was blocked: ${scenario}`),
              (error: Error) => !error.message.includes("Search did not stop"),
            );
            expect(performance.now() - abortedAt).toBeLessThan(3500);
            expect(signal.aborted).toBe(true);
            if (scenario === "count-deadline") expect(signal.reason.name).toBe("TimeoutError");
            expect(published).toBe(false);
            await waitFor(async () => {
              const activity = await owner.query(
                "SELECT 1 FROM pg_stat_activity WHERE usename = $1 AND (state = 'active' OR state LIKE 'idle in transaction%')",
                [role],
              );
              return activity.rowCount === 0;
            });
            await waitFor(async () => connection.pool.idleCount === connection.pool.totalCount);
            expect(connection.pool.waitingCount).toBe(0);
            expect(connection.pool.idleCount).toBe(connection.pool.totalCount);
          } finally {
            countLock = undefined;
            await blocker.query("ROLLBACK");
            blocker.release();
            await pending?.catch(() => {});
          }
          // Releasing the barrier must not publish a late page, and the same
          // single-slot pool must serve a fresh authorized snapshot afterwards.
          expect(published).toBe(false);
          expect((await request()).count).toBe("6");
        }
        const operationEntered = Promise.withResolvers<void>();
        const operationRelease = Promise.withResolvers<void>();
        const lateOperation = Promise.withResolvers<void>();
        const callbackCancelled = new AbortController();
        const callbackReason = new Error("Cancelled suspended handler");
        const suspended = runFunctionTransaction(
          connection,
          "query",
          async (tx) => {
            await tx.execute(sql`select 1`);
            operationEntered.resolve();
            await operationRelease.promise;
            try {
              await assert.rejects(tx.execute(sql`select 1`), /inactive/i);
            } finally {
              lateOperation.resolve();
            }
          },
          { signal: callbackCancelled.signal },
        );
        try {
          await operationEntered.promise;
          callbackCancelled.abort(callbackReason);
          await assert.rejects(
            bounded(suspended, 1500, "Suspended handler stayed active"),
            (error) => error === callbackReason,
          );
          // Abort rejects promptly while its TLS cancellation transport retains
          // the original pooler mapping until PostgreSQL accepts the request.
          expect((await request()).count).toBe("6");
          expect(connection.pool.idleCount).toBe(connection.pool.totalCount);
        } finally {
          operationRelease.resolve();
          await suspended.catch(() => {});
          await lateOperation.promise;
        }
        const heldClient = await connection.pool.connect();
        const heldBackend = await heldClient.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        const heldPid = heldBackend.rows[0]?.pid;
        let removedClients = 0;
        const removed = () => {
          removedClients++;
        };
        connection.pool.on("remove", removed);
        const queuedCancelled = new AbortController();
        const queuedReason = new Error("Cancelled queued acquisition");
        let queuedStarted = false;
        const queued = runFunctionTransaction(
          connection,
          "query",
          async () => {
            queuedStarted = true;
          },
          { signal: queuedCancelled.signal },
        );
        try {
          const expires = performance.now() + 3000;
          while (connection.pool.waitingCount !== 1) {
            if (performance.now() > expires) throw new Error("Acquisition did not queue");
            await setTimeout(10);
          }
          queuedCancelled.abort(queuedReason);
          await assert.rejects(
            bounded(queued, 1500, "Queued acquisition stayed active"),
            (error) => error === queuedReason,
          );
          expect(queuedStarted).toBe(false);
        } finally {
          heldClient.release();
          await queued.catch(() => {});
        }
        try {
          expect((await request()).count).toBe("6");
          const reusedBackend = await connection.pool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
          expect(reusedBackend.rows[0]?.pid).toBe(heldPid);
          expect(removedClients).toBe(0);
          expect(queuedStarted).toBe(false);
          expect(connection.pool.waitingCount).toBe(0);
          expect(connection.pool.idleCount).toBe(connection.pool.totalCount);
        } finally {
          connection.pool.off("remove", removed);
        }
        const manual = bindRpcDatabaseProcedure(
          procedure
            .use(read)
            .input(finite.input)
            .output(finite.output)
            .handler(() => ({ rows: [{ title: "hidden", owner: "private" }], nextCursor: null, previousCursor: null })),
          options,
        );
        const wrongEffect = bindRpcDatabaseProcedure(
          procedure
            .use(read)
            .input(finite.input)
            .output(finite.output)
            .effect(function* () {
              yield* Effect.succeed(undefined);
              return { rows: [{ title: 1 }], nextCursor: null, previousCursor: null };
            }),
          options,
        );
        await assert.rejects(call(manual, { columns: { title: true } }, { context: alice }), {
          code: "INTERNAL_SERVER_ERROR",
        });
        await assert.rejects(call(wrongEffect, { columns: { title: true } }, { context: alice }), {
          code: "INTERNAL_SERVER_ERROR",
        });
        const wrongMiddleware = bindRpcDatabaseProcedure(
          procedure
            .use(read)
            .use(async ({ next }) => ({
              ...(await next()),
              output: { rows: [{ title: "visible", done: false }], nextCursor: null, previousCursor: null },
            }))
            .input(finite.input)
            .output(finite.output)
            .handler(() => ({ rows: [{ title: "visible" }], nextCursor: null, previousCursor: null })),
          options,
        );
        await assert.rejects(call(wrongMiddleware, { columns: { title: true } }, { context: alice }), {
          code: "INTERNAL_SERVER_ERROR",
        });
        const router = { list, manual };
        const http = new HttpHandler(router);
        let transportContext = alice;
        const server = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          async fetch(request) {
            return (
              (await http.handle(request, { context: transportContext })).response ??
              new Response("Not found", { status: 404 })
            );
          },
        });
        try {
          const clients = [createORPCClient<RouterClient<typeof router>>(new HttpLink({ origin: server.url.origin }))];
          for (const client of clients) {
            expect((await client.list(input)).count).toBe("6");
            await assert.rejects(client.manual({ columns: { title: true } }), { code: "INTERNAL_SERVER_ERROR" });
            transportContext = contextFor(null);
            statements.length = 0;
            await assert.rejects(client.list(input), { code: "UNAUTHORIZED" });
            expect(statements.some((text) => text.includes(`"${namespace}"."tasks"`))).toBe(false);
            transportContext = alice;
          }
          statements.length = 0;
          await assert.rejects(request(input, contextFor(null)), { code: "UNAUTHORIZED" });
          expect(statements.some((text) => text.includes(`"${namespace}"."tasks"`))).toBe(false);
        } finally {
          await server.stop(true);
        }
      } finally {
        await connection.close();
      }
    } finally {
      await owner.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
      await owner.query(`DROP SCHEMA IF EXISTS "${metadataNamespace}" CASCADE`);
      if ((await owner.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role])).rowCount) {
        await owner.query(`DROP OWNED BY "${role}"`);
        await owner.query(`DROP ROLE "${role}"`);
      }
      await owner.end();
    }
  },
  120_000,
);
