import { describe, expect, it } from "vite-plus/test";
import {
  createProjectContext,
  createProjectProcedures,
  createRpcRuntime,
} from "../../../apps/kello/src/core/server/index";
import { oc } from "../../../apps/kello/src/core/contract/index";
import { searchSchema, searchRelations } from "../fixtures/search-schema";
import { searchContractDescriptor } from "../../../apps/kello/src/core/search/metadata";
import { searchOrdering, searchKeyset, searchOrderSQL } from "../../../apps/kello/src/core/search/ordering";
import { createSearchCursor, searchCursorBinding } from "../../../apps/kello/src/core/search/cursor";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  applicationEnvironmentSources,
  resolveReleaseEnvironment,
} from "../../../apps/kello-cli/src/tooling/deploy/neon/environment";
import * as v from "valibot";
import { EncryptJWT, jwtDecrypt } from "jose";

const { validators } = createProjectContext(searchSchema, searchRelations);
const search = validators.tables.tasks.search({
  scope: "public",
  columns: ["title", "done"],
  filter: ["title", "done"],
  order: ["title", "at", "count", "amount"],
});
const descriptor = searchContractDescriptor(oc.input(search.input).output(search.output));
if (!descriptor) throw new Error("Missing descriptor");
const identity = { issuer: "https://auth.example", subject: "user", tenantId: "organization" };
const context = { branchId: "br-one", namespace: "app", contract: "tasks.list", identity };
const key = "01".repeat(32);
const id = "7c21a867-46c8-4f0f-96d7-65a7bc10ee12";

