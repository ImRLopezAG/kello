import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";
import { expect, test } from "bun:test";
import { call, ORPCError } from "@orpc/server";
import type { InferSchemaInput } from "@orpc/server";
import { Context } from "effect";
import { defineRelations, eq } from "drizzle-orm";
import { getTableConfig, pgSchema } from "drizzle-orm/pg-core";
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
import { cleanupScaleFixture, cleanupScaleTransaction } from "../fixtures/search-full-text-scale-cleanup";

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
type CapturedStatement = { text: string; values: unknown[] };
type PlanNode = {
  "Node Type": string;
  "Index Name"?: string;
  "Index Cond"?: string;
  "Recheck Cond"?: string;
  Filter?: string;
  "Sort Key"?: string[];
  "Relation Name"?: string;
  "Actual Loops"?: number;
  "Actual Rows"?: number;
  "Actual Total Time"?: number;
  "Shared Hit Blocks"?: number;
  "Shared Read Blocks"?: number;
  "Temp Read Blocks"?: number;
  "Temp Written Blocks"?: number;
  Plans?: PlanNode[];
};
type Explain = { Plan: PlanNode; "Planning Time"?: number; "Execution Time"?: number };
function nodes(plan: PlanNode): PlanNode[] {
  return [plan, ...(plan.Plans ?? []).flatMap(nodes)];
}
const projectedRows = v.array(v.strictObject({ _id: v.string(), label: v.string() }));

