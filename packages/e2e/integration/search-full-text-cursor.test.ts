import { createHash } from "node:crypto";
import { beforeAll, afterAll, describe, expect, test } from "bun:test";
import { call } from "@orpc/server";
import type { InferSchemaInput } from "@orpc/server";
import { Context } from "effect";
import { defineRelations, eq } from "drizzle-orm";
import { EncryptJWT, jwtDecrypt } from "jose";
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
import { fields } from "../../../apps/kello/src/core/schema/fields";
import { createSearchValidators } from "../../../apps/kello/src/core/search/contract";
import { searchErrors } from "../../../apps/kello/src/core/search/errors";
import { searchSchemaMetadata } from "../../../apps/kello/src/core/search/metadata";
import type { SearchRuntimeDescriptor } from "../../../apps/kello/src/core/search/metadata";
import { createSearchCursor } from "../../../apps/kello/src/core/search/cursor";
import { resolveFullText } from "../../../apps/kello/src/core/search/full-text";
import { fullTextLocalTarget } from "./full-text-local-target";
import { defaultSearchBudgets } from "../../../apps/kello/src/core/search/public";

// Authored source-only: execution requires the parent's local PG18 resource grant.
// No helper pagination oracle, replaced executor, or production test hook is used.
const namespace = `fts_cursor_${crypto.randomUUID().replaceAll("-", "")}`;
const secret = "06".repeat(32);
const identity = { issuer: "https://cursor.test", subject: "alice", tenantId: "tenant-one" };
const id = "00000000-0000-0000-0000-000000000001";
const requestInput = {
  columns: { title: true },
  fullText: { document: "content", query: " cats " },
  limit: 1,
} as const;

interface Variant {
  readonly config?: "pg_catalog.english" | "pg_catalog.simple";
  readonly weight?: "A" | "B";
  readonly documentVersion?: string;
  readonly policyVersion?: string;
  readonly extraSchemaField?: boolean;
  readonly branchId?: string;
  readonly component?: string;
  readonly key?: string;
  readonly contract?: string;
}

interface CursorFixtureExtraFields {
  added?: ReturnType<typeof fields.text>;
}

function declaration(variant: Variant = {}) {
  const additionalFields: CursorFixtureExtraFields = {};
  if (variant.extraSchemaField) additionalFields.added = fields.text();
  return defineSchema(
    () => ({
      articles: defineTable(
        {
          title: fields.text().notNull(),
          body: fields.text(),
          owner: fields.text().notNull(),
          ...additionalFields,
        },
        {
          fullText: {
            content: {
              config: variant.config ?? "pg_catalog.english",
              fields: [
                { field: "title", weight: variant.weight ?? "A" },
                { field: "body", weight: "D" },
              ],
              version: variant.documentVersion ?? "1",
            },
            alternate: {
              config: "pg_catalog.english",
              fields: [{ field: "title", weight: "A" }],
              version: "1",
            },
          },
        },
      ),
    }),
    { namespace },
  );
}

const schema = declaration();
const relations = defineRelations(schema.tables);
type Connection = Awaited<ReturnType<typeof connectDatabase<typeof relations>>>;
let owner: pg.Pool | undefined;
let connection: Connection | undefined;
let schemaCreated = false;

function contextFor(current: ProcedureContext["identity"] = identity): ProcedureContext {
  const invocation = { identity: current, requestId: crypto.randomUUID(), signal: new AbortController().signal };
  return { ...invocation, "effect/context": Context.make(Invocation, invocation) };
}

function endpoint(variant: Variant = {}) {
  if (!connection) throw new Error("Parent-owned cursor fixture has not been acquired");
  const currentSchema = declaration(variant);
  const graph = defineRelations(currentSchema.tables);
  const { validators } = createProjectContext(currentSchema, graph);
  const grants = {
    scope: {
      name: "owner",
      version: variant.policyVersion ?? "1",
      where: ({
        table,
        identity,
      }: {
        table: typeof currentSchema.tables.articles;
        identity: ProcedureContext["identity"];
      }) => eq(table.owner, identity?.subject ?? "anonymous"),
    },
    columns: ["title", "body"],
    filter: ["title", "body"],
    text: ["title", "body"],
    fullText: ["content", "alternate"],
  } as const;
  const finite = validators.tables.articles.search(grants);
  const { procedure } = createProjectProcedures(currentSchema, graph);
  const builder = procedure.errors(searchErrors).use(createDatabaseMiddleware(graph, "read", currentSchema));
  const options = {
    connection,
    scope: variant.component ?? "component-one",
    replay: { metadataNamespace: "loom_meta", deployment: "fts-cursor" },
    search: {
      branchId: variant.branchId ?? "br-one",
      key: variant.key ?? secret,
      contract: variant.contract ?? "articles.search",
    },
    authorize: async () => {},
  };
  const list = bindRpcDatabaseProcedure(
    builder
      .input(finite.input)
      .output(finite.output)
      .handler(({ context, input }) => context.search.articles.paginate(input)),
    options,
  );
  const descriptor = searchSchemaMetadata(finite.input)?.descriptor;
  if (!descriptor) throw new Error("Missing native cursor descriptor");
  return {
    descriptor,
    request: (
      input: InferSchemaInput<typeof finite.input> = requestInput,
      current: ProcedureContext["identity"] = identity,
    ) => call(list, input, { context: contextFor(current) }),
  };
}

