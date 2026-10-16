import { describe, expect, it } from "vite-plus/test";
import { createProjectContext, generateRpcOpenAPI, defineSchema } from "../../../apps/kello/src/core/server/index";
import { sql, defineRelations } from "drizzle-orm";
import {
  defineContract,
  resolveContract,
  oc,
  eventIterator,
  searchErrors,
} from "../../../apps/kello/src/core/contract/index";
import { implement } from "@orpc/server";
import { Schema } from "effect";
import * as v from "valibot";
import { z } from "zod";
import { searchSchema, searchRelations, nestedSelection } from "../fixtures/search-schema";
import { searchContractDescriptor } from "../../../apps/kello/src/core/search/metadata";
import type { SearchScope } from "../../../apps/kello/src/core/search/types";

const { validators } = createProjectContext(searchSchema, searchRelations);
const policy = {
  scope: "public",
  columns: ["title", "done", "projectId", "at", "count", "amount"],
  filter: ["title", "done", "projectId", "at", "count", "amount"],
  order: ["title", "at", "count", "amount"],
  text: ["title"],
  through: { taskLabels: "public" },
  relations: {
    labels: { scope: "public", columns: ["name"], filter: ["name"], order: ["name"], text: ["name"] },
    project: {
      scope: "public",
      columns: ["_id", "name"],
      filter: ["name"],
      relations: {
        organization: {
          scope: "public",
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
} as const;
const search = validators.tables.tasks.search(policy);
const live = validators.tables.tasks.liveSearch(policy);
const valid = async (value: Parameters<(typeof search.input)["~standard"]["validate"]>[0]) =>
  !(await search.input["~standard"].validate(value)).issues;

// These are runtime boundary tests: intentionally invalid values enter as unknown,
// while compile-time policy authoring remains covered by the generated consumer.
describe("schema-derived search contracts", () => {
  it("fingerprints native join columns and static relation filters", () => {
    function fingerprint(fromId: boolean, name: string) {
      const graph = defineRelations(searchSchema.tables, (r) => ({
        tasks: {
          project: r.one.projects({
            from: fromId ? r.tasks._id : r.tasks.projectId,
            to: r.projects._id,
            where: { name },
          }),
        },
      }));
      const context = createProjectContext(searchSchema, graph);
      const pair = context.validators.tables.tasks.search({
        scope: "public",
        columns: ["title"],
        relations: { project: { scope: "public", columns: ["name"] } },
      });
      return searchContractDescriptor(oc.input(pair.input).output(pair.output))?.fingerprint;
    }
    expect(fingerprint(false, "one")).not.toBe(fingerprint(true, "one"));
    expect(fingerprint(false, "one")).not.toBe(fingerprint(false, "two"));
    expect(fingerprint(false, "one")).toBe(fingerprint(false, "one"));
  });
  it("rejects foreign source and junction tables before deriving search", () => {
    const foreign = defineSchema((s) => ({ tasks: { title: s.text() }, links: { title: s.text() } }), {
      namespace: "foreign",
    });
    const graph = defineRelations(searchSchema.tables, (r) => ({
      tasks: {
        labels: r.many.labels({
          from: r.tasks._id.through(r.taskLabels.taskId),
          to: r.labels._id.through(r.taskLabels.labelId),
        }),
      },
    }));
    graph.tasks.relations.labels.sourceTable = foreign.tables.tasks;
    expect(() => createProjectContext(searchSchema, graph)).toThrow(/source/i);
    graph.tasks.relations.labels.sourceTable = searchSchema.tables.tasks;
    graph.tasks.relations.labels.throughTable = foreign.tables.links;
    expect(() => createProjectContext(searchSchema, graph)).toThrow(/junction/i);
  });
  it("retains table validators and validates defaults and four relation edges", async () => {
    expect(validators.tables.tasks.storage).toBe(searchSchema.validators.tasks.storage);
    expect(await valid({})).toBe(true);
    expect(await valid({ columns: undefined, with: { labels: { columns: undefined } } })).toBe(true);
    expect(await valid({ ...nestedSelection, columns: { title: true } })).toBe(true);
    expect(await valid({ columns: { title: false } })).toBe(true);
    for (const columns of [
      {},
      { missing: true },
      { title: true, done: false },
      { title: false, done: false, projectId: false, at: false, count: false, amount: false },
    ])
      expect(await valid({ columns })).toBe(false);
  });
  it("accepts every enabled scalar, boolean and relation operator without coercing codecs", async () => {
    for (const operator of ["eq", "ne", "gt", "gte", "lt", "lte", "contains", "startsWith", "endsWith"])
      expect(await valid({ where: { title: { [operator]: "hello%_\\" } } })).toBe(true);
    for (const operator of ["in", "notIn"])
      expect(await valid({ where: { title: { [operator]: ["one", "two"] } } })).toBe(true);
    for (const where of [
      { AND: [{ title: { eq: "one" } }, { OR: [{ done: { eq: true } }, { NOT: { done: { ne: false } } }] }] },
      { projectId: { isNull: true } },
      { count: { eq: 9007199254740993n } },
      { at: { eq: new Date("2026-01-01") } },
      { amount: { eq: "123456789.123456789" } },
      {
        relations: {
          labels: { some: { name: { contains: "tag", insensitive: true } }, none: { name: { eq: "hidden" } } },
        },
      },
      { relations: { project: { is: { name: { eq: "one" } }, isNot: { name: { eq: "other" } } } } },
    ])
      expect(await valid({ where })).toBe(true);
    for (const where of [
      { done: { gt: true } },
      { title: { isNull: true } },
      { title: { insensitive: true } },
      { title: { in: [null] } },
      { at: { eq: "2026-01-01" } },
      { count: { eq: "42" } },
      { relations: { labels: { is: {} } } },
      { relations: { project: { some: {} } } },
    ])
      expect(await valid({ where })).toBe(false);
  });
  it("enforces capabilities independently and rejects unknown controls", async () => {
    const limited = validators.tables.tasks.search({
      scope: "public",
      columns: ["title"],
      filter: ["done"],
      order: ["at"],
    });
    for (const value of [
      { columns: { done: true } },
      { where: { title: { eq: "hidden filter" } } },
      { orderBy: [{ field: "title", direction: "asc" }] },
      { with: { labels: {} } },
    ])
      expect((await limited.input["~standard"].validate(value)).issues).toBeDefined();
    expect(
      (
        await limited.input["~standard"].validate({
          where: { done: { eq: true } },
          orderBy: [{ field: "at", direction: "desc", nulls: "first" }],
        })
      ).issues,
    ).toBeUndefined();
    for (const value of [
      { sql: "drop table tasks" },
      { schema: "private" },
      { offset: 3 },
      { orderBy: [{ field: "at", direction: "asc", sql: "x" }] },
      {
        orderBy: [
          { field: "at", direction: "asc" },
          { field: "at", direction: "desc" },
        ],
      },
      { with: { labels: { cursor: "nested" } } },
    ])
      expect(await valid(value)).toBe(false);
  });
  it("bounds pages, predicates, lists, text, nesting and encoded bytes", async () => {
    const bounded = validators.tables.tasks.search({
      ...policy,
      budgets: { pageSize: 3, nestedSize: 2, predicates: 2, listSize: 2, textLength: 3, inputBytes: 200 },
    });
    for (const value of [
      { limit: 4 },
      { limit: 0 },
      { limit: 1.2 },
      { with: { labels: { limit: 3 } } },
      { where: { title: { in: ["a", "b", "c"] } } },
      { where: { title: { eq: "long" } } },
      { where: { AND: [{ done: { eq: true } }, { done: { eq: false } }, { done: { ne: false } }] } },
    ])
      expect((await bounded.input["~standard"].validate(value)).issues).toBeDefined();
    interface BooleanFilter {
      readonly NOT?: BooleanFilter;
    }
    let recursive: BooleanFilter = {};
    for (let i = 0; i < 10; i++) recursive = { NOT: recursive };
    expect(await valid({ where: recursive })).toBe(false);
    const tiny = validators.tables.tasks.search({ ...policy, budgets: { inputBytes: 2 } });
    expect((await tiny.input["~standard"].validate({ limit: 1 })).issues).toBeDefined();
  });
  it("rejects prototype-like keys, accessors and coercion without invoking them", async () => {
    let touched = false;
    const accessor = {
      get columns() {
        touched = true;
        throw new Error("must not run");
      },
    };
    const coercion = {
      toString() {
        touched = true;
        throw new Error("must not run");
      },
    };
    for (const value of [
      accessor,
      Object.create({ limit: 1 }),
      JSON.parse('{"columns":{"__proto__":true}}'),
      { where: JSON.parse('{"constructor":{}}') },
      { orderBy: [{ field: "at", direction: coercion }] },
    ])
      expect(await valid(value)).toBe(false);
    const array = ["x"];
    Object.defineProperty(array, "0", {
      get() {
        touched = true;
        return "x";
      },
    });
    expect(await valid({ where: { title: { in: array } } })).toBe(false);
    const date = new Date();
    Object.defineProperty(date, "getTime", {
      value() {
        touched = true;
        return 0;
      },
    });
    expect(await valid({ where: { at: { eq: date } } })).toBe(false);
    expect(touched).toBe(false);
  });
  it("keeps finite and explicit live-window contracts separate", async () => {
    expect((await live.input["~standard"].validate({ loadedPages: 2, anchor: null })).issues).toBeUndefined();
    for (const value of [{ cursor: "finite" }, { direction: "backward" }, { loadedPages: 11 }])
      expect((await live.input["~standard"].validate(value)).issues).toBeDefined();
    expect(await valid({ anchor: null })).toBe(false);
    expect(
      (await search.output["~standard"].validate({ rows: [{ title: "one" }], nextCursor: null, previousCursor: null }))
        .issues,
    ).toBeUndefined();
    for (const value of [
      { rows: [{ title: 1 }], nextCursor: null, previousCursor: null },
      { rows: [{ hidden: "secret" }], nextCursor: null, previousCursor: null },
      { rows: [{}], nextCursor: null, previousCursor: null },
      { rows: [{ at: "2026-01-01T00:00:00.000Z" }], nextCursor: null, previousCursor: null },
      { rows: [{ count: "9007199254740993" }], nextCursor: null, previousCursor: null },
    ])
      expect((await search.output["~standard"].validate(value)).issues).toBeDefined();
    const decoded = {
      rows: [{ at: new Date("2026-01-01"), count: 9007199254740993n }],
      nextCursor: null,
      previousCursor: null,
    };
    expect(await search.output["~standard"].validate(decoded)).toEqual({ value: decoded });
  });
  it("rejects mixed descriptors and modes during native contract discovery", () => {
    const other = validators.tables.tasks.search(policy);
    const context = { validators };
    expect(() =>
      resolveContract(defineContract({ list: oc.input(search.input).output(search.output) }), context),
    ).not.toThrow();
    expect(() => defineContract({ list: oc.input(search.input).output(other.output) })).toThrow(/identity/);
    expect(() => defineContract({ watch: oc.input(search.input).output(eventIterator(search.output)) })).toThrow(
      /identity/,
    );
    expect(() => defineContract({ watch: oc.input(live.input).output(live.output) })).not.toThrow();
    const contract = oc.errors(searchErrors).meta({ name: "search" }).input(search.input).output(search.output);
    expect(searchContractDescriptor(contract)?.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(searchContractDescriptor(contract)?.node.public.columns).toHaveProperty("title");
    expect(contract["~orpc"].errorMap.INVALID_CURSOR).toBeDefined();
  });
  it("requires explicit M2M junction scopes and fingerprints policies", () => {
    const { through: _through, ...unsafe } = policy;
    // Runtime authoring validation also runs for JavaScript consumers.
    expect(() => validators.tables.tasks.search(unsafe)).toThrow(/junction/);
    const first = searchContractDescriptor(oc.input(search.input).output(search.output));
    const narrowed = validators.tables.tasks.search({ ...policy, filter: ["done"], text: [] });
    const second = searchContractDescriptor(oc.input(narrowed.input).output(narrowed.output));
    expect(first?.fingerprint).not.toBe(second?.fingerprint);
  });
  it("composes with Zod, Valibot and Effect contracts and exports masked OpenAPI", async () => {
    const contract = resolveContract(
      defineContract({
        list: oc.errors(searchErrors).input(search.input).output(search.output),
        zod: oc.output(z.object({ ok: z.boolean() })),
        valibot: oc.output(v.object({ ok: v.boolean() })),
        effect: oc.output(Schema.toStandardSchemaV1(Schema.Struct({ ok: Schema.Boolean }))),
      }),
      { validators },
    );
    const base = implement(contract);
    const router = base.router({
      list: base.list.handler(() => ({ rows: [], nextCursor: null, previousCursor: null })),
      zod: base.zod.handler(() => ({ ok: true })),
      valibot: base.valibot.handler(() => ({ ok: true })),
      effect: base.effect.handler(() => ({ ok: true })),
    });
    const openapi = await generateRpcOpenAPI(router);
    const json = JSON.stringify(openapi);
    expect(json).toContain("/list");
    expect(json).toContain("maxItems");
    expect(json).not.toContain("taskLabels");
    expect(json).not.toContain("where: (");
  });
});

describe("server-owned policy dependency declarations", () => {
  const where = () => sql`true`;
  function descriptorFor(dependencies?: readonly (keyof typeof searchRelations)[]) {
    const scope: SearchScope<typeof searchRelations.tasks, typeof searchRelations> = {
      name: "root",
      version: "1",
      where,
    };
    const pair = validators.tables.tasks.search({
      columns: ["title"],
      scope: dependencies === undefined ? scope : { ...scope, dependencies },
    });
    const descriptor = searchContractDescriptor(oc.input(pair.input).output(pair.output));
    if (!descriptor) throw new Error("Missing search descriptor");
    return descriptor;
  }
  it("preserves the accepted U1 fingerprint when declarations are omitted", () => {
    // Accepted U1 6de6aac2 characterization under vp; callback source is hashed,
    // so this literal intentionally belongs to the unit-test transform.
    expect(descriptorFor().fingerprint).toBe("70c7fe2420ccd10ea07e27d93ec22dc3fe604614e4ab40cc14ead4d31e6ef651");
  });
  it("rejects client dependency declarations in finite and live selections", async () => {
    for (const pair of [search, live]) {
      for (const input of [
        { dependencies: [] },
        { scope: { dependencies: ["members"] } },
        { with: { labels: { dependencies: [] } } },
        { where: { dependencies: [] } },
      ]) {
        expect((await pair.input["~standard"].validate(input)).issues).toBeDefined();
      }
    }
  });
  it("distinguishes absent and empty and canonicalizes frozen runtime copies", () => {
    const absent = descriptorFor();
    const empty = descriptorFor([]);
    expect(empty.fingerprint).not.toBe(absent.fingerprint);
    const names: (keyof typeof searchRelations)[] = ["teams", "members", "teams"];
    const declared = descriptorFor(names);
    names.push("labels");
    expect(declared.node.scope).toMatchObject({ dependencies: ["members", "teams"] });
    if (declared.node.scope === "public") throw new Error("Missing scope");
    expect(Object.isFrozen(declared.node.scope.dependencies)).toBe(true);
    expect(declared.fingerprint).toBe(descriptorFor(["members", "teams"]).fingerprint);
    expect(declared.fingerprint).not.toBe(empty.fingerprint);
    expect(absent.node.scope).not.toHaveProperty("dependencies");
  });
  it("validates root, child and junction dependency names and array elements", () => {
    expect(() =>
      descriptorFor([
        // @ts-expect-error unknown graph-local dependency
        "typo",
      ]),
    ).toThrow(/dependenc/i);
    for (const dependencies of [null, "members", [1]]) {
      expect(() =>
        validators.tables.tasks.search({
          columns: ["title"],
          scope: {
            name: "root",
            version: "1",
            where,
            // @ts-expect-error malformed JavaScript authoring at runtime boundary
            dependencies,
          },
        }),
      ).toThrow();
    }
    expect(() =>
      validators.tables.tasks.search({
        columns: ["title"],
        scope: "public",
        relations: {
          project: {
            columns: ["name"],
            scope: {
              name: "child",
              version: "1",
              where,
              dependencies: [
                // @ts-expect-error unknown graph-local dependency
                "typo",
              ],
            },
          },
        },
      }),
    ).toThrow(/dependenc/i);
    expect(() =>
      validators.tables.tasks.search({
        columns: ["title"],
        scope: "public",
        through: {
          taskLabels: {
            name: "junction",
            version: "1",
            where,
            dependencies: [
              // @ts-expect-error unknown graph-local dependency
              "typo",
            ],
          },
        },
      }),
    ).toThrow(/dependenc/i);
  });
});
