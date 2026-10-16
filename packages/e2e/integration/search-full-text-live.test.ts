import assert from "node:assert/strict";
import { test } from "bun:test";
import pg from "pg";
import { Context } from "effect";
import { getTableName, sql } from "drizzle-orm";
import { pgSchema } from "drizzle-orm/pg-core";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api-postgres";
import { RPCLink } from "@orpc/client/websocket";
import { RPCHandler } from "@orpc/server/websocket";
import { ORPCError } from "@orpc/server";
import * as v from "valibot";
import { createRpcRuntime, defineRpcAuth, Invocation } from "../../../apps/loom/src/core/server/index";
import type { JsonValue, ProcedureContext } from "../../../apps/loom/src/core/server/index";
import { bootstrapDatabase, installRevisionTracking } from "../../../apps/loom/src/tooling/index";
import { fullTextLiveFixture } from "../fixtures/search-full-text-live";
import { fullTextLocalTarget } from "./full-text-local-target";

// Mandatory preconnection guard; no missing-target skip is an acceptance result.
const connectionString = fullTextLocalTarget(process.env.LOOM_TEST_DATABASE_URL);
const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const output = v.strictObject({
  pages: v.array(
    v.array(
      v.strictObject({
        label: v.string(),
        labels: v.array(v.strictObject({ name: v.string() })),
      }),
    ),
  ),
  count: v.string(),
  nextCursor: v.nullable(v.string()),
  previousCursor: v.nullable(v.string()),
});
const iterator = v.custom<AsyncIteratorObject<unknown, unknown>>((value) =>
  v.is(v.object({ next: v.function() }), value),
);
const selection = {
  columns: { label: true },
  with: { labels: { columns: { name: true } } },
  fullText: { document: "content", query: "quasar" },
  limit: 2,
  loadedPages: 2,
  count: true,
};

type NativeCallback = (error: Error, result: pg.QueryResult | pg.QueryArrayResult<unknown[]>) => void;
type NativeArguments =
  | [query: pg.Submittable]
  | [query: string | pg.QueryConfig, values?: pg.QueryConfigValues<unknown[]>]
  | [query: string | pg.QueryConfig, callback: NativeCallback]
  | [query: string, values: pg.QueryConfigValues<unknown[]>, callback: NativeCallback];
type NativeResult = pg.Submittable | Promise<pg.QueryResult | pg.QueryArrayResult<unknown[]>> | void;
interface NativeDispatch {
  apply(receiver: pg.PoolClient, args: NativeArguments): NativeResult;
}
type NativeCommand = { text: string; values: unknown[]; at: number };
type NativeConnection = { pid: number; commands: NativeCommand[] };

function blockedDeadline(connections: NativeConnection[], pid: number, query: string, since: number) {
  const connection = connections.find((entry) => entry.pid === pid);
  assert(connection, "Observe the actual blocked backend's owned connection");
  const position = connection.commands.findLastIndex(
    (command) =>
      command.at >= since &&
      /^\s*select\b/i.test(command.text) &&
      command.text.includes("@@") &&
      command.text.startsWith(query),
  );
  assert(position > 0, "Capture the actual blocked FTS SELECT, including truncated activity text");
  const command = connection.commands[position - 1];
  assert(command);
  assert.match(command.text, /select\s+set_config\('statement_timeout',\s*\$1,\s*true\)/i);
  assert.equal(command.values.length, 1);
  const applied = v.parse(v.pipe(v.string(), v.regex(/^[1-9]\d*ms$/)), command.values[0]);
  const milliseconds = Number(applied.slice(0, -2));
  assert(Number.isSafeInteger(milliseconds));
  const settings = connection.commands
    .slice(0, position - 1)
    .findLast(
      (entry) =>
        entry.at >= since && entry.text.includes("pg_catalog.pg_settings") && entry.text.includes("milliseconds"),
    );
  assert(settings, "Capture deadline's native settings read on the same connection");
  return { milliseconds, at: command.at, settingsAt: settings.at };
}