const envelope = v.strictObject({
  v: v.literal(2),
  binding: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/)),
  direction: v.picklist(["forward", "backward"]),
  keys: v.strictTuple([
    v.strictObject({ kind: v.literal("rank-float4"), value: v.string() }),
    v.strictObject({ kind: v.literal("uuid"), value: v.pipe(v.string(), v.uuid()) }),
  ]),
  iat: v.pipe(v.number(), v.safeInteger()),
  exp: v.pipe(v.number(), v.safeInteger()),
});
type Envelope = v.InferOutput<typeof envelope>;
type TokenPayload = ConstructorParameters<typeof EncryptJWT>[0];
async function decrypt(token: string): Promise<Envelope> {
  const { payload, protectedHeader } = await jwtDecrypt(token, Buffer.from(secret, "hex"));
  expect(protectedHeader).toEqual({ alg: "dir", enc: "A256GCM", typ: "kello.search.cursor.v2" });
  return v.parse(envelope, payload);
}
function encrypt(payload: TokenPayload, typ = "kello.search.cursor.v2") {
  return new EncryptJWT(payload)
    .setProtectedHeader({ alg: "dir", enc: "A256GCM", typ })
    .encrypt(Buffer.from(secret, "hex"));
}
async function firstToken() {
  const page = await endpoint().request();
  expect(page.rows).toEqual([{ title: "cats" }]);
  if (!page.nextCursor) throw new Error("Missing actual handler continuation");
  return page.nextCursor;
}
const restart = { code: "INVALID_CURSOR", data: { restart: true } };

beforeAll(async () => {
  const value = fullTextLocalTarget(process.env.LOOM_TEST_DATABASE_URL);
  owner = new pg.Pool({ connectionString: value, max: 1 });
  const target = await owner.query<{ version: number; database: string }>(
    "SELECT current_setting('server_version_num')::int AS version, current_database() AS database",
  );
  expect(target.rows).toEqual([{ version: 180006, database: "kello_test" }]);
  await owner.query(`CREATE SCHEMA "${namespace}"`);
  schemaCreated = true;
  await owner.query(`CREATE TABLE "${namespace}".articles (
    _id uuid PRIMARY KEY, "_createdAt" bigint NOT NULL, title text NOT NULL, body text, owner text NOT NULL, added text)`);
  await owner.query(
    `INSERT INTO "${namespace}".articles (_id, "_createdAt", title, body, owner)
    VALUES ($1::uuid, 1, 'cats', NULL, 'alice'),
      ('00000000-0000-0000-0000-000000000002', 2, 'cats', NULL, 'alice'),
      ('00000000-0000-0000-0000-000000000003', 3, 'cats', NULL, 'alice')`,
    [id],
  );
  connection = await connectDatabase({ schema, relations, connectionString: value, maxConnections: 1 });
});

afterAll(async () => {
  await connection?.close();
  if (owner) {
    try {
      if (schemaCreated) await owner.query(`DROP SCHEMA "${namespace}" CASCADE`);
    } finally {
      await owner.end();
    }
  }
});