// Authored against accepted U4 e22b5623. No runtime fixes or uncommitted 003
// dependency metadata. The host owns execution and the acceptance receipt.
test("U5 PG18 scale: actual authorized handler SQL, unforced GIN, sequential oracle and bounded continuation", async () => {
  const connectionString = fullTextLocalTarget(process.env.LOOM_TEST_DATABASE_URL);
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const namespace = `fts_u5_scale_${suffix}`;
  const metadataNamespace = `loom_fts_u5_scale_${suffix}`;
  const role = `fts_u5_scale_reader_${suffix}`;
  const owner = new pg.Pool({ connectionString, max: 3 });
  const schema = defineSchema(
    (f) => {
      const document = () =>
        defineTable(
          { tenant: f.text().notNull(), label: f.text().notNull(), title: f.text(), body: f.text() },
          {
            fullText: {
              content: {
                config: "pg_catalog.english",
                version: "1",
                fields: [
                  { field: "title", weight: "A" },
                  { field: "body", weight: "D" },
                ],
              },
            },
          },
        );
      return { documents: document(), small: document() };
    },
    { namespace },
  );
  const relations = defineRelations(schema.tables);
  const connections: { close: () => Promise<void> }[] = [];
  let installed = false;
  let roleCreated = false;
  const tableSQL = (table: "documents" | "small") => `"${namespace}"."${table}"`;
  // Independent fixed semantics: never import the production vector/rank builder.
  const vector =
    "setweight(to_tsvector('pg_catalog.english',coalesce(title,'')),'A') || setweight(to_tsvector('pg_catalog.english',coalesce(body,'')),'D')";
  const rank = `ts_rank_cd(ARRAY[0.1,0.2,0.4,1.0]::real[],(${vector}),plainto_tsquery('pg_catalog.english',$1),32)::real`;
  async function sequentialOracle(table: "documents" | "small", query: string, tenant: string) {
    const client = await owner.connect();
    let transaction = false;
    let primary: { error: unknown } | undefined;
    try {
      await client.query("BEGIN READ ONLY");
      transaction = true;
      // Forcing is confined to the independent oracle. Acceptance EXPLAINs use
      // a different connection with ordinary planner settings throughout.
      await client.query("SET LOCAL enable_indexscan = off");
      await client.query("SET LOCAL enable_indexonlyscan = off");
      await client.query("SET LOCAL enable_bitmapscan = off");
      const text = `SELECT _id,label,${rank} AS rank FROM ${tableSQL(table)}
        WHERE tenant=$2 AND (${vector}) @@ plainto_tsquery('pg_catalog.english',$1)
        ORDER BY rank DESC,_id ASC`;
      const plan = await client.query<{ "QUERY PLAN": Explain[] }>(`EXPLAIN (FORMAT JSON) ${text}`, [query, tenant]);
      // Empty parser cases can be optimized to a Result node. Nonempty cases
      // must genuinely use the independently selected sequential access path.
      if (query && query !== "the and of")
        expect(nodes(plan.rows[0]!["QUERY PLAN"][0]!.Plan).some((node) => node["Node Type"] === "Seq Scan")).toBe(true);
      const result = await client.query<{ _id: string; label: string; rank: number }>(text, [query, tenant]);
      await client.query("COMMIT");
      transaction = false;
      return result.rows.map(({ _id, label }) => ({ _id, label }));
    } catch (cause) {
      primary = { error: cause };
      throw cause;
    } finally {
      await cleanupScaleTransaction(
        transaction
          ? async () => {
              await client.query("ROLLBACK");
            }
          : undefined,
        (destroy) => client.release(destroy),
        primary,
      );
    }
  }
  const identity = (tenant: string): ProcedureContext => {
    const invocation = {
      identity: { issuer: "https://scale.test", subject: "reader", tenantId: tenant },
      requestId: crypto.randomUUID(),
      signal: new AbortController().signal,
    };
    return { ...invocation, "effect/context": Context.make(Invocation, invocation) };
  };
  let primary: { error: unknown } | undefined;
  try {
    const target = await owner.query<{ version: number; database: string }>(
      "SELECT current_setting('server_version_num')::int AS version,current_database() AS database",
    );
    expect(target.rows).toEqual([{ version: 180006, database: "kello_test" }]);
    console.info("U5 scale fixture identities", JSON.stringify({ namespace, metadataNamespace, role }));
    const empty = await generateDrizzleJson({}, undefined, [namespace]);
    const snapshot = await generateDrizzleJson({ namespace: pgSchema(namespace), ...schema.tables }, empty.id, [
      namespace,
    ]);
    installed = true;
    for (const statement of await generateMigration(empty, snapshot)) await owner.query(statement);
    await owner.query(`CREATE SCHEMA "${metadataNamespace}"`);
    await owner.query(`CREATE ROLE "${role}" LOGIN PASSWORD 'fts-scale-test-only'`);
    roleCreated = true;
    await owner.query(`GRANT USAGE ON SCHEMA "${namespace}" TO "${role}"`);
    await owner.query(`GRANT SELECT ON ALL TABLES IN SCHEMA "${namespace}" TO "${role}"`);

    // 100,000 deterministic roots: 50k/20k in tenants 0/1, remaining 30k
    // distributed among 98 tenants. Exactly 100 global quasar hits (0.1%),
    // with high-rank unauthorized hits and both title/body weighted matches.
    await owner.query(`INSERT INTO ${tableSQL("documents")} (_id,tenant,label,title,body)
      SELECT ('00000000-0000-4000-8000-' || lpad(to_hex(n),12,'0'))::uuid,
        'tenant-' || CASE WHEN n<=50000 THEN 0 WHEN n<=70000 THEN 1 ELSE 2+(n-70001)%98 END,
        n::text,
        repeat('common ordinary ',1+n%4) || CASE WHEN n%1000=0 AND n%3000<>0 THEN repeat('quasar ',1+n%7) ELSE '' END,
        'common ordinary body ' || CASE WHEN n%3000=0 THEN 'quasar' ELSE '' END
      FROM generate_series(1,100000) n`);
    await owner.query(`INSERT INTO ${tableSQL("small")} (_id,tenant,label,title,body)
      SELECT ('00000000-0000-4000-8001-' || lpad(to_hex(n),12,'0'))::uuid,
        'tenant-' || n%2,n::text,'common ordinary ' || CASE WHEN n%8=0 THEN 'quasar' ELSE '' END,NULL
      FROM generate_series(1,32) n`);
    await owner.query(`ANALYZE ${tableSQL("documents")}`);
    await owner.query(`ANALYZE ${tableSQL("small")}`);
    const distribution = await owner.query<{ tenant: string; count: string }>(
      `SELECT tenant,count(*)::text AS count FROM ${tableSQL("documents")} GROUP BY tenant ORDER BY tenant`,
    );
    expect(distribution.rows).toHaveLength(100);
    expect(distribution.rows.reduce((sum, row) => sum + Number(row.count), 0)).toBe(100000);
    expect(distribution.rows.find((row) => row.tenant === "tenant-0")?.count).toBe("50000");
    expect(distribution.rows.find((row) => row.tenant === "tenant-1")?.count).toBe("20000");
    const cardinality = await owner.query<{ rare: string; common: string }>(
      `SELECT count(*) FILTER (WHERE (${vector}) @@ plainto_tsquery('pg_catalog.english','quasar'))::text AS rare,
       count(*) FILTER (WHERE (${vector}) @@ plainto_tsquery('pg_catalog.english','common'))::text AS common
       FROM ${tableSQL("documents")}`,
    );
    expect(cardinality.rows).toEqual([{ rare: "100", common: "100000" }]);

    const expectedIndex = getTableConfig(schema.tables.documents).indexes.find(
      (index) => index.config.method === "gin",
    );
    assert(expectedIndex, "Schema declaration must own the GIN name");
    const ginName = expectedIndex.config.name;
    assert(ginName);
    const catalog = await owner.query<{
      name: string;
      valid: boolean;
      ready: boolean;
      method: string;
      bytes: string;
      definition: string;
    }>(
      `SELECT c.relname AS name,i.indisvalid AS valid,i.indisready AS ready,am.amname AS method,
       pg_relation_size(c.oid)::text AS bytes,pg_get_indexdef(c.oid) AS definition
       FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace
       JOIN pg_am am ON am.oid=c.relam WHERE n.nspname=$1 AND c.relname=$2`,
      [namespace, ginName],
    );
    expect(catalog.rows).toHaveLength(1);
    expect(catalog.rows[0]).toMatchObject({ name: ginName, valid: true, ready: true, method: "gin" });
    expect(Number(catalog.rows[0]!.bytes)).toBeGreaterThan(0);
    expect(catalog.rows[0]!.definition).toContain("to_tsvector");

    const readerURL = new URL(connectionString);
    readerURL.username = role;
    readerURL.password = "fts-scale-test-only";
    const { validators } = createProjectContext(schema, relations);
    const { procedure } = createProjectProcedures(schema, relations);
    const read = createDatabaseMiddleware(relations, "read", schema);
    const makeHandler = async (fullTextTimeoutMs: number) => {
      const connection = await connectDatabase({
        schema,
        relations,
        connectionString: readerURL.href,
        maxConnections: 1,
      });
      connections.push(connection);
      // Rows/count remain separate from the ordered native command observation.
      const captured: CapturedStatement[] = [];
      const observedCommands: CapturedStatement[] = [];
      const observed = new WeakSet<pg.PoolClient>();
      connection.pool.on("acquire", (client) => {
        if (observed.has(client)) return;
        observed.add(client);
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
              const parameters = v.safeParse(v.array(v.unknown()), args[1]);
              const command = {
                text: parsed.output.text,
                values: [...(parameters.success ? parameters.output : parsed.output.values)],
              };
              observedCommands.push(command);
              if (/^\s*select\b/i.test(command.text) && command.text.includes(`"${namespace}".`))
                captured.push(command);
            }
            // Observation only: no delay, rewritten arguments or fabricated result.
            return dispatch.apply(receiver, args);
          },
        });
      });
      const policy = {
        columns: ["_id", "label"],
        filter: ["title", "body"],
        text: ["title", "body"],
        fullText: ["content"],
        budgets: { fullTextTimeoutMs },
        scope: {
          name: "tenant",
          version: "1",
          where: ({
            table,
            identity,
          }: {
            table: typeof schema.tables.documents;
            identity: ProcedureContext["identity"];
          }) => eq(table.tenant, identity?.tenantId ?? "anonymous"),
        },
      } as const;
      const large = validators.tables.documents.search(policy);
      const small = validators.tables.small.search({
        ...policy,
        scope: { ...policy.scope, where: ({ table, identity }) => eq(table.tenant, identity?.tenantId ?? "anonymous") },
      });
      const options = {
        connection,
        replay: { metadataNamespace, deployment: "fts-scale" },
        search: { branchId: "fts-scale-local", key: "05".repeat(32), contract: "fts-scale/search" },
        authorize: async ({ identity }: ProcedureContext) => {
          if (!identity) throw new ORPCError("UNAUTHORIZED");
        },
      };
      const list = bindRpcDatabaseProcedure(
        procedure
          .errors(searchErrors)
          .use(read)
          .input(large.input)
          .output(large.output)
          .handler(({ context, input }) => context.search.documents.paginate(input)),
        options,
      );
      const smallList = bindRpcDatabaseProcedure(
        procedure
          .errors(searchErrors)
          .use(read)
          .input(small.input)
          .output(small.output)
          .handler(({ context, input }) => context.search.small.paginate(input)),
        options,
      );
      return {
        connection,
        captured,
        observedCommands,
        request: (input: InferSchemaInput<typeof large.input>, tenant: string) =>
          call(list, input, { context: identity(tenant) }),
        small: (input: InferSchemaInput<typeof small.input>, tenant: string) =>
          call(smallList, input, { context: identity(tenant) }),
      };
    };
    const handler = await makeHandler(60000);
    const input = (query: string) =>
      ({
        columns: { _id: true, label: true },
        fullText: { document: "content", query },
        limit: 17,
        count: true,
      }) as const;
    const explainClient = await handler.connection.pool.connect();
    try {
      const planner = await explainClient.query<{ name: string; setting: string }>(
        "SELECT name,setting FROM pg_settings WHERE name IN ('enable_seqscan','enable_indexscan','enable_bitmapscan','plan_cache_mode') ORDER BY name",
      );
      expect(planner.rows).toEqual([
        { name: "enable_bitmapscan", setting: "on" },
        { name: "enable_indexscan", setting: "on" },
        { name: "enable_seqscan", setting: "on" },
        { name: "plan_cache_mode", setting: "auto" },
      ]);
    } finally {
      explainClient.release();
    }

    for (const scenario of [
      { table: "documents", query: "quasar", tenant: "tenant-0", selective: true },
      { table: "documents", query: "quasar", tenant: "tenant-1", selective: true },
      { table: "documents", query: "common", tenant: "tenant-99", selective: false },
      { table: "documents", query: "common ordinary", tenant: "tenant-99", selective: false },
      { table: "documents", query: "", tenant: "tenant-0", selective: false },
      { table: "documents", query: "the and of", tenant: "tenant-0", selective: false },
      { table: "small", query: "quasar", tenant: "tenant-0", selective: false },
      { table: "small", query: "common", tenant: "tenant-0", selective: false },
      { table: "small", query: "", tenant: "tenant-0", selective: false },
      { table: "small", query: "the and of", tenant: "tenant-0", selective: false },
    ] as const) {
      const expected = await sequentialOracle(scenario.table, scenario.query, scenario.tenant);
      // First and repeated handler runs include actual parser preflight, native
      // aliases/config, exact-bit rank transport and same-snapshot count.
      handler.captured.length = 0;
      const started = performance.now();
      const first = await (scenario.table === "documents" ? handler.request : handler.small)(
        input(scenario.query),
        scenario.tenant,
      );
      const firstRunMs = performance.now() - started;
      const reads = handler.captured.slice();
      expect(reads).toHaveLength(2);
      expect(v.parse(projectedRows, first.rows)).toEqual(expected.slice(0, 17));
      expect(first.count).toBe(String(expected.length));
      const repeatedStart = performance.now();
      const repeated = await (scenario.table === "documents" ? handler.request : handler.small)(
        input(scenario.query),
        scenario.tenant,
      );
      const repeatedMs = performance.now() - repeatedStart;
      expect(repeated.rows).toEqual(first.rows);
      expect(repeated.count).toBe(first.count);
      expect(repeated.nextCursor === null).toBe(first.nextCursor === null);
      expect(repeated.previousCursor).toBeNull();
      expect(handler.captured.slice(reads.length)).toEqual(reads);
      const seen = v.parse(projectedRows, first.rows);
      let cursor = first.nextCursor;
      while (cursor) {
        assert(seen.length <= expected.length, "Continuation must make progress");
        const page = await (scenario.table === "documents" ? handler.request : handler.small)(
          { ...input(scenario.query), cursor },
          scenario.tenant,
        );
        expect(page.count).toBe(String(expected.length));
        expect(page.rows.length).toBeGreaterThan(0);
        seen.push(...v.parse(projectedRows, page.rows));
        cursor = page.nextCursor;
      }
      expect(seen).toEqual(expected);

      const replay = await handler.connection.pool.connect();
      try {
        for (const [readIndex, captured] of reads.entries()) {
          expect(captured.text).toContain('"tenant"');
          expect(captured.values).toContain(scenario.tenant);
          expect(captured.text).toContain("$1");
          if (scenario.query && scenario.query !== "the and of")
            expect(captured.text).toContain("'pg_catalog.english'::regconfig");
          else {
            // Check the captured framework membership, not a hand-written SQL
            // surrogate or merely an empty result. Rank projection is separate.
            const where = captured.text.search(/\bwhere\b/i);
            expect(where).toBeGreaterThanOrEqual(0);
            const membership = captured.text.slice(where);
            expect(membership).toMatch(/\bfalse\b/i);
            expect(membership).not.toContain("@@");
          }
          const plain = await replay.query<{ "QUERY PLAN": Explain[] }>(
            `EXPLAIN (FORMAT JSON) ${captured.text}`,
            captured.values,
          );
          const measured = await replay.query<{ "QUERY PLAN": Explain[] }>(
            `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${captured.text}`,
            captured.values,
          );
          // Named native pg preparation of the *captured framework SELECT*,
          // repeated enough to exercise PostgreSQL's normal custom/generic choice.
          const preparedName = `scale_${scenario.table}_${scenario.tenant}_${scenario.query.replaceAll(" ", "_") || "empty"}_${readIndex}`;
          const prepared = await replay.query({
            name: preparedName,
            text: captured.text,
            values: captured.values,
            rowMode: "array",
          });
          const preparedRows = v.parse(v.array(v.array(v.unknown())), prepared.rows);
          if (captured.text.includes("count(*)")) {
            expect(preparedRows).toEqual([[String(expected.length)]]);
          } else {
            // Native page assembly asks for one lookahead row. Inspect IDs in
            // the real array result without assuming private extra positions.
            const ids = preparedRows.map((row) => {
              const matches = row.filter((value) =>
                v.is(
                  v.pipe(v.string(), v.regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)),
                  value,
                ),
              );
              expect(matches).toHaveLength(1);
              return v.parse(v.string(), matches[0]);
            });
            expect(ids).toEqual(expected.slice(0, 18).map((row) => row._id));
          }
          for (let repeat = 0; repeat < 6; repeat++)
            expect(
              (
                await replay.query({
                  name: preparedName,
                  text: captured.text,
                  values: captured.values,
                  rowMode: "array",
                })
              ).rows,
            ).toEqual(prepared.rows);
          const literal = v.union([
            v.pipe(
              v.string(),
              v.transform((value) => `'${value.replaceAll("'", "''")}'`),
            ),
            v.pipe(v.union([v.number(), v.boolean()]), v.transform(String)),
            v.pipe(
              v.null(),
              v.transform(() => "NULL"),
            ),
          ]);
          const literals = captured.values.map((value) => v.parse(literal, value));
          const preparedPlan = await replay.query<{ "QUERY PLAN": Explain[] }>(
            `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) EXECUTE "${preparedName}"(${literals.join(",")})`,
          );
          if (!scenario.query || scenario.query === "the and of") {
            // Plain plans may prune the relation altogether. Measured ordinary
            // and prepared plans must never execute a root scan, even if a
            // scan survives underneath a false one-time filter.
            for (const evidence of [measured, preparedPlan]) {
              for (const node of nodes(evidence.rows[0]!["QUERY PLAN"][0]!.Plan)) {
                if (node["Relation Name"] === scenario.table) expect(node["Actual Loops"]).toBe(0);
              }
            }
          }
          for (const evidence of [plain, measured, preparedPlan]) {
            const all = nodes(evidence.rows[0]!["QUERY PLAN"][0]!.Plan);
            if (scenario.selective) {
              const gin = all.find((node) => node["Index Name"] === ginName);
              assert(gin, "Selective unforced framework plan must use schema-owned GIN");
              expect(gin["Node Type"]).toBe("Bitmap Index Scan");
              expect(gin["Index Cond"]).toContain("@@");
              expect(gin["Index Cond"]).toContain("to_tsvector");
              const predicates = all
                .flatMap((node) => [node.Filter ?? "", node["Index Cond"] ?? "", node["Recheck Cond"] ?? ""])
                .join(" ");
              expect(predicates).toContain("tenant");
              // Generic prepared plans retain a placeholder; custom plans show
              // its tenant literal. Both must retain the authorization predicate.
              expect(predicates.includes(scenario.tenant) || /tenant.*\$\d/.test(predicates)).toBe(true);
            }
          }
          console.info(
            "U5 scale captured read",
            JSON.stringify({
              scenario,
              text: captured.text,
              parameters: captured.values,
              plain: plain.rows[0]!["QUERY PLAN"],
              measured: measured.rows[0]!["QUERY PLAN"],
              prepared: preparedPlan.rows[0]!["QUERY PLAN"],
            }),
          );
        }
      } finally {
        replay.release();
      }
      // First-run timing is measured after seeding/ANALYZE/oracle work. It is
      // explicitly NOT a guaranteed cold-cache run; no cache reset is performed.
      console.info(
        "U5 scale handler timings",
        JSON.stringify({ scenario, count: expected.length, firstRunMs, repeatedMs, coldCacheGuaranteed: false }),
      );
    }

    // Deterministic budget failure on an actual continuation: a native table
    // lock holds the read past the deadline, rather than relying on CPU speed.
    // Live active-epoch cancellation/reconnect belong to the live proof worker.
    const bounded = await makeHandler(5000);
    const baselineClient = await bounded.connection.pool.connect();
    let inheritedStatementMs: number;
    let inheritedLockMs: number;
    try {
      const baseline = await baselineClient.query<{ statement_ms: number; lock_ms: number }>(
        "SELECT (SELECT setting::int FROM pg_catalog.pg_settings WHERE name='statement_timeout') AS statement_ms, (SELECT setting::int FROM pg_catalog.pg_settings WHERE name='lock_timeout') AS lock_ms",
      );
      expect(baseline.rows).toHaveLength(1);
      const settings = v.parse(
        v.strictObject({
          statement_ms: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
          lock_ms: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
        }),
        baseline.rows[0],
      );
      inheritedStatementMs = settings.statement_ms;
      inheritedLockMs = settings.lock_ms;
      // Both inherited limits are disabled or beyond the entire 10s outcome
      // window, so neither can explain enforcement of the 5s search policy.
      expect(inheritedStatementMs === 0 || inheritedStatementMs > 10000).toBe(true);
      expect(inheritedLockMs === 0 || inheritedLockMs > 10000).toBe(true);
    } finally {
      baselineClient.release();
    }
    const first = await bounded.request(input("common"), "tenant-99");
    assert(first.nextCursor);
    const continuation = { ...input("common"), cursor: first.nextCursor };
    const expected = await sequentialOracle("documents", "common", "tenant-99");
    expect(v.parse(projectedRows, first.rows)).toEqual(expected.slice(0, 17));
    expect(first.count).toBe(String(expected.length));
    const blocker = await owner.connect();
    let published = false;
    let blockerPrimary: { error: unknown } | undefined;
    let pendingSettlement: Promise<unknown> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query(`LOCK TABLE ${tableSQL("documents")} IN ACCESS EXCLUSIVE MODE`);
      bounded.captured.length = 0;
      bounded.observedCommands.length = 0;
      const pending = bounded.request(continuation, "tenant-99").then((page) => {
        published = true;
        return page;
      });
      const outcome = pending.then(
        () => ({ code: "unexpected-success" }),
        (cause: unknown) => cause,
      );
      // This observer retains the expected budget rejection as outcome data;
      // cleanup awaits it even if an earlier assertion fails.
      pendingSettlement = outcome;
      const lockArrival = performance.now() + 3000;
      while (true) {
        const blocked = await owner.query(
          "SELECT 1 FROM pg_stat_activity WHERE usename=$1 AND state='active' AND wait_event_type='Lock' AND query LIKE $2",
          [role, `%${namespace}%`],
        );
        if (blocked.rowCount === 1) break;
        assert(performance.now() < lockArrival, "Continuation must reach the actual locked framework read");
        await setTimeout(10);
      }
      expect(bounded.captured).toHaveLength(1);
      const lockedRead = bounded.captured[0];
      assert(lockedRead, "Capture the actual blocked rows read");
      const readPosition = bounded.observedCommands.indexOf(lockedRead);
      expect(readPosition).toBeGreaterThan(0);
      const deadlineCommand = bounded.observedCommands[readPosition - 1];
      assert(deadlineCommand, "The blocked read must follow its actual deadline command");
      expect(deadlineCommand.text).toMatch(/select\s+set_config\('statement_timeout',\s*\$1,\s*true\)/i);
      expect(deadlineCommand.values).toHaveLength(1);
      const applied = v.parse(v.pipe(v.string(), v.regex(/^[1-9]\d*ms$/)), deadlineCommand.values[0]);
      const appliedMs = Number(applied.slice(0, -2));
      expect(Number.isSafeInteger(appliedMs)).toBe(true);
      expect(appliedMs).toBeGreaterThan(0);
      expect(appliedMs).toBeLessThanOrEqual(5000);
      expect(inheritedStatementMs === 0 || inheritedStatementMs > appliedMs).toBe(true);
      expect(inheritedLockMs === 0 || inheritedLockMs > appliedMs).toBe(true);
      const timer = new AbortController();
      try {
        expect(
          await Promise.race([outcome, setTimeout(10000, { code: "did-not-drain" }, { signal: timer.signal })]),
        ).toMatchObject({ code: "QUERY_BUDGET_EXCEEDED" });
      } finally {
        timer.abort();
      }
      expect(published).toBe(false);
      const end = performance.now() + 5000;
      while (true) {
        const active = await owner.query(
          "SELECT 1 FROM pg_stat_activity WHERE usename=$1 AND (state='active' OR state LIKE 'idle in transaction%')",
          [role],
        );
        if (active.rowCount === 0 && bounded.connection.pool.idleCount === bounded.connection.pool.totalCount) break;
        assert(performance.now() < end, "Timed-out scale read must drain while blocker remains held");
        await setTimeout(10);
      }
      expect(bounded.connection.pool.waitingCount).toBe(0);
      console.info(
        "U5 scale deadline",
        JSON.stringify({
          policyMs: 5000,
          inheritedStatementMs,
          inheritedLockMs,
          appliedMs,
          deadlineCommand,
          lockedRead,
        }),
      );
    } catch (cause) {
      blockerPrimary = { error: cause };
      throw cause;
    } finally {
      await cleanupScaleTransaction(
        async () => {
          await blocker.query("ROLLBACK");
        },
        (destroy) => blocker.release(destroy),
        blockerPrimary,
        pendingSettlement,
      );
    }
    const resumed = await bounded.request(continuation, "tenant-99");
    expect(v.parse(projectedRows, resumed.rows)).toEqual(expected.slice(17, 34));
    expect(resumed.count).toBe(String(expected.length));
    assert(resumed.nextCursor);
    const afterResume = await bounded.request({ ...continuation, cursor: resumed.nextCursor }, "tenant-99");
    expect(v.parse(projectedRows, afterResume.rows)).toEqual(expected.slice(34, 51));
    expect(afterResume.count).toBe(String(expected.length));
    expect(
      (
        await owner.query(
          "SELECT 1 FROM pg_stat_activity WHERE usename=$1 AND (state='active' OR state LIKE 'idle in transaction%')",
          [role],
        )
      ).rows,
    ).toEqual([]);
    for (const connection of [handler.connection, bounded.connection]) {
      expect(connection.pool.waitingCount).toBe(0);
      expect(connection.pool.idleCount).toBe(connection.pool.totalCount);
    }
    console.info(
      "U5 scale catalog/distribution",
      JSON.stringify({
        target: target.rows,
        catalog: catalog.rows,
        distribution: distribution.rows,
        cardinality: cardinality.rows,
      }),
    );
  } catch (cause) {
    primary = { error: cause };
    throw cause;
  } finally {
    await cleanupScaleFixture(
      connections,
      [
        async () => {
          if (installed) await owner.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
        },
        async () => {
          if (installed) await owner.query(`DROP SCHEMA IF EXISTS "${metadataNamespace}" CASCADE`);
        },
        async () => {
          if (roleCreated) await owner.query(`DROP ROLE "${role}"`);
        },
        () => owner.end(),
      ],
      primary,
    );
  }
}, 300_000);