async function bounded<T>(work: Promise<T>, label: string, milliseconds = 15000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`U5 live barrier timed out: ${label}`)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Cadence is only for observation. Success requires the actual SQL predicate;
// elapsed time never establishes cancellation, invalidation or resource drain.
async function observe(check: () => Promise<boolean>, label: string, milliseconds = 4000) {
  const deadline = performance.now() + milliseconds;
  do {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (performance.now() < deadline);
  throw new Error(`U5 live SQL barrier failed: ${label}`);
}

// Checked-out clients are always returned; failed rollback destroys the socket.
// Retain rollback/release failures alongside the failure that brought us here.
async function withRollback(client: pg.PoolClient, work: () => Promise<void>) {
  let failed = false;
  let original: unknown;
  const cleanupErrors: unknown[] = [];
  try {
    await work();
  } catch (error) {
    failed = true;
    original = error;
    throw error;
  } finally {
    let destroy = false;
    try {
      await client.query("ROLLBACK");
    } catch (error) {
      destroy = true;
      cleanupErrors.push(error);
    } finally {
      try {
        client.release(destroy);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length)
      throw new AggregateError(
        failed ? [original, ...cleanupErrors] : cleanupErrors,
        "U5 live rollback/release failed",
        failed ? { cause: original } : undefined,
      );
  }
}

async function fixture(
  run: (value: {
    owner: pg.Pool;
    namespace: string;
    role: string;
    connections: NativeConnection[];
    poll: () => Promise<void>;
    open: () => {
      start: (input?: JsonValue, signal?: AbortSignal) => Promise<AsyncIteratorObject<unknown, unknown>>;
      close: () => Promise<void>;
    };
  }) => Promise<void>,
  fullTextTimeoutMs = 30000,
) {
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const namespace = `fts_live_${suffix}`;
  const metadataNamespace = `loom_fts_live_${suffix}`;
  const role = `fts_live_reader_${suffix}`;
  // Administrative SQL is server-bounded, including rollback and cleanup DDL.
  // Never race a SQL command against an unowned client-side timeout.
  const ownerAddress = new URL(connectionString);
  ownerAddress.searchParams.delete("statement_timeout");
  ownerAddress.searchParams.delete("lock_timeout");
  ownerAddress.searchParams.delete("idle_in_transaction_session_timeout");
  ownerAddress.searchParams.delete("transaction_timeout");
  ownerAddress.searchParams.set(
    "options",
    "-c statement_timeout=5000 -c lock_timeout=2000 -c idle_in_transaction_session_timeout=30000 -c transaction_timeout=60000",
  );
  const owner = new pg.Pool({
    connectionString: ownerAddress.href,
    max: 4,
    connectionTimeoutMillis: 5000,
    statement_timeout: 5000,
    lock_timeout: 2000,
  });
  let guarded = false;
  let runtime: Awaited<ReturnType<typeof createRpcRuntime>> | undefined;
  let server: ReturnType<typeof Bun.serve<string>> | undefined;
  const peers: { close: () => Promise<void> }[] = [];
  const evaluations: Promise<void>[] = [];
  let failed = false;
  let original: unknown;
  const connections: NativeConnection[] = [];
  let observedPool: pg.Pool | undefined;
  const observedClients = new WeakSet<pg.PoolClient>();
  try {
    const target = await owner.query<{ version: number; database: string }>(
      "SELECT current_setting('server_version_num')::int AS version, current_database() AS database",
    );
    assert.deepEqual(target.rows, [{ version: 180006, database: "kello_test" }]);
    guarded = true; // No DDL or fixture writes precede actual-target confirmation.
    console.info("U5 live fixture identities", JSON.stringify({ namespace, metadataNamespace, role }));
    const { schema, relations, watch } = fullTextLiveFixture(namespace, fullTextTimeoutMs);
    await bootstrapDatabase({ connectionString, metadataNamespace, runtimeRole: role });
    const empty = await generateDrizzleJson({}, undefined, [namespace]);
    const snapshot = await generateDrizzleJson({ namespace: pgSchema(namespace), ...schema.tables }, empty.id, [
      namespace,
    ]);
    await owner.query((await generateMigration(empty, snapshot)).join("\n"));
    await owner.query(`INSERT INTO "${namespace}".memberships (tenant,subject) VALUES ('tenant-a','alice')`);
    const admin = await owner.connect();
    await withRollback(admin, async () => {
      await admin.query("BEGIN");
      await installRevisionTracking(
        admin,
        namespace,
        metadataNamespace,
        Object.values(schema.tables).map(getTableName),
      );
      await admin.query("COMMIT");
    });
    await owner.query(`GRANT USAGE ON SCHEMA "${namespace}" TO "${role}"`);
    await owner.query(`GRANT SELECT ON ALL TABLES IN SCHEMA "${namespace}" TO "${role}"`);
    await owner.query(`ALTER ROLE "${role}" LOGIN PASSWORD 'fts-live-local-only'`);
    const address = new URL(connectionString);
    address.username = role;
    address.password = "fts-live-local-only";
    // Override inherited role/database/URL limits on every native connection.
    // These reader limits exceed the entire cancellation proof by a wide margin.
    address.searchParams.delete("statement_timeout");
    address.searchParams.delete("lock_timeout");
    address.searchParams.delete("idle_in_transaction_session_timeout");
    address.searchParams.delete("transaction_timeout");
    address.searchParams.set(
      "options",
      "-c statement_timeout=30000 -c lock_timeout=30000 -c idle_in_transaction_session_timeout=30000 -c transaction_timeout=60000",
    );
    runtime = await createRpcRuntime({
      schema,
      relations,
      connectionString: address.href,
      maxConnections: 2,
      version: "5".repeat(64),
      deployment: "fts-u5-live",
      metadataNamespace,
      branchId: "fts-u5-local",
      environment: { LOOM_SEARCH_CURSOR_KEY: "05".repeat(32) },
      config: { realtime: { pollIntervalMs: 60000 } },
      procedures: [{ path: ["documents", "watch"], visibility: "public", procedure: watch }],
      assertActive: async (_signal, database) => {
        if (!database || observedPool) return;
        // The runtime return value has no pool. Its existing activation seam
        // first supplies the root Drizzle database and its public native $client.
        // Later activation calls receive a transaction without $client; its
        // queries use this already-observed pool and must remain untouched.
        const { $client: pool } = v.parse(
          v.looseObject({
            $client: v.custom<pg.Pool>((value) => value instanceof pg.Pool),
          }),
          database.db,
        );
        observedPool = pool;
        pool.on("acquire", (client) => {
          if (observedClients.has(client)) return;
          observedClients.add(client);
          const { processID: pid } = v.parse(v.looseObject({ processID: v.number() }), client);
          const connection: NativeConnection = { pid, commands: [] };
          connections.push(connection);
          client.query = new Proxy(client.query, {
            apply(target, receiver, args: NativeArguments) {
              const dispatch: NativeDispatch = target;
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
              if (parsed.success) {
                const values = v.safeParse(v.array(v.unknown()), args[1]);
                connection.commands.push({
                  text: parsed.output.text,
                  values: [...(values.success ? values.output : parsed.output.values)],
                  at: performance.now(),
                });
              }
              // Observe only; preserve native arguments, receiver and result.
              return dispatch.apply(receiver, args);
            },
          });
        });
      },
      auth: defineRpcAuth({
        // Opaque SQL deliberately supplies no trusted dependency metadata.
        // Membership changes must still invalidate even though FTS uses documents.
        authorize: async ({ db, identity }) => {
          if (!identity) throw new ORPCError("UNAUTHORIZED");
          if (!db) return;
          const timeouts = await db.execute<{
            statement: number;
            lock: number;
            idleTransaction: number;
            transaction: number;
          }>(sql`
            SELECT (SELECT setting::int FROM pg_catalog.pg_settings WHERE name='statement_timeout') AS statement,
              (SELECT setting::int FROM pg_catalog.pg_settings WHERE name='lock_timeout') AS lock,
              (SELECT setting::int FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout') AS "idleTransaction",
              (SELECT setting::int FROM pg_catalog.pg_settings WHERE name='transaction_timeout') AS transaction`);
          assert.deepEqual(
            timeouts.rows,
            [{ statement: 30000, lock: 30000, idleTransaction: 30000, transaction: 60000 }],
            "Inherited PostgreSQL timeouts must not masquerade as epoch cancellation",
          );
          const mode = await db.execute<{ transaction_read_only: string }>(sql`SHOW transaction_read_only`);
          assert.equal(mode.rows[0]?.transaction_read_only, "on");
          const allowed = await db.execute<{ allowed: boolean }>(sql`
            SELECT EXISTS (SELECT 1 FROM ${sql.identifier(namespace)}.memberships
            WHERE tenant=${identity.tenantId} AND subject=${identity.subject}) AS allowed`);
          if (!allowed.rows[0]?.allowed) throw new ORPCError("FORBIDDEN");
        },
      }),
    });
    const handler = new RPCHandler(runtime.router);
    // Each transport gets its own invocation lifetime, as on the real server.
    const contexts = new Map<
      string,
      {
        controller: AbortController;
        context: ProcedureContext;
      }
    >();
    server = Bun.serve<string>({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, server) {
        const key = new URL(request.url).pathname;
        if (contexts.has(key) && server.upgrade(request, { data: key })) return;
        return new Response(null, { status: 400 });
      },
      websocket: {
        async message(socket, message) {
          const peer = contexts.get(socket.data);
          assert(peer);
          await handler.message(socket, message, { context: peer.context });
        },
        async close(socket) {
          contexts.get(socket.data)?.controller.abort();
          await handler.close(socket);
        },
      },
    });
    const open = () => {
      const key = `/${crypto.randomUUID()}`;
      const controller = new AbortController();
      const invocation = {
        identity: { issuer: "https://fts-live.test", subject: "alice", tenantId: "tenant-a" },
        requestId: crypto.randomUUID(),
        signal: controller.signal,
      };
      contexts.set(key, {
        controller,
        context: {
          ...invocation,
          expiresAt: Math.floor(Date.now() / 1000) + 180,
          "effect/context": Context.make(Invocation, invocation),
        },
      });
      const socket = new WebSocket(`ws://127.0.0.1:${server!.port}${key}`);
      const link = new RPCLink({ connect: () => socket });
      const peer = {
        start: async (input: JsonValue = selection, signal?: AbortSignal) =>
          v.parse(
            iterator,
            await bounded(link.call(["documents", "watch"], input, { context: {}, signal }), "route start"),
          ),
        close: async () => {
          controller.abort();
          socket.close();
        },
      };
      peers.push(peer);
      return peer;
    };
    const current = runtime;
    await run({
      owner,
      namespace,
      role,
      connections,
      open,
      poll: () => {
        const evaluation = current.realtime.coordinator.poll();
        evaluations.push(evaluation);
        // Retain every dispatched evaluation until cleanup observes settlement,
        // including an assertion failure before its ordinary await is reached.
        void evaluation.catch(() => {});
        return evaluation;
      },
    });
  } catch (error) {
    failed = true;
    original = error;
    throw error;
  } finally {
    const cleanupErrors: unknown[] = [];
    const attempt = async <Result>(work: () => Promise<Result>): Promise<void> => {
      try {
        await work();
      } catch (error) {
        cleanupErrors.push(error);
      }
    };
    for (const peer of peers) await attempt(() => peer.close());
    await attempt(async () => {
      await server?.stop(true);
    });
    // Keep the shutdown promise owned even if its observation bound expires.
    // Termination is cleanup only, after the proof and its held-lock assertions.
    const stopping = Promise.resolve().then(() => runtime?.stop());
    // If shutdown remains unresolved, the parent command handle stays active.
    // Emit only fixture identities, never the connection URL or credentials.
    let phase = "awaiting actual runtime shutdown settlement";
    const diagnostic = setTimeout(
      () =>
        console.error(
          "U5 live cleanup unresolved",
          JSON.stringify({
            role,
            namespace,
            metadataNamespace,
            phase,
            recoveryOwner: "active parent command handle",
          }),
        ),
      10000,
    );
    try {
      await attempt(() => bounded(stopping, "runtime stop", 10000));
      if (guarded) {
        await attempt(() =>
          owner.query(
            "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename=$1 AND pid<>pg_backend_pid()",
            [role],
          ),
        );
      }
      await attempt(() => stopping);
      phase = "awaiting dispatched coordinator evaluation settlement";
      for (const result of await Promise.allSettled(evaluations)) {
        if (result.status === "rejected") cleanupErrors.push(result.reason);
      }
    } finally {
      clearTimeout(diagnostic);
    }
    if (guarded) {
      await attempt(() => owner.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`));
      await attempt(() => owner.query(`DROP SCHEMA IF EXISTS "${metadataNamespace}" CASCADE`));
      await attempt(() => owner.query(`DROP ROLE IF EXISTS "${role}"`));
    }
    // Every fixture checkout has already released/destroyed in withRollback.
    await attempt(() => owner.end());
    if (cleanupErrors.length)
      throw new AggregateError(
        failed ? [original, ...cleanupErrors] : cleanupErrors,
        "U5 live fixture cleanup failed",
        failed ? { cause: original } : undefined,
      );
  }
}

async function next(stream: AsyncIteratorObject<unknown, unknown>) {
  const value = await bounded(stream.next(), "replacement event");
  assert(!value.done, "Live route ended before the expected replacement");
  return v.parse(output, value.value);
}

type OracleRow = { _id: string; label: string; labels: { name: string }[]; rankBits: string; rankValue: string };
async function oracle(owner: pg.Pool, namespace: string, query = "quasar", anchor?: OracleRow) {
  // Independent authorization + weighted vector + rank + deterministic tie order.
  // Do not import the framework expression, pagination or rank builders here.
  const vector =
    "setweight(to_tsvector('pg_catalog.simple'::regconfig,coalesce(d.title,'')),'A') || setweight(to_tsvector('pg_catalog.simple'::regconfig,coalesce(d.body,'')),'D')";
  const rank = `ts_rank_cd(ARRAY[0.1,0.2,0.4,1.0]::real[],(${vector}),plainto_tsquery('pg_catalog.simple'::regconfig,$1),32)::real`;
  return (
    await owner.query<OracleRow>(
      `
    SELECT d._id,d.label,encode(pg_catalog.float4send(${rank}),'hex') AS "rankBits",(${rank})::text AS "rankValue",
      coalesce((SELECT jsonb_agg(jsonb_build_object('name',l.name) ORDER BY l._id)
        FROM "${namespace}"."document_labels" j JOIN "${namespace}".labels l ON l._id=j.label_id
        WHERE j.document_id=d._id),'[]'::jsonb) AS labels
    FROM "${namespace}".documents d
    WHERE d.tenant=$2 AND EXISTS (SELECT 1 FROM "${namespace}".memberships m WHERE m.tenant=d.tenant AND m.subject=$3)
      AND (${vector}) @@ plainto_tsquery('pg_catalog.simple'::regconfig,$1)
      ${anchor ? `AND (${rank} < $4::real OR (${rank} = $4::real AND d._id > $5::uuid))` : ""}
    ORDER BY ${rank} DESC,d._id ASC`,
      anchor ? [query, "tenant-a", "alice", anchor.rankValue, anchor._id] : [query, "tenant-a", "alice"],
    )
  ).rows;
}

async function drain(owner: pg.Pool, role: string, milliseconds = 4000) {
  await observe(
    async () => {
      const rows = await owner.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM pg_stat_activity WHERE usename=$1 AND (state='active' OR state LIKE 'idle in transaction%')",
        [role],
      );
      return rows.rows[0]?.count === 0;
    },
    "no owned active query or idle transaction",
    milliseconds,
  );
}

test("U5 real FTS watcher replaces authorized ranked windows after external root, child, junction and membership writes", async () => {
  await fixture(async ({ owner, namespace, role, open, poll }) => {
    const peer = open();
    const stream = await peer.start();
    const empty = await next(stream);
    assert.deepEqual(empty, { pages: [], count: "0", nextCursor: null, previousCursor: null });
    async function check(pages = 2, target = stream) {
      const expected = await oracle(owner, namespace);
      await poll();
      const event = await next(target);
      const visible = expected.slice(0, pages * 2).map(({ label, labels }) => ({ label, labels }));
      const chunks = Array.from({ length: Math.ceil(visible.length / 2) }, (_, i) => visible.slice(i * 2, i * 2 + 2));
      assert.deepEqual(event.pages, chunks);
      assert.equal(event.count, String(expected.length));
      assert.equal(new Set(event.pages.flat().map((row) => row.label)).size, visible.length);
      assert.equal(event.nextCursor !== null, expected.length > pages * 2);
      assert.equal(event.previousCursor, null);
      await drain(owner, role);
      return event;
    }
    // Insert into an observed zero-row window, including a forbidden higher rank.
    for (const [n, tenant, title, body] of [
      [1, "tenant-a", "quasar", null],
      [2, "tenant-a", null, "quasar"],
      [3, "tenant-a", "quasar quasar", null],
      [4, "tenant-a", "quasar", "quasar"],
      [5, "tenant-a", "quasar", null],
      [6, "tenant-a", "quasar", null],
      [7, "tenant-b", "quasar ".repeat(20), null],
    ] as const) {
      await owner.query(`INSERT INTO "${namespace}".documents (_id,tenant,label,title,body) VALUES ($1,$2,$3,$4,$5)`, [
        id(n),
        tenant,
        `doc-${n}`,
        title,
        body,
      ]);
    }
    await check();
    await owner.query(`UPDATE "${namespace}".documents SET title=repeat('quasar ',10),body=NULL WHERE _id=$1`, [id(2)]);
    const reranked = await check();
    assert.equal(reranked.pages[0]?.[0]?.label, "doc-2");
    await owner.query(`DELETE FROM "${namespace}".documents WHERE _id=$1`, [id(3)]);
    await check();
    await owner.query(`INSERT INTO "${namespace}".labels (_id,name) VALUES ($1,'old')`, [id(100)]);
    await owner.query(`INSERT INTO "${namespace}".document_labels (_id,document_id,label_id) VALUES ($1,$2,$3)`, [
      id(101),
      id(2),
      id(100),
    ]);
    const linked = await check();
    assert.deepEqual(linked.pages[0]?.[0]?.labels, [{ name: "old" }]);
    await owner.query(`UPDATE "${namespace}".labels SET name='new' WHERE _id=$1`, [id(100)]);
    const child = await check();
    assert.deepEqual(child.pages[0]?.[0]?.labels, [{ name: "new" }]);
    await owner.query(`DELETE FROM "${namespace}".document_labels WHERE _id=$1`, [id(101)]);
    assert.deepEqual((await check()).pages[0]?.[0]?.labels, []);

    for (let n = 8; n <= 15; n++) {
      await owner.query(
        `INSERT INTO "${namespace}".documents (_id,tenant,label,body) VALUES ($1,'tenant-a',$2,'quasar')`,
        [id(n), `doc-${n}`],
      );
    }
    await check();

    // Grow a real non-null live anchor, preserving its original boundary.
    const base = await oracle(owner, namespace);
    const boundary = base[3];
    assert(boundary);
    const window = await peer.start();
    const initial = await next(window);
    assert(initial.nextCursor);
    await bounded<unknown>(window.return?.() ?? Promise.resolve(), "anchor issuer close");
    const small = await peer.start({ ...selection, loadedPages: 1, anchor: initial.nextCursor });
    const smallValue = await next(small);
    const grown = await peer.start({ ...selection, loadedPages: 3, anchor: initial.nextCursor });
    const grownValue = await next(grown);
    const afterBoundary = (await oracle(owner, namespace, "quasar", boundary)).map(({ label, labels }) => ({
      label,
      labels,
    }));
    assert(afterBoundary.length > 6, "Anchor fixture must actually grow the loaded window");
    assert.deepEqual(smallValue.pages.flat(), afterBoundary.slice(0, 2));
    assert.deepEqual(grownValue.pages.flat(), afterBoundary.slice(0, 6));
    assert.equal(grownValue.count, String(base.length));
    assert.deepEqual(grownValue.pages.flat().slice(0, 2), smallValue.pages.flat());
    assert.equal(smallValue.pages.length, 1);
    assert.equal(grownValue.pages.length, 3);
    assert(grownValue.nextCursor && grownValue.previousCursor);
    // Move the first loaded row across the original anchor: both the small
    // and grown windows must admit a different trailing row.
    const moved = (await oracle(owner, namespace, "quasar", boundary))[0];
    assert(moved);
    assert.equal(smallValue.pages[0]?.[0]?.label, moved.label);
    await owner.query(`UPDATE "${namespace}".documents SET title=repeat('quasar ',20),body=NULL WHERE _id=$1`, [
      moved._id,
    ]);
    await poll();
    const anchoredReplacement = await next(grown);
    const afterMove = await oracle(owner, namespace, "quasar", boundary);
    const anchoredRows = afterMove.slice(0, 6).map(({ label, labels }) => ({ label, labels }));
    const rootAfterMove = await oracle(owner, namespace);
    const movedIndex = rootAfterMove.findIndex(({ _id }) => _id === moved._id);
    const boundaryIndex = rootAfterMove.findIndex(({ _id }) => _id === boundary._id);
    assert(movedIndex >= 0 && boundaryIndex > movedIndex, "The loaded row must cross the saved anchor");
    assert(!afterMove.some(({ _id }) => _id === moved._id));
    assert.notDeepEqual(anchoredRows, grownValue.pages.flat());
    assert.notDeepEqual(anchoredRows.slice(0, 2), smallValue.pages.flat());
    assert.deepEqual(anchoredRows[1], afterBoundary[2], "Small window admits its former first excluded row");
    assert.deepEqual(anchoredRows[5], afterBoundary[6], "Grown window admits its former first excluded row");
    assert.deepEqual(anchoredReplacement.pages, [
      anchoredRows.slice(0, 2),
      anchoredRows.slice(2, 4),
      anchoredRows.slice(4, 6),
    ]);
    assert.equal(anchoredReplacement.count, String((await oracle(owner, namespace)).length));
    assert(!anchoredReplacement.pages.flat().some(({ label }) => label === moved.label));
    const smallReplacement = await next(small);
    assert.deepEqual(smallReplacement.pages, [anchoredRows.slice(0, 2)]);
    assert.equal(smallReplacement.count, anchoredReplacement.count);
    const rootReplacement = await next(stream);
    assert.deepEqual(
      rootReplacement.pages.flat(),
      (await oracle(owner, namespace)).slice(0, 4).map(({ label, labels }) => ({ label, labels })),
    );
    assert.equal(rootReplacement.count, anchoredReplacement.count);
    await bounded<unknown>(small.return?.() ?? Promise.resolve(), "small window close");
    await bounded<unknown>(grown.return?.() ?? Promise.resolve(), "grown window close");

    // Revoke only opaque-auth membership. FTS roots/relations do not change.
    await owner.query(`DELETE FROM "${namespace}".memberships WHERE tenant='tenant-a' AND subject='alice'`);
    assert.deepEqual(await oracle(owner, namespace), []);
    const rejected = stream.next();
    const rejection = assert.rejects(bounded(rejected, "membership revocation"), { code: "FORBIDDEN" });
    // Observe both immediately and settle both even when evaluation fails.
    const revocation = await Promise.allSettled([rejection, Promise.resolve().then(poll)]);
    const revocationErrors = revocation.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
    if (revocationErrors.length) throw new AggregateError(revocationErrors, "U5 membership revocation failed");
    await drain(owner, role);
    await peer.close();
    const revoked = open();
    await assert.rejects(
      async () => {
        const denied = await revoked.start();
        await next(denied);
      },
      { code: "FORBIDDEN" },
    );
    await revoked.close();
    await drain(owner, role);
  });
}, 120000);

test("U5 cancelling an active FTS epoch drains locked SQL before reconnecting to a fresh window", async () => {
  await fixture(async ({ owner, namespace, role, connections, open, poll }) => {
    await owner.query(
      `INSERT INTO "${namespace}".documents (_id,tenant,label,title) VALUES ($1,'tenant-a','old','quasar'),($2,'tenant-a','fresh','nebula')`,
      [id(1), id(2)],
    );
    const peer = open();
    const cancellation = new AbortController();
    const stream = await peer.start(selection, cancellation.signal);
    assert.deepEqual((await next(stream)).pages.flat(), [{ label: "old", labels: [] }]);
    const locker = await owner.connect();
    await withRollback(locker, async () => {
      await locker.query("BEGIN");
      // Revision commits first; then a distinct transaction blocks the next RQB SELECT.
      await owner.query(`UPDATE "${namespace}".documents SET body='quasar' WHERE _id=$1`, [id(1)]);
      await locker.query(`LOCK TABLE "${namespace}".documents IN ACCESS EXCLUSIVE MODE`);
      type EpochResult = { kind: "value"; value: IteratorResult<unknown, unknown> } | { kind: "error"; error: Error };
      const event = stream.next().then<EpochResult, EpochResult>(
        (value) => ({ kind: "value", value }),
        (error) => ({ kind: "error", error: v.parse(v.instance(Error), error) }),
      );
      const cancellationStarted = performance.now();
      const remaining = () => {
        const milliseconds = 4000 - (performance.now() - cancellationStarted);
        assert(milliseconds > 0, "Cancellation exceeded its single end-to-end 4s bound");
        return milliseconds;
      };
      const evaluation = poll();
      // Attach immediately: failure may arrive while the SQL barrier is observed.
      void evaluation.catch(() => {});
      await observe(
        async () => {
          const result = await owner.query<{ pid: number; query: string }>(
            "SELECT pid,query FROM pg_stat_activity WHERE usename=$1 AND state='active' AND wait_event_type='Lock' AND query LIKE $2",
            [role, `%${namespace}%documents%`],
          );
          if (result.rows.length !== 1) return false;
          const blocked = result.rows[0];
          assert(blocked);
          const deadline = blockedDeadline(connections, blocked.pid, blocked.query, cancellationStarted);
          assert(
            deadline.milliseconds > 4000,
            "Actual timeout immediately before blocked FTS SELECT must exceed the entire cancellation bound",
          );
          return true;
        },
        "old epoch reached actual blocked FTS SELECT",
        remaining(),
      );
      cancellation.abort(new DOMException("replace active epoch", "AbortError"));
      const settled = await bounded(event, "cancelled transport event", remaining());
      if (settled.kind === "error") {
        assert(settled.error instanceof Error);
        assert.equal(settled.error.name, "AbortError", "A query failure is not caller cancellation");
      } else {
        assert(settled.value.done, "Cancelled epoch published a stale replacement");
      }
      await bounded(evaluation, "cancelled coordinator evaluation", remaining());
      // Check while the lock is STILL held: releasing it cannot manufacture drain.
      await drain(owner, role, remaining());
      const held = await locker.query<{ held: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND relation=$1::regclass AND mode='AccessExclusiveLock' AND granted) AS held",
        [`${namespace}.documents`],
      );
      assert.deepEqual(held.rows, [{ held: true }], "SQL must drain while the conflicting lock is still held");
      remaining();
      await peer.close();
    });
    const reconnected = open();
    const current = await reconnected.start({ ...selection, fullText: { document: "content", query: "nebula" } });
    const fresh = await next(current);
    const expected = await oracle(owner, namespace, "nebula");
    assert.deepEqual(
      fresh.pages.flat(),
      expected.map(({ label, labels }) => ({ label, labels })),
    );
    assert.equal(fresh.count, String(expected.length));
    assert.deepEqual(fresh.pages.flat(), [{ label: "fresh", labels: [] }]);
    await owner.query(`UPDATE "${namespace}".documents SET title='nebula nebula' WHERE _id=$1`, [id(1)]);
    await poll();
    const replacement = await next(current);
    const changed = await oracle(owner, namespace, "nebula");
    assert.deepEqual(
      replacement.pages.flat(),
      changed.map(({ label, labels }) => ({ label, labels })),
    );
    assert.equal(replacement.count, "2");
    await bounded<unknown>(current.return?.() ?? Promise.resolve(), "reconnected stream close");
    await reconnected.close();
    await drain(owner, role);
  });
}, 90000);

test("U5 actual live FTS reevaluation reports its deadline and drains without releasing the blocking lock", async () => {
  await fixture(async ({ owner, namespace, role, connections, open, poll }) => {
    await owner.query(
      `INSERT INTO "${namespace}".documents (_id,tenant,label,title) VALUES ($1,'tenant-a','deadline','quasar')`,
      [id(1)],
    );
    const peer = open();
    const stream = await peer.start();
    assert.equal((await next(stream)).count, "1");
    await owner.query(`UPDATE "${namespace}".documents SET body='quasar' WHERE _id=$1`, [id(1)]);
    const locker = await owner.connect();
    await withRollback(locker, async () => {
      await locker.query("BEGIN");
      await locker.query(`LOCK TABLE "${namespace}".documents IN ACCESS EXCLUSIVE MODE`);
      const evaluationStarted = performance.now();
      const failure = assert.rejects(bounded(stream.next(), "live search deadline"), { code: "QUERY_BUDGET_EXCEEDED" });
      const evaluation = poll();
      void failure.catch(() => {});
      void evaluation.catch(() => {});
      await observe(
        async () => {
          const result = await owner.query<{ pid: number; query: string }>(
            "SELECT pid,query FROM pg_stat_activity WHERE usename=$1 AND state='active' AND wait_event_type='Lock' AND query LIKE $2",
            [role, `%${namespace}%documents%`],
          );
          if (result.rows.length !== 1) return false;
          const blocked = result.rows[0];
          assert(blocked);
          const deadline = blockedDeadline(connections, blocked.pid, blocked.query, evaluationStarted);
          assert(deadline.milliseconds > 0 && deadline.milliseconds <= 2000);
          // Deadline starts after invocation authorization and before its native
          // settings read. These observations bracket elapsed evaluation time;
          // allow scheduling/rounding slack rather than exact milliseconds.
          const elapsed = deadline.at - evaluationStarted;
          const deadlineElapsed = deadline.at - deadline.settingsAt;
          assert(
            deadline.milliseconds >= 2000 - elapsed - 100,
            "Applied timeout must reflect measured remaining 2s evaluation budget",
          );
          assert(deadline.milliseconds <= 2000 - deadlineElapsed + 100);
          assert(
            deadline.milliseconds >= 1000,
            "Reach the blocked read with substantial budget; a tiny configured timeout cannot satisfy this case",
          );
          return true;
        },
        "deadline evaluation reached the native blocked SELECT",
        1500,
      );
      await failure;
      await evaluation;
      await drain(owner, role);
      const held = await locker.query<{ held: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND relation=$1::regclass AND mode='AccessExclusiveLock' AND granted) AS held",
        [`${namespace}.documents`],
      );
      assert.deepEqual(held.rows, [{ held: true }], "Deadline must drain while the blocking lock remains held");
    });
    await peer.close();
    // A failed epoch cannot poison the runtime's next owned snapshot.
    const recovered = open();
    const current = await recovered.start();
    const value = await next(current);
    assert.deepEqual(
      value.pages.flat(),
      (await oracle(owner, namespace)).map(({ label, labels }) => ({ label, labels })),
    );
    assert.equal(value.count, "1");
    await bounded<unknown>(current.return?.() ?? Promise.resolve(), "deadline recovery close");
    await recovered.close();
    await drain(owner, role);
  }, 2000);
}, 90000);
