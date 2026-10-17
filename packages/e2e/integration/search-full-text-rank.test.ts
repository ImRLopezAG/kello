import { expect, test } from "bun:test";
import pg from "pg";
import { and, asc, desc, defineRelations, eq, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { createFullTextFixture, fullTextRank, fullTextVector } from "../fixtures/search-full-text";
import { exactRankFloat4 } from "../../../apps/kello/src/core/search/rank";
import * as v from "valibot";
import assert from "node:assert/strict";
import { EncryptJWT, jwtDecrypt } from "jose";
import { pgSchema } from "drizzle-orm/pg-core";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api-postgres";
import { fullTextLocalTarget } from "./full-text-local-target";
import { rankHandler, rankHandlerIdentity, rankHandlerSchema } from "../fixtures/search-full-text-handler";
import { createHash } from "node:crypto";

const connectionString = fullTextLocalTarget(process.env.LOOM_TEST_DATABASE_URL);

async function guardTarget(pool: pg.Pool) {
  const target = await pool.query<{ version: number; database: string }>(
    "SELECT current_setting('server_version_num')::int AS version, current_database() AS database",
  );
  expect(target.rows).toEqual([{ version: 180006, database: "kello_test" }]);
  return target.rows[0]!.version;
}

const id = (value: number) => `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
type Boundary = { _id: string; rankBits: string };
type PlanNode = {
  "Node Type": string;
  Alias?: string;
  "Index Name"?: string;
  "Actual Rows"?: number;
  Filter?: string;
  Plans?: PlanNode[];
};
function planNodes(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(planNodes)];
}

test("PG18 native RQB weighted rank aliases, selective GIN and exact bidirectional boundaries", async () => {
  const namespace = `rankproof_${crypto.randomUUID().replaceAll("-", "")}`;
  const pool = new pg.Pool({ connectionString, max: 1 });
  const { documents, relations } = createFullTextFixture(namespace);
  const db = drizzle({ client: pool, relations });
  const query = "quasar";
  const table = sql`${documents}`;
  // Independent oracle deliberately spells out the fixed semantics, without the builder.
  const vector =
    "setweight(to_tsvector('simple'::regconfig, coalesce(title, '')), 'A') || setweight(to_tsvector('simple'::regconfig, coalesce(body, '')), 'D')";
  const rank = `ts_rank_cd(ARRAY[0.1,0.2,0.4,1.0]::real[], (${vector}), plainto_tsquery('simple'::regconfig, $1), 32)::real`;
  const physical = `"${namespace}"."documents"`;
  let schemaOwned = false;
  try {
    const version = await guardTarget(pool);
    schemaOwned = true;
    await db.execute(sql`CREATE SCHEMA ${sql.identifier(namespace)}`);
    await db.execute(
      sql`CREATE TABLE ${table} (_id uuid PRIMARY KEY, owner text NOT NULL, title text, body text, parent_id uuid)`,
    );
    await db.execute(
      sql`CREATE INDEX documents_fts_gin ON ${table} USING gin ((${fullTextVector({ title: sql.identifier("title"), body: sql.identifier("body") })}))`,
    );
    const catalog = (
      await pool.query(
        "SELECT pg_get_indexdef(i.indexrelid) AS definition, i.indisvalid, i.indisready, am.amname FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_am am ON am.oid=c.relam WHERE n.nspname=$1 AND c.relname='documents_fts_gin'",
        [namespace],
      )
    ).rows[0];
    expect(catalog).toMatchObject({ indisvalid: true, indisready: true, amname: "gin" });
    expect(catalog.definition).toContain("'simple'::regconfig");
    expect(catalog.definition).toContain("'A'::\"char\"");
    expect(catalog.definition).toContain("'D'::\"char\"");
    await pool.query(
      `INSERT INTO ${physical} SELECT ('00000000-0000-4000-8000-' || lpad(to_hex(i),12,'0'))::uuid, 'alice', 'ordinary filler', NULL, NULL FROM generate_series(10000,18000) i`,
    );
    const roots = Array.from({ length: 240 }, (_, i) => ({
      _id: id(i + 1),
      owner: "alice",
      title: "quasar",
      body: null,
    }));
    await db.insert(documents).values([
      ...roots,
      { _id: id(241), owner: "alice", title: null, body: "quasar" },
      { _id: id(242), owner: "alice", title: "quasar quasar", body: "quasar" },
      { _id: id(243), owner: "alice", title: "quasar quasar quasar", body: "quasar quasar" },
      { _id: id(244), owner: "alice", title: null, body: null },
      ...Array.from({ length: 100 }, (_, i) => ({
        _id: id(1000 + i),
        owner: "bob",
        title: "quasar ".repeat(20),
        body: null,
      })),
      { _id: id(3000), owner: "alice", title: null, body: "quasar", parentId: id(243) },
      { _id: id(3001), owner: "alice", title: "quasar quasar", body: null, parentId: id(243) },
      { _id: id(3002), owner: "bob", title: "quasar ".repeat(20), body: null, parentId: id(243) },
      { _id: id(3003), owner: "alice", title: "unmatched", body: null, parentId: id(243) },
    ]);
    await pool.query(`ANALYZE ${physical}`);
    const oracle: Boundary[] = (
      await pool.query(
        `SELECT _id, encode(pg_catalog.float4send(${rank}), 'hex') AS "rankBits" FROM ${physical} WHERE owner = 'alice' AND parent_id IS NULL AND (${vector}) @@ plainto_tsquery('simple'::regconfig, $1) ORDER BY ${rank} DESC, _id ASC`,
        [query],
      )
    ).rows;
    expect(oracle).toHaveLength(243);
    expect(oracle.map((row) => row._id)).toEqual([id(243), id(242), ...roots.map((row) => row._id), id(241)]);
    expect(new Set(oracle.slice(2, 242).map((row) => row.rankBits)).size).toBe(1);

    function native(size: number, backward = false, boundary?: Boundary) {
      return db.query.documents.findMany({
        columns: { _id: true, title: true },
        extras: {
          rankBits: (source) =>
            sql<string>`encode(pg_catalog.float4send(${fullTextRank(source, query)}), 'hex')`.as("rankBits"),
        },
        where: {
          RAW: (source) => {
            const value = fullTextRank(source, query);
            const key = boundary ? sql`${v.parse(exactRankFloat4, boundary.rankBits).toString()}::real` : undefined;
            const comparison = boundary
              ? backward
                ? sql`(${value} > ${key} OR (${value} = ${key} AND ${source._id} < ${boundary._id}::uuid))`
                : sql`(${value} < ${key} OR (${value} = ${key} AND ${source._id} > ${boundary._id}::uuid))`
              : sql`true`;
            return and(
              eq(source.owner, "alice"),
              isNull(source.parentId),
              sql`(${fullTextVector(source)}) @@ plainto_tsquery('simple'::regconfig, ${query})`,
              comparison,
            )!;
          },
        },
        orderBy: (source) =>
          backward
            ? [asc(fullTextRank(source, query)), desc(source._id)]
            : [desc(fullTextRank(source, query)), asc(source._id)],
        limit: size + 1,
        with: {
          children: {
            columns: { _id: true },
            extras: {
              rankBits: (source) =>
                sql<string>`encode(pg_catalog.float4send(${fullTextRank(source, query)}), 'hex')`.as("rankBits"),
            },
            where: {
              RAW: (source) =>
                and(
                  eq(source.owner, "alice"),
                  sql`(${fullTextVector(source)}) @@ plainto_tsquery('simple'::regconfig, ${query})`,
                )!,
            },
            orderBy: (source) => [desc(fullTextRank(source, query)), asc(source._id)],
            limit: 2,
          },
        },
      });
    }
    const first = await native(1);
    expect(first.map((row) => row._id)).toEqual([id(243), id(242)]);
    const childOracle = (
      await pool.query(
        `SELECT _id, encode(pg_catalog.float4send(${rank}), 'hex') AS "rankBits" FROM ${physical} WHERE owner='alice' AND parent_id=$2::uuid AND (${vector}) @@ plainto_tsquery('simple'::regconfig,$1) ORDER BY ${rank} DESC,_id ASC LIMIT 2`,
        [query, id(243)],
      )
    ).rows;
    expect(first[0]!.children).toEqual(childOracle);
    const generated = native(1).toSQL();
    expect(generated.sql).toContain('"d0"."title"');
    expect(generated.sql).toContain('"d1"."title"');
    expect(generated.sql).not.toMatch(/\boffset\b/i);
    expect(generated.sql).toContain("'simple'::regconfig");
    expect(generated.sql).toContain("ARRAY[0.1,0.2,0.4,1.0]::real[]");

    for (const size of [1, 2, 25, 100]) {
      for (const backward of [false, true]) {
        const seen: Boundary[] = [];
        let boundary: Boundary | undefined;
        for (let calls = 0; calls <= oracle.length; calls++) {
          const fetched = await native(size, backward, boundary);
          const retained = fetched.slice(0, size);
          if (backward) retained.reverse();
          const keys = retained.map(({ _id, rankBits }) => ({ _id, rankBits }));
          if (backward) seen.unshift(...keys);
          else seen.push(...keys);
          boundary = backward ? keys[0] : keys.at(-1);
          if (fetched.length <= size) break;
          if (calls === oracle.length) throw new Error("Traversal failed to terminate");
        }
        expect(seen).toEqual(oracle);
      }
    }
    expect(await native(1, false, oracle.at(-1))).toEqual([]);
    expect(await native(1, true, oracle[0])).toEqual([]);

    // Use exactly the native parameterized SQL under ordinary prepared execution.
    expect((await pool.query("SHOW enable_seqscan")).rows[0].enable_seqscan).toBe("on");
    const plan = (
      await pool.query({
        name: `rank-plan-${namespace}`,
        text: `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${generated.sql}`,
        values: generated.params,
      })
    ).rows[0]["QUERY PLAN"];
    const nodes = planNodes(plan[0].Plan);
    for (const alias of ["d0", "d1"]) {
      const heap = nodes.find((node) => node.Alias === alias);
      expect(heap?.["Node Type"]).toBe("Bitmap Heap Scan");
      expect(heap?.Plans?.[0]).toMatchObject({ "Node Type": "Bitmap Index Scan", "Index Name": "documents_fts_gin" });
    }
    console.info(
      "U1 native EXPLAIN",
      JSON.stringify(
        nodes.map((node) => ({
          type: node["Node Type"],
          alias: node.Alias,
          index: node["Index Name"],
          rows: node["Actual Rows"],
          filter: node.Filter,
        })),
      ),
      "Execution Time",
      plan[0]["Execution Time"],
    );
    console.info("U1 index catalog", JSON.stringify(catalog));
    console.info("U1 native SQL", generated.sql, "params", JSON.stringify(generated.params));
    console.info("U1 version/rank cardinality", version, oracle.length, "tie", oracle[2]!.rankBits);

    const actual = (
      await pool.query(
        `SELECT encode(pg_catalog.float4send(${rank}), 'hex') AS bits FROM ${physical} WHERE _id = ANY($2::uuid[])`,
        [query, [id(241), id(242), id(243), id(244)]],
      )
    ).rows.map((row) => v.parse(v.string(), row.bits));
    const bits = [
      "00000000",
      "00000001",
      "00000002",
      "007fffff",
      "00800000",
      "3dcccccd",
      "3eaaaaab",
      "3f000000",
      "3f000001",
      "3f7ffffe",
      "3f7fffff",
      "3f800000",
      ...actual,
    ];
    let state = 0x600d006;
    for (let i = 0; i < 512; i++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      bits.push((state % 0x3f800001).toString(16).padStart(8, "0"));
    }
    for (const digits of [-15, 0, 1, 3]) {
      await pool.query("SELECT set_config('extra_float_digits', $1, false)", [digits.toString()]);
      const roundTrip = await pool.query(
        "SELECT encode(pg_catalog.float4send(value::real), 'hex') AS bits FROM unnest($1::text[]) WITH ORDINALITY AS input(value, n) ORDER BY n",
        [bits.map((hex) => v.parse(exactRankFloat4, hex).toString())],
      );
      expect(roundTrip.rows.map((row) => row.bits)).toEqual(bits);
    }
    console.info("U1 float4 characterization", bits.length, "values x 4 extra_float_digits settings");
  } finally {
    try {
      if (schemaOwned) await pool.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
    } finally {
      await pool.end();
    }
  }
}, 60_000);

// U4 characterization of the accepted implementation. UNEXECUTED by this
// source-only worker; the host owns canonical PG/typecheck acceptance.
const handlerPayload = v.strictObject({
  v: v.literal(2),
  binding: v.string(),
  direction: v.picklist(["forward", "backward"]),
  keys: v.strictTuple([
    v.strictObject({ kind: v.literal("rank-float4"), value: v.pipe(v.string(), v.regex(/^[0-9a-f]{8}$/)) }),
    v.strictObject({ kind: v.literal("uuid"), value: v.string() }),
  ]),
  iat: v.number(),
  exp: v.number(),
});
type HandlerOracle = { _id: string; label: string; rankBits: string; searchRank: string };
type FixtureBinding =
  | string
  | number
  | boolean
  | null
  | readonly FixtureBinding[]
  | { readonly [key: string]: FixtureBinding };
function canonicalRankFixture(value: FixtureBinding): string {
  if (Array.isArray(value)) return `[${value.map(canonicalRankFixture).join(",")}]`;
  if (value !== null && v.is(v.object({}), value))
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, entry]) => `${JSON.stringify(name)}:${canonicalRankFixture(entry)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
const hashRankFixture = (value: FixtureBinding) =>
  createHash("sha256").update(canonicalRankFixture(value)).digest("hex");

test("U4 actual ranked handler: exact encrypted boundaries, traversal, invalidation and current-state continuation", async () => {
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const namespace = `fts_u4_${suffix}`;
  const metadataNamespace = `loom_fts_u4_${suffix}`;
  const role = `fts_u4_reader_${suffix}`;
  const owner = new pg.Pool({ connectionString, max: 1 });
  const schema = rankHandlerSchema(namespace);
  const relations = defineRelations(schema.tables);
  const connections: Awaited<ReturnType<typeof rankHandler>>[] = [];
  let installed = false;
  let roleCreated = false;
  const key = Buffer.from("04".repeat(32), "hex");
  const physical = `"${namespace}".documents`;
  // Intentionally independent of the production vector/rank/keyset builders.
  const vector =
    "setweight(to_tsvector('pg_catalog.simple',coalesce(title,'')),'A') || setweight(to_tsvector('pg_catalog.simple',coalesce(body,'')),'D')";
  const rank = `ts_rank_cd(ARRAY[0.1,0.2,0.4,1.0]::real[],(${vector}),plainto_tsquery('pg_catalog.simple',$1),32)::real`;
  async function oracle(boundary?: HandlerOracle, backward = false) {
    // Conversion is independent of exactRankFloat4; PG float4send is the oracle.
    const parameters = boundary
      ? ["quasar", Buffer.from(boundary.rankBits, "hex").readFloatBE().toString(), boundary._id]
      : ["quasar"];
    const predicate = boundary
      ? `AND (rank ${backward ? ">" : "<"} $2::real OR (rank=$2::real AND _id ${backward ? "<" : ">"} $3::uuid))`
      : "";
    return (
      await owner.query<HandlerOracle>(
        `WITH authorized AS (SELECT _id,label,search_rank AS "searchRank",${rank} AS rank FROM ${physical}
       WHERE owner='alice' AND (${vector}) @@ plainto_tsquery('pg_catalog.simple',$1))
       SELECT _id,label,"searchRank",encode(pg_catalog.float4send(rank),'hex') AS "rankBits"
       FROM authorized WHERE true ${predicate} ORDER BY rank DESC,_id ASC`,
        parameters,
      )
    ).rows;
  }
  async function payload(token: string) {
    const decoded = await jwtDecrypt(token, key, {
      keyManagementAlgorithms: ["dir"],
      contentEncryptionAlgorithms: ["A256GCM"],
      typ: "kello.search.cursor.v2",
    });
    expect(decoded.protectedHeader).toMatchObject({ alg: "dir", enc: "A256GCM", typ: "kello.search.cursor.v2" });
    return v.parse(handlerPayload, decoded.payload);
  }
  async function boundaryProof(token: string, expected: HandlerOracle, direction: "forward" | "backward") {
    const decoded = await payload(token);
    expect(decoded.direction).toBe(direction);
    expect(decoded.keys).toEqual([
      { kind: "rank-float4", value: expected.rankBits },
      { kind: "uuid", value: expected._id },
    ]);
  }
  async function reencrypt(value: v.InferInput<typeof handlerPayload>) {
    return new EncryptJWT(value)
      .setProtectedHeader({ alg: "dir", enc: "A256GCM", typ: "kello.search.cursor.v2" })
      .encrypt(key);
  }
  try {
    await guardTarget(owner); // Actual identity/version BEFORE any writes.
    const empty = await generateDrizzleJson({}, undefined, [namespace]);
    const snapshot = await generateDrizzleJson({ namespace: pgSchema(namespace), ...schema.tables }, empty.id, [
      namespace,
    ]);
    installed = true;
    for (const statement of await generateMigration(empty, snapshot)) await owner.query(statement);
    await owner.query(`CREATE SCHEMA "${metadataNamespace}"`);
    await owner.query(`CREATE ROLE "${role}" LOGIN PASSWORD 'fts-u4-test-only'`);
    roleCreated = true;
    await owner.query(`GRANT USAGE ON SCHEMA "${namespace}" TO "${role}"`);
    await owner.query(`GRANT SELECT ON ALL TABLES IN SCHEMA "${namespace}" TO "${role}"`);
    const seed = drizzle({ client: owner, relations });
    const ties = Array.from({ length: 240 }, (_, index) => ({
      _id: v.parse(schema.id("documents"), id(index + 1)),
      label: `tie-${index}`,
      owner: "alice",
      title: "quasar",
      body: index % 2 ? "unrelated differently worded document" : null,
      published: index % 2 === 0,
      searchRank: `public-value-${index}`,
    }));
    await seed.insert(schema.tables.documents).values([
      ...ties,
      {
        _id: v.parse(schema.id("documents"), id(241)),
        label: "body",
        owner: "alice",
        title: null,
        body: "quasar",
        published: true,
        searchRank: "public-body",
      },
      {
        _id: v.parse(schema.id("documents"), id(242)),
        label: "middle",
        owner: "alice",
        title: "quasar quasar",
        body: null,
        published: true,
        searchRank: "public-middle",
      },
      {
        _id: v.parse(schema.id("documents"), id(243)),
        label: "top",
        owner: "alice",
        title: "quasar quasar quasar",
        body: "quasar",
        published: true,
        searchRank: "public-top",
      },
      {
        _id: v.parse(schema.id("documents"), id(244)),
        label: "empty",
        owner: "alice",
        title: null,
        body: null,
        published: true,
        searchRank: "public-empty",
      },
      {
        _id: v.parse(schema.id("documents"), id(1000)),
        label: "hidden",
        owner: "bob",
        title: "quasar ".repeat(20),
        body: null,
        published: true,
        searchRank: "public-hidden",
      },
    ]);
    const address = new URL(connectionString);
    address.username = role;
    address.password = "fts-u4-test-only";
    async function open(
      schemaVariant: Parameters<typeof rankHandlerSchema>[1] = {},
      runtimeVariant: Parameters<typeof rankHandler>[3] = {},
    ) {
      const fixture = await rankHandler(
        rankHandlerSchema(namespace, schemaVariant),
        address.href,
        metadataNamespace,
        runtimeVariant,
      );
      connections.push(fixture);
      return fixture;
    }
    const handler = await open();
    const input = {
      columns: { label: true },
      fullText: { document: "content", query: "quasar" },
      count: true,
      limit: 1,
    } as const;
    const expected = await oracle();
    expect(expected).toHaveLength(243);
    expect(expected.map(({ _id }) => _id)).toEqual([id(243), id(242), ...ties.map(({ _id }) => _id), id(241)]);
    expect(new Set(expected.slice(2, 242).map(({ rankBits }) => rankBits)).size).toBe(1);
    // Different source documents demonstrably produce the exact same float4.
    expect(ties[0]!.body).not.toEqual(ties[1]!.body);
    const projected = (rows: HandlerOracle[]) => rows.map(({ label }) => ({ label }));
    const labels = v.array(v.strictObject({ label: v.string() }));
    const mapLabels = (rows: Awaited<ReturnType<typeof handler.request>>["rows"]) =>
      v.parse(labels, rows).map(({ label }) => {
        const match = expected.find((row) => row.label === label);
        assert(match, `Unexpected public label ${label}`);
        return match;
      });
    for (const sizes of [[1], [2], [25], [100], [1, 100, 2, 25]]) {
      for (const direction of ["forward", "backward"] as const) {
        const seen: HandlerOracle[] = [];
        let cursor: string | null = null;
        for (let calls = 0; calls <= expected.length; calls++) {
          const page = await handler.request({ ...input, limit: sizes[calls % sizes.length]!, direction, cursor });
          expect(page.count).toBe("243");
          const actual = mapLabels(page.rows); // Strict label-only output excludes all private fields.
          expect(actual.length).toBeGreaterThan(0);
          if (page.nextCursor) await boundaryProof(page.nextCursor, actual.at(-1)!, "forward");
          if (page.previousCursor) await boundaryProof(page.previousCursor, actual[0]!, "backward");
          if (direction === "forward") seen.push(...actual);
          else seen.unshift(...actual);
          cursor = direction === "forward" ? page.nextCursor : page.previousCursor;
          if (!cursor) break;
          assert(calls < expected.length, "Actual handler traversal did not terminate");
        }
        expect(seen).toEqual(expected);
        expect(new Set(seen.map(({ _id }) => _id)).size).toBe(expected.length);
      }
    }
    // Collision with the transport's preferred alias must preserve legitimate data.
    const collision = await handler.request({ ...input, limit: 100, columns: { label: true, searchRank: true } });
    expect(collision.rows).toEqual(expected.slice(0, 100).map(({ label, searchRank }) => ({ label, searchRank })));
    assert(collision.nextCursor);
    await boundaryProof(collision.nextCursor, expected[99]!, "forward");
    const collisionNext = await handler.request({
      ...input,
      limit: 100,
      columns: { label: true, searchRank: true },
      cursor: collision.nextCursor,
    });
    expect(collisionNext.rows).toEqual(
      expected.slice(100, 200).map(({ label, searchRank }) => ({ label, searchRank })),
    );
    for (const direction of ["forward", "backward"] as const) {
      for (const query of ["", "!!!", "unmatchedword"]) {
        expect(await handler.request({ ...input, direction, fullText: { document: "content", query } })).toEqual({
          rows: [],
          count: "0",
          nextCursor: null,
          previousCursor: null,
        });
      }
    }
    const first = await handler.request(input);
    assert(first.nextCursor);
    expect(first.previousCursor).toBeNull();
    const second = await handler.request({ ...input, cursor: first.nextCursor });
    assert(second.previousCursor);
    const firstAgain = await handler.request({ ...input, direction: "backward", cursor: second.previousCursor });
    expect(firstAgain.rows).toEqual(first.rows);
    expect(firstAgain.previousCursor).toBeNull();
    const basePayload = await payload(first.nextCursor);
    // Fixed, independent semantics fixture: equality with the genuine current
    // token is required before obsolete-version envelope rejection can count.
    const existingBinding = hashRankFixture({
      branch: "fts-u4-local",
      namespace: "",
      contract: "fts-u4/search",
      policy: handler.descriptor.fingerprint,
      entity: "documents",
      mode: "finite",
      identity: { issuer: "https://rank.test", subject: "alice", tenantId: "tenant-a" },
      query: {
        columns: { label: true },
        orderBy: [
          { field: "_createdAt", direction: "asc", nulls: "last" },
          { field: "_id", direction: "asc", nulls: "last" },
        ],
      },
    });
    const semanticBinding = (parser = "plain-v1", codec = "float4-bits-v1", rankName = "ts_rank_cd") =>
      hashRankFixture({
        existing: existingBinding,
        schema: handler.descriptor.schemaFingerprint,
        raw: "quasar",
        canonical: "'quasar'",
        name: "content",
        document: {
          config: "pg_catalog.simple",
          fields: [
            { field: "title", weight: "A" },
            { field: "body", weight: "D" },
          ],
          version: "1",
          representation: "expression",
        },
        parser,
        rank: rankName,
        normalization: 32,
        weights: [0.1, 0.2, 0.4, 1],
        codec,
        order: "rank-desc-id-asc",
      });
    expect(basePayload.binding).toBe(semanticBinding());
    expect(
      (await handler.request({ ...input, cursor: await reencrypt({ ...basePayload, binding: semanticBinding() }) }))
        .rows,
    ).toEqual(second.rows);
    // Fixed decimal literals, not production codec output, independently prove
    // native PG adjacent float4 values. These are synthetic boundary anchors;
    // no claim that ts_rank_cd naturally generated adjacent ranks is made.
    const adjacent = [
      { decimal: "0.4999999701976776123046875", bits: "3effffff" },
      { decimal: "0.5", bits: "3f000000" },
      { decimal: "0.500000059604644775390625", bits: "3f000001" },
    ];
    const directCast = await owner.query<{ bits: string; below: boolean; equal: boolean; above: boolean }>(
      `SELECT encode(pg_catalog.float4send(value::real),'hex') AS bits,
       value::real < 0.5::real AS below, value::real = 0.5::real AS equal, value::real > 0.5::real AS above
       FROM unnest($1::text[]) WITH ORDINALITY AS input(value,n) ORDER BY n`,
      [adjacent.map(({ decimal }) => decimal)],
    );
    expect(directCast.rows).toEqual([
      { bits: "3effffff", below: true, equal: false, above: false },
      { bits: "3f000000", below: false, equal: true, above: false },
      { bits: "3f000001", below: false, equal: false, above: true },
    ]);
    expect(expected[2]!.rankBits).toBe("3f000000");
    for (const { bits } of adjacent) {
      const boundary = { ...expected[24]!, rankBits: bits };
      for (const direction of ["forward", "backward"] as const) {
        const cursor = await reencrypt({
          ...basePayload,
          direction,
          keys: [
            { kind: "rank-float4", value: bits },
            { kind: "uuid", value: boundary._id },
          ],
        });
        const current = await oracle(boundary, direction === "backward");
        const page = await handler.request({ ...input, limit: 100, cursor, direction });
        expect(page.rows).toEqual(projected(direction === "forward" ? current.slice(0, 100) : current.slice(-100)));
        const returned = mapLabels(page.rows);
        if (page.nextCursor) await boundaryProof(page.nextCursor, returned.at(-1)!, "forward");
        if (page.previousCursor) await boundaryProof(page.previousCursor, returned[0]!, "backward");
      }
    }
    // Authenticated fixture-owned envelope tests reach the actual handler at
    // exhausted boundaries; they do not claim these tokens were handler-issued.
    for (const direction of ["forward", "backward"] as const) {
      const edge = direction === "forward" ? expected.at(-1)! : expected[0]!;
      const cursor = await reencrypt({
        ...basePayload,
        direction,
        keys: [
          { kind: "rank-float4", value: edge.rankBits },
          { kind: "uuid", value: edge._id },
        ],
      });
      expect(await handler.request({ ...input, direction, cursor })).toEqual({
        rows: [],
        count: "243",
        nextCursor: null,
        previousCursor: null,
      });
    }
    const invalid = { code: "INVALID_CURSOR", data: { restart: true } };
    for (const binding of [
      semanticBinding("plain-v0"),
      semanticBinding("plain-v1", "float4-bits-v0"),
      semanticBinding("plain-v1", "float4-bits-v1", "ts_rank"),
    ]) {
      await assert.rejects(
        handler.request({ ...input, cursor: await reencrypt({ ...basePayload, binding }) }),
        invalid,
      );
    }
    await assert.rejects(handler.request({ ...input, cursor: first.nextCursor, direction: "backward" }), invalid);
    await assert.rejects(
      handler.request({ ...input, cursor: first.nextCursor, fullText: { document: "content", query: "QUASAR!!!" } }),
      invalid,
    );
    // Independent native SQL confirms the raw changed query is lexically equivalent.
    const canonical = await owner.query<{ same: boolean }>(
      "SELECT plainto_tsquery('pg_catalog.simple','quasar')=plainto_tsquery('pg_catalog.simple','QUASAR!!!') AS same",
    );
    expect(canonical.rows).toEqual([{ same: true }]);
    await assert.rejects(
      handler.request({ ...input, cursor: first.nextCursor, fullText: { document: "content", query: "other" } }),
      invalid,
    );
    await assert.rejects(
      handler.request({ ...input, cursor: first.nextCursor, columns: { label: true, title: true } }),
      invalid,
    );
    await assert.rejects(
      handler.request({ ...input, cursor: first.nextCursor, where: { published: { eq: true } } }),
      invalid,
    );
    await assert.rejects(handler.request({ ...input, cursor: first.nextCursor }, rankHandlerIdentity("bob")), invalid);
    await assert.rejects(
      handler.request({ ...input, cursor: first.nextCursor }, rankHandlerIdentity("alice", "tenant-b")),
      invalid,
    );
    // Flip authenticated ciphertext, avoiding unused base64 padding bits.
    const parts = first.nextCursor.split(".");
    assert(parts[3]);
    parts[3] = (parts[3][0] === "A" ? "B" : "A") + parts[3].slice(1);
    await assert.rejects(handler.request({ ...input, cursor: parts.join(".") }), invalid);
    const lifetime = basePayload.exp - basePayload.iat;
    const expiredAt = Math.floor(Date.now() / 1000) - lifetime - 60;
    const expired = await reencrypt({ ...basePayload, iat: expiredAt, exp: expiredAt + lifetime });
    await assert.rejects(handler.request({ ...input, cursor: expired }), invalid);
    for (const variant of [
      { schema: { config: "pg_catalog.english" }, runtime: {} },
      { schema: { weight: "B" }, runtime: {} },
      { schema: { documentVersion: "2" }, runtime: {} },
      { schema: { schemaChange: true }, runtime: {} },
      { schema: {}, runtime: { policyVersion: "2" } },
      { schema: {}, runtime: { key: "05".repeat(32) } },
      { schema: {}, runtime: { contract: "fts-u4/search-v2" } },
    ] satisfies {
      schema: NonNullable<Parameters<typeof rankHandlerSchema>[1]>;
      runtime: NonNullable<Parameters<typeof rankHandler>[3]>;
    }[]) {
      const changed = await open(variant.schema, variant.runtime);
      await assert.rejects(changed.request({ ...input, cursor: first.nextCursor }), invalid);
    }
    // No retained transaction/snapshot across calls: each continuation is
    // compared to the CURRENT independently authorized SQL keyset oracle.
    const anchorPage = await handler.request({ ...input, limit: 25 });
    assert(anchorPage.nextCursor);
    const anchor = expected[24]!;
    async function continueCurrent(expectedRows: HandlerOracle[]) {
      const continued: { label: string }[] = [];
      let cursor: string | null = anchorPage.nextCursor;
      const count = String((await oracle()).length);
      for (let calls = 0; cursor && calls <= 243; calls++) {
        const page = await handler.request({ ...input, limit: 100, cursor });
        continued.push(...v.parse(labels, page.rows));
        expect(page.count).toBe(count);
        cursor = page.nextCursor;
        assert(calls < 243, "Current-state continuation did not terminate");
      }
      expect(continued).toEqual(projected(expectedRows));
    }
    await seed.insert(schema.tables.documents).values([
      {
        _id: v.parse(schema.id("documents"), id(5000)),
        label: "insert-before",
        owner: "alice",
        title: "quasar ".repeat(10),
        body: null,
        published: true,
        searchRank: "insert-before",
      },
      {
        _id: v.parse(schema.id("documents"), id(5001)),
        label: "insert-after",
        owner: "alice",
        title: null,
        body: "quasar",
        published: true,
        searchRank: "insert-after",
      },
    ]);
    const insertedOracle = await oracle(anchor);
    expect(insertedOracle.some(({ label }) => label === "insert-before")).toBe(false);
    expect(insertedOracle.some(({ label }) => label === "insert-after")).toBe(true);
    await continueCurrent(insertedOracle);
    // Deleting the actual boundary does not require the row to still exist.
    await owner.query(`DELETE FROM ${physical} WHERE _id=ANY($1::uuid[])`, [[anchor._id, expected[25]!._id]]);
    const deletedOracle = await oracle(anchor);
    const afterDelete = await handler.request({ ...input, limit: 100, cursor: anchorPage.nextCursor });
    expect(afterDelete.rows).toEqual(projected(deletedOracle.slice(0, 100)));
    expect(afterDelete.count).toBe(String((await oracle()).length));
    await continueCurrent(deletedOracle);
    // A seen row moving behind the anchor may repeat; an unseen row moving
    // before it may be omitted. This is current-state keyset behavior.
    await owner.query(`UPDATE ${physical} SET title=NULL,body='quasar' WHERE label='top'`);
    await owner.query(`UPDATE ${physical} SET title=repeat('quasar ',10),body=NULL WHERE label=$1`, [
      expected[26]!.label,
    ]);
    const rerankedOracle = await oracle(anchor);
    expect(rerankedOracle.some(({ label }) => label === "top")).toBe(true);
    expect(rerankedOracle.some(({ label }) => label === expected[26]!.label)).toBe(false);
    await continueCurrent(rerankedOracle);
    const backwardCurrent = await oracle(anchor, true);
    // Authenticated opposite-direction boundary isolates current backward SQL
    // semantics; ordinary handler-issued backward navigation is proved above.
    const backwardAnchor = await reencrypt({ ...(await payload(anchorPage.nextCursor)), direction: "backward" });
    expect(
      (await handler.request({ ...input, limit: 100, direction: "backward", cursor: backwardAnchor })).rows,
    ).toEqual(projected(backwardCurrent.slice(-100)));
  } finally {
    try {
      await Promise.all(connections.map((fixture) => fixture.connection.close()));
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
  }
}, 60_000);

test("strict private float4 rank codec and zero/adjacent/subnormal SQL boundaries", async () => {
  for (const invalid of [
    undefined,
    null,
    0,
    {},
    "",
    "0000000",
    "000000000",
    "0000000g",
    "3F000000",
    " 00000000",
    "00000000\n",
    "7fc00000",
    "7f800000",
    "ff800000",
    "bf000000",
    "80000000",
    "80000001",
    "3f800001",
    "7f7fffff",
  ]) {
    expect(() => v.parse(exactRankFloat4, invalid)).toThrow();
  }
  expect(v.parse(exactRankFloat4, "00000000")).toBe(0);
  expect(Object.is(v.parse(exactRankFloat4, "00000000"), -0)).toBe(false);
  expect(v.parse(exactRankFloat4, "00000001")).toBe(2 ** -149);
  expect(v.parse(exactRankFloat4, "3f000001")).toBe(0.5 + 2 ** -24);
  expect(v.parse(exactRankFloat4, "3f7fffff")).toBe(1 - 2 ** -24);
  expect(v.parse(exactRankFloat4, "3f800000")).toBe(1);

  const pool = new pg.Pool({ connectionString, max: 1 });
  try {
    await guardTarget(pool);
    // PG VALUES-style CTE only: these artificial ranks never become a stored/public column.
    const groups = ["3f800000", "3f7fffff", "3f7ffffe", "3f000001", "3f000000", "00000002", "00000001", "00000000"];
    const expected = groups.flatMap((rankBits, group) =>
      Array.from({ length: 35 }, (_, i) => ({ _id: id(4000 + group * 35 + i), rankBits })),
    );
    const ids = expected.map((row) => row._id);
    const values = expected.map((row) => v.parse(exactRankFloat4, row.rankBits).toString());
    const cte =
      "WITH ranks AS (SELECT _id, value::real AS rank FROM unnest($1::uuid[], $2::text[]) AS input(_id, value))";
    const oracle = (
      await pool.query(
        `${cte} SELECT _id, encode(pg_catalog.float4send(rank), 'hex') AS "rankBits" FROM ranks ORDER BY rank DESC, _id ASC`,
        [ids, values],
      )
    ).rows;
    expect(oracle).toEqual(expected);
    for (const size of [1, 2, 25, 100]) {
      for (const backward of [false, true]) {
        const seen: Boundary[] = [];
        let boundary: Boundary | undefined;
        for (let calls = 0; calls <= expected.length; calls++) {
          const comparison = backward ? ">" : "<";
          const tie = backward ? "<" : ">";
          const predicate = boundary
            ? `WHERE (rank ${comparison} $3::real OR (rank = $3::real AND _id ${tie} $4::uuid))`
            : "";
          const parameters = boundary
            ? [ids, values, v.parse(exactRankFloat4, boundary.rankBits).toString(), boundary._id]
            : [ids, values];
          const fetched: Boundary[] = (
            await pool.query(
              `${cte} SELECT _id, encode(pg_catalog.float4send(rank), 'hex') AS "rankBits" FROM ranks ${predicate} ORDER BY rank ${backward ? "ASC" : "DESC"}, _id ${backward ? "DESC" : "ASC"} LIMIT ${size + 1}`,
              parameters,
            )
          ).rows;
          const retained = fetched.slice(0, size);
          if (backward) retained.reverse();
          if (backward) seen.unshift(...retained);
          else seen.push(...retained);
          boundary = backward ? retained[0] : retained.at(-1);
          if (fetched.length <= size) break;
          if (calls === expected.length) throw new Error("Synthetic traversal failed to terminate");
        }
        expect(seen).toEqual(expected);
      }
    }
  } finally {
    await pool.end();
  }
}, 60_000);