describe("authenticated exact search cursors", () => {
  it("issues field v1 cursors with strict title and ID continuation in both directions", async () => {
    const input = { columns: { title: true }, orderBy: [{ field: "title", direction: "desc" }] } as const;
    const order = searchOrdering(descriptor, input);
    expect(order).toEqual([
      { field: "title", direction: "desc", nulls: "last" },
      { field: "_id", direction: "asc", nulls: "last" },
    ]);
    const dialect = new PgDialect();
    const codec = createSearchCursor(key, descriptor, input, context);
    for (const direction of ["forward", "backward"] as const) {
      const token = await codec.issue(["same", id], direction);
      const { payload, protectedHeader } = await jwtDecrypt(token, Buffer.from(key, "hex"));
      expect(protectedHeader).toEqual({ alg: "dir", enc: "A256GCM", typ: "kello.search.cursor.v1" });
      expect(payload).toMatchObject({
        v: 1,
        direction,
        keys: [
          { kind: "string", value: "same" },
          { kind: "string", value: id },
        ],
      });
      expect(Object.keys(payload).sort()).toEqual(["binding", "direction", "exp", "iat", "keys", "v"]);
      const keys = await createSearchCursor(key, descriptor, input, context).read(token, direction);
      const boundary = dialect.sqlToQuery(searchKeyset(searchSchema.tables.tasks, order, keys, direction));
      expect(boundary.params).toEqual(["same", "same", id]);
      expect(boundary.sql).toContain(`"title" ${direction === "forward" ? "<" : ">"} $1`);
      expect(boundary.sql).toContain('"title" = $2');
      expect(boundary.sql).toContain(`"_id" ${direction === "forward" ? ">" : "<"} $3`);
      expect(boundary.sql).not.toMatch(/<=|>=/);
      const sorting = searchOrderSQL(searchSchema.tables.tasks, order, direction).map(
        (entry) => dialect.sqlToQuery(entry).sql,
      );
      expect(sorting).toEqual(
        direction === "forward"
          ? ['"app"."tasks"."title" desc nulls last', '"app"."tasks"."_id" asc nulls last']
          : ['"app"."tasks"."title" asc nulls first', '"app"."tasks"."_id" desc nulls first'],
      );
    }
  });
  it("preserves exact mixed keys across replica instances and expiry", async () => {
    const input = {
      orderBy: [
        { field: "at", direction: "desc" },
        { field: "count", direction: "asc" },
        { field: "amount", direction: "desc" },
      ],
    } as const;
    const order = searchOrdering(descriptor, input);
    const clock = () => new Date("2026-09-30T12:00:00Z");
    const codec = createSearchCursor(key, descriptor, input, context, clock);
    const keys = [new Date("2026-01-01T00:00:00.123Z"), 9007199254740993n, "-999999999999999999.0000000001", id];
    const token = await codec.issue(keys, "forward");
    expect(token).not.toContain("999999999999999999");
    expect(await createSearchCursor(key, descriptor, input, context, clock).read(token, "forward")).toEqual(keys);
    expect(order.map((entry) => entry.field)).toEqual(["at", "count", "amount", "_id"]);
    await expect(
      createSearchCursor(key, descriptor, input, context, () => new Date("2026-10-01")).read(token, "forward"),
    ).rejects.toMatchObject({ code: "INVALID_CURSOR", data: { restart: true } });
  });
  it("binds direction, query, policy, branch, component and stable identity", async () => {
    const input = { columns: { title: true }, where: { done: { eq: false }, title: { ne: "private" } }, limit: 2 };
    const codec = createSearchCursor(key, descriptor, input, context);
    const token = await codec.issue([42, id], "forward");
    expect(searchCursorBinding(descriptor, input, context)).toBe(
      searchCursorBinding(
        descriptor,
        { ...input, limit: 10, count: true, where: { title: { ne: "private" }, done: { eq: false } } },
        context,
      ),
    );
    await expect(codec.read(token, "backward")).rejects.toMatchObject({ code: "INVALID_CURSOR" });
    for (const changed of [
      { ...context, branchId: "br-two" },
      { ...context, namespace: "second" },
      { ...context, contract: "tasks.other" },
      { ...context, identity: { ...identity, tenantId: "other" } },
      { ...context, identity: { ...identity, issuer: "https://other.example" } },
      { ...context, identity: { ...identity, subject: "other" } },
    ])
      await expect(createSearchCursor(key, descriptor, input, changed).read(token, "forward")).rejects.toMatchObject({
        code: "INVALID_CURSOR",
        data: { restart: true },
      });
    await expect(
      createSearchCursor(key, descriptor, { ...input, columns: { done: true } }, context).read(token, "forward"),
    ).rejects.toMatchObject({ code: "INVALID_CURSOR" });
    await expect(
      createSearchCursor("02".repeat(32), descriptor, input, context).read(token, "forward"),
    ).rejects.toMatchObject({ code: "INVALID_CURSOR" });
    for (const invalid of [token.slice(1), `${token}x`, "!", "a".repeat(8193)])
      await expect(codec.read(invalid, "forward")).rejects.toMatchObject({ code: "INVALID_CURSOR" });
    expect(() => createSearchCursor(undefined, descriptor, input, context)).toThrow(/cursor key/i);
  });
  it("rejects invalid exact keys without coercion", async () => {
    const codec = createSearchCursor(key, descriptor, {}, context);
    for (const keys of [[-1, id], [1.5, id], [Number.MAX_SAFE_INTEGER + 1, id], ["42", id], [42, "wrong"], [42]])
      await expect(codec.issue(keys, "forward")).rejects.toMatchObject({ code: "INVALID_CURSOR" });
    const bigint = createSearchCursor(key, descriptor, { orderBy: [{ field: "count", direction: "asc" }] }, context);
    await expect(bigint.issue([9223372036854775808n, id], "forward")).rejects.toMatchObject({ code: "INVALID_CURSOR" });
  });
  it("preserves native timestamp microseconds and rejects authenticated invalid payloads", async () => {
    const input = { orderBy: [{ field: "at", direction: "asc" }] } as const;
    const codec = createSearchCursor(key, descriptor, input, context);
    const keys = [{ timestamp: "2026-01-01T00:00:00.000001Z" }, id];
    expect(await codec.read(await codec.issue(keys, "forward"), "forward")).toEqual(keys);
    for (const timestamp of ["10000-01-01T00:00:00.000001Z", "0002-01-01T00:00:00.000001Z BC"]) {
      const extended = [{ timestamp }, id];
      expect(await codec.read(await codec.issue(extended, "forward"), "forward")).toEqual(extended);
    }
    for (const timestamp of [
      "2026-02-30T00:00:00.000001Z",
      "2026-01-01T00:00:00.000001Zextra",
      "2026-01-01T00:00:00.001Z",
    ])
      await expect(codec.issue([{ timestamp }, id], "forward")).rejects.toMatchObject({ code: "INVALID_CURSOR" });
    const now = Math.floor(Date.now() / 1000);
    const valid = {
      v: 1,
      binding: searchCursorBinding(descriptor, {}, context),
      direction: "forward",
      keys: [
        { kind: "number", value: 42 },
        { kind: "string", value: id },
      ],
    };
    const plain = createSearchCursor(key, descriptor, {}, context);
    for (const payload of [
      { ...valid, v: 2 },
      { ...valid, binding: "obsolete" },
      {
        ...valid,
        keys: [
          { kind: "null", value: 42 },
          { kind: "string", value: id },
        ],
      },
      {
        ...valid,
        keys: [
          { kind: "string", value: "42" },
          { kind: "string", value: id },
        ],
      },
    ]) {
      const token = await new EncryptJWT(payload)
        .setProtectedHeader({ alg: "dir", enc: "A256GCM", typ: "kello.search.cursor.v1" })
        .setIssuedAt(now)
        .setExpirationTime(now + descriptor.budgets.cursorSeconds)
        .encrypt(Buffer.from(key, "hex"));
      await expect(plain.read(token, "forward")).rejects.toMatchObject({
        code: "INVALID_CURSOR",
        data: { restart: true },
      });
    }
  });
  it("refuses missing runtime keys before opening a connection and reserves managed secrets", async () => {
    const { procedure } = createProjectProcedures(searchSchema);
    const endpoint = procedure
      .input(search.input)
      .output(search.output)
      .handler(() => ({ rows: [], nextCursor: null, previousCursor: null }));
    let activated = false;
    await expect(
      createRpcRuntime({
        schema: searchSchema,
        relations: searchRelations,
        connectionString: "postgresql://runtime:fixture@ep-never.example.test/database",
        metadataNamespace: "loom_meta",
        deployment: "test",
        version: "a".repeat(64),
        procedures: [{ path: ["tasks", "list"], visibility: "public", procedure: endpoint }],
        environment: {},
        assertActive: async () => {
          activated = true;
        },
      }),
    ).rejects.toThrow("cursor key");
    expect(activated).toBe(false);
    for (const name of ["LOOM_ACTIVATION_TOKEN", "LOOM_SEARCH_CURSOR_KEY"]) {
      expect(() => applicationEnvironmentSources({ [name]: v.string() })).toThrow("managed secret");
      await expect(resolveReleaseEnvironment({ [name]: name }, undefined, { [name]: key })).rejects.toThrow(
        "managed secret",
      );
      await expect(resolveReleaseEnvironment({}, undefined, {}, [{ [name]: v.string() }])).rejects.toThrow(
        "managed secret",
      );
    }
  });
  it("compiles nullable lexicographic comparisons and reverses all sort priorities", () => {
    const order = searchOrdering(descriptor, { orderBy: [{ field: "at", direction: "desc", nulls: "first" }] });
    const forward = new PgDialect().sqlToQuery(searchKeyset(searchSchema.tables.tasks, order, [null, id], "forward"));
    const backward = new PgDialect().sqlToQuery(searchKeyset(searchSchema.tables.tasks, order, [null, id], "backward"));
    expect(forward.sql).toContain("is not null");
    expect(backward.sql).not.toContain("is not null");
    expect(forward.params).toContain(id);
  });
});