describe("actual ranked handler continuation binding", () => {
  const selections = [
    { name: "lexically equivalent raw query", change: { fullText: { document: "content", query: "cats" } } },
    { name: "canonical query", change: { fullText: { document: "content", query: "dogs" } } },
    { name: "document name", change: { fullText: { document: "alternate", query: " cats " } } },
    { name: "projection", change: { columns: { body: true } } },
    { name: "ordinary filter", change: { where: { title: { eq: "cats" } } } },
  ] as const;
  test.each([...selections])("rejects changed $name through the handler", async ({ change }) => {
    const token = await firstToken();
    await expect(endpoint().request({ ...requestInput, ...change, cursor: token })).rejects.toMatchObject(restart);
  });
  const variants: readonly (Variant & { readonly name: string })[] = [
    { name: "configuration", config: "pg_catalog.simple" },
    { name: "document weights", weight: "B" },
    { name: "document version", documentVersion: "2" },
    { name: "policy version", policyVersion: "2" },
    { name: "schema", extraSchemaField: true },
    { name: "branch", branchId: "br-two" },
    { name: "component namespace", component: "component-two" },
    { name: "contract", contract: "articles.other" },
    { name: "key rotation", key: "07".repeat(32) },
  ];
  test.each([...variants])("rejects changed $name through the handler", async (variant) => {
    await expect(endpoint(variant).request({ ...requestInput, cursor: await firstToken() })).rejects.toMatchObject(
      restart,
    );
  });
  test.each([
    { name: "issuer", current: { ...identity, issuer: "https://other.test" } },
    { name: "subject", current: { ...identity, subject: "bob" } },
    { name: "tenant", current: { ...identity, tenantId: "tenant-two" } },
    { name: "absent tenant", current: { issuer: identity.issuer, subject: identity.subject } },
    { name: "anonymous", current: null },
  ])("rejects changed identity $name", async ({ current }) => {
    await expect(endpoint().request({ ...requestInput, cursor: await firstToken() }, current)).rejects.toMatchObject(
      restart,
    );
  });
  test.each([1, 2, 25, 100])("permits page size %i within budget", async (limit) => {
    const page = await endpoint().request({ ...requestInput, limit, cursor: await firstToken() });
    expect(page.rows).toEqual(Array.from({ length: Math.min(limit, 2) }, () => ({ title: "cats" })));
  });
  test("rejects wrong direction and expiry through the handler", async () => {
    const token = await firstToken();
    await expect(endpoint().request({ ...requestInput, cursor: token, direction: "backward" })).rejects.toMatchObject(
      restart,
    );
    const payload = await decrypt(token);
    const now = Math.floor(Date.now() / 1000);
    const expired = await encrypt({ ...payload, iat: now - (payload.exp - payload.iat) - 1, exp: now - 1 });
    await expect(endpoint().request({ ...requestInput, cursor: expired })).rejects.toMatchObject(restart);
  });
  test("rejects tampering and malformed compact ciphertext", async () => {
    const token = await firstToken();
    const pieces = token.split(".");
    pieces[3] = `${pieces[3]?.startsWith("A") ? "B" : "A"}${pieces[3]?.slice(1)}`;
    for (const invalid of [pieces.join("."), token.slice(1), `${token}x`, "!", "a.b.c.d.e"])
      await expect(endpoint().request({ ...requestInput, cursor: invalid })).rejects.toMatchObject(restart);
  });
  test("rejects an empty ciphertext rather than restarting silently", async () => {
    await expect(endpoint().request({ ...requestInput, cursor: "" })).rejects.toMatchObject(restart);
  });
  test("characterizes the public cursor length limit before the codec boundary", async () => {
    await expect(endpoint().request({ ...requestInput, cursor: "a".repeat(4097) })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(endpoint().request({ columns: { title: true }, cursor: "a".repeat(4097) })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });
  test("rejects empty legacy tokens while preserving omitted and null first pages", async () => {
    const input = { columns: { title: true }, limit: 1 } as const;
    await expect(endpoint().request({ ...input, cursor: "" })).rejects.toMatchObject(restart);
    for (const fullText of [undefined, requestInput.fullText]) {
      const selection = fullText ? { ...input, fullText } : input;
      expect((await endpoint().request(selection)).rows).toEqual([{ title: "cats" }]);
      expect((await endpoint().request({ ...selection, cursor: null })).rows).toEqual([{ title: "cats" }]);
    }
  });
});

const exactValues = [
  { bits: "00000000", value: 0 },
  { bits: "00000001", value: 2 ** -149 },
  { bits: "00000002", value: 2 ** -148 },
  { bits: "007fffff", value: 2 ** -126 - 2 ** -149 },
  { bits: "00800000", value: 2 ** -126 },
  { bits: "3f000000", value: 0.5 },
  { bits: "3f000001", value: 0.5 + 2 ** -24 },
  { bits: "3f7fffff", value: 1 - 2 ** -24 },
  { bits: "3f800000", value: 1 },
];
const invalidRanks = [
  null,
  0,
  0.5,
  NaN,
  Infinity,
  -Infinity,
  "",
  "0000000",
  "000000000",
  "0000000g",
  "3F000000",
  " 00000000",
  "00000000\n",
  "80000000",
  "80000001",
  "bf000000",
  "7fc00000",
  "7f800001",
  "7f800000",
  "ff800000",
  "3f800001",
  "7f7fffff",
];

describe("authenticated strict v2 rank envelopes through the actual handler", () => {
  test.each(invalidRanks)("rejects rank boundary %j without coercion", async (rank) => {
    const payload = await decrypt(await firstToken());
    const token = await encrypt({ ...payload, keys: [{ kind: "rank-float4", value: rank }, payload.keys[1]] });
    await expect(endpoint().request({ ...requestInput, cursor: token })).rejects.toMatchObject(restart);
  });
  test.each(exactValues)(
    "preserves ciphertext bits $bits and accepts the exact key on the handler",
    async ({ bits, value }) => {
      const route = endpoint();
      const resolved = resolveFullText(route.descriptor, requestInput, { canonical: "'cat'", nodes: 1, tree: "'cat'" });
      const codec = createSearchCursor(
        secret,
        route.descriptor,
        requestInput,
        { branchId: "br-one", namespace: "component-one", contract: "articles.search", identity },
        undefined,
        resolved,
      );
      const token = await codec.issue([bits, id], "forward");
      expect((await decrypt(token)).keys).toEqual([
        { kind: "rank-float4", value: bits },
        { kind: "uuid", value: id },
      ]);
      expect(await codec.read(token, "forward")).toEqual([bits, id]);
      const backward = await codec.issue([bits, id], "backward");
      expect(await codec.read(backward, "backward")).toEqual([bits, id]);
      // Every fixture row has one title lexeme: normalized rank is independently 1 / (1 + 1) = 0.5.
      const page = await route.request({ ...requestInput, limit: 100, cursor: token });
      expect(page.rows).toEqual(
        Array.from({ length: value < 0.5 ? 0 : value === 0.5 ? 2 : 3 }, () => ({ title: "cats" })),
      );
      const previous = await route.request({ ...requestInput, limit: 100, cursor: backward, direction: "backward" });
      expect(previous.rows).toEqual(Array.from({ length: value < 0.5 ? 3 : 0 }, () => ({ title: "cats" })));
    },
  );
  test("issues exact private float4 bits from real PostgreSQL rows", async () => {
    const payload = await decrypt(await firstToken());
    expect(payload.keys).toEqual([
      { kind: "rank-float4", value: "3f000000" },
      { kind: "uuid", value: id },
    ]);
  });
  test("rejects authenticated malformed envelope/header/key tuples", async () => {
    const payload = await decrypt(await firstToken());
    const { iat: _iat, ...missingIssuedAt } = payload;
    const { exp: _exp, ...missingExpiry } = payload;
    const malformed: readonly TokenPayload[] = [
      { ...payload, v: 1 },
      { ...payload, v: 3 },
      { ...payload, unexpected: true },
      { ...payload, binding: "obsolete" },
      { ...payload, direction: "sideways" },
      missingIssuedAt,
      missingExpiry,
      { ...payload, iat: payload.iat + 0.5 },
      { ...payload, exp: payload.exp + 1 },
      { ...payload, keys: [] },
      { ...payload, keys: [payload.keys[0]] },
      { ...payload, keys: [...payload.keys, payload.keys[1]] },
      { ...payload, keys: [payload.keys[1], payload.keys[0]] },
      { ...payload, keys: [{ ...payload.keys[0], extra: true }, payload.keys[1]] },
      { ...payload, keys: [{ kind: "number", value: 0.5 }, payload.keys[1]] },
      { ...payload, keys: [payload.keys[0], { kind: "uuid", value: "wrong" }] },
      { ...payload, keys: [payload.keys[0], { ...payload.keys[1], extra: true }] },
      { ...payload, keys: [payload.keys[0], { kind: "string", value: id }] },
    ];
    for (const changed of malformed)
      await expect(endpoint().request({ ...requestInput, cursor: await encrypt(changed) })).rejects.toMatchObject(
        restart,
      );
    for (const typ of ["kello.search.cursor.v1", "JWT"])
      await expect(endpoint().request({ ...requestInput, cursor: await encrypt(payload, typ) })).rejects.toMatchObject(
        restart,
      );
  });
  test("keeps field v1 and rank v2 mutually unreadable on the real route", async () => {
    const route = endpoint();
    const legacyInput = { columns: { title: true }, limit: 1 } as const;
    const legacy = await route.request(legacyInput);
    if (!legacy.nextCursor) throw new Error("Missing field-mode cursor");
    await expect(route.request({ ...requestInput, cursor: legacy.nextCursor })).rejects.toMatchObject(restart);
    await expect(route.request({ ...legacyInput, cursor: await firstToken() })).rejects.toMatchObject(restart);
    expect((await jwtDecrypt(legacy.nextCursor, Buffer.from(secret, "hex"))).protectedHeader.typ).toBe(
      "kello.search.cursor.v1",
    );
  });
});

// Independent canonical fixture encoder: do not use searchCursorBinding or private semantics.
type BindingFixture =
  | string
  | number
  | boolean
  | null
  | readonly BindingFixture[]
  | { readonly [key: string]: BindingFixture };
function canonicalFixture(value: BindingFixture): string {
  if (Array.isArray(value)) return `[${value.map(canonicalFixture).join(",")}]`;
  if (value !== null && v.is(v.object({}), value))
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, entry]) => `${JSON.stringify(name)}:${canonicalFixture(entry)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
const hashFixture = (value: BindingFixture) => createHash("sha256").update(canonicalFixture(value)).digest("hex");
interface SemanticFixture {
  readonly parser?: string;
  readonly rank?: string;
  readonly codec?: string;
  readonly canonical?: string;
}
function bindingFixture(descriptor: SearchRuntimeDescriptor, semantics: SemanticFixture = {}) {
  const existing = hashFixture({
    branch: "br-one",
    namespace: "component-one",
    contract: "articles.search",
    policy: descriptor.fingerprint,
    entity: "articles",
    mode: "finite",
    identity,
    query: {
      columns: { title: true },
      orderBy: [
        { field: "_createdAt", direction: "asc", nulls: "last" },
        { field: "_id", direction: "asc", nulls: "last" },
      ],
    },
  });
  return hashFixture({
    existing,
    schema: descriptor.schemaFingerprint,
    raw: " cats ",
    canonical: semantics.canonical ?? "'cat'",
    name: "content",
    document: {
      config: "pg_catalog.english",
      fields: [
        { field: "title", weight: "A" },
        { field: "body", weight: "D" },
      ],
      version: "1",
      representation: "expression",
    },
    parser: semantics.parser ?? "plain-v1",
    rank: semantics.rank ?? "ts_rank_cd",
    normalization: 32,
    weights: [0.1, 0.2, 0.4, 1],
    codec: semantics.codec ?? "float4-bits-v1",
    order: "rank-desc-id-asc",
  });
}

describe("real metadata and token semantic boundaries", () => {
  test("binds fixed parser/rank versions and rejects prior-version authenticated tokens", async () => {
    const route = endpoint();
    const payload = await decrypt(await firstToken());
    // Establish the current independent fixture first; obsolete-version rejection alone proves nothing.
    expect(payload.binding).toBe(bindingFixture(route.descriptor));
    const current = await encrypt({ ...payload, binding: bindingFixture(route.descriptor) });
    expect((await route.request({ ...requestInput, cursor: current })).rows).toEqual([{ title: "cats" }]);
    for (const semantics of [
      { parser: "plain-v0" },
      { rank: "ts_rank" },
      { codec: "float4-bits-v0" },
      { canonical: "'cats'" },
    ]) {
      const token = await encrypt({ ...payload, binding: bindingFixture(route.descriptor, semantics) });
      await expect(route.request({ ...requestInput, cursor: token })).rejects.toMatchObject(restart);
    }
  });
  test("preserves the fixed old absent-FTS descriptor fixture", () => {
    const legacy = defineSchema(() => ({ articles: { title: fields.text().notNull(), body: fields.text() } }));
    const pair = createSearchValidators(legacy, defineRelations(legacy.tables)).articles.search({
      scope: "public",
      columns: ["title"],
      filter: ["title"],
      text: ["title"],
      order: ["title"],
    });
    const descriptor = searchSchemaMetadata(pair.input)?.descriptor;
    expect(descriptor?.fingerprint).toBe("3898f6fbe6565a5f0476b88eb32eb01f98359cf99d4d77500043ecdf30040918");
    expect(descriptor?.budgets).toEqual(defaultSearchBudgets);
    expect(descriptor?.node).not.toHaveProperty("fullText");
    expect(descriptor?.node.public).not.toHaveProperty("fullText");
  });
});
