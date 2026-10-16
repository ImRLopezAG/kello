// Authored consumer sources: every Kello import resolves through the installed
// tarball. These are not executed by importing this fixture module.
export const packedFullTextFiles = {
  "app/kello.config.ts": `import { defineConfig } from "kello/tooling";
export default defineConfig({ database: { namespace: "fts_packed_private_marker" } });
`,
  "app/kello/schema.ts": `import { defineSchema, defineTable } from "kello/server";
export default defineSchema(s => ({
  tasks: defineTable({
    title: s.text().notNull(), body: s.text(), done: s.boolean().notNull(),
    at: s.timestamp(), count: s.bigint(), amount: s.numeric(),
    projectId: s.reference("projects"), secret: s.text(),
  }, { fullText: {
    content: { config: "pg_catalog.english", fields: [{ field: "title", weight: "A" }, { field: "body", weight: "D" }], version: "packed-content-v1" },
    hidden: { config: "pg_catalog.simple", fields: [{ field: "secret", weight: "A" }], version: "packed-hidden-v1" },
  } }),
  projects: defineTable({ name: s.text().notNull(), organizationId: s.reference("organizations").notNull() }),
  organizations: defineTable({ name: s.text().notNull() }),
  labels: defineTable({ name: s.text().notNull() }),
  taskLabels: defineTable({ taskId: s.reference("tasks").notNull(), labelId: s.reference("labels").notNull() }),
}), { namespace: "fts_packed_private_marker" });
`,
  "app/kello/relations.ts": `import { defineRelations } from "drizzle-orm";
import schema from "./schema";
export default defineRelations(schema.tables, r => ({
  tasks: {
    project: r.one.projects({ from: r.tasks.projectId, to: r.projects._id }),
    labels: r.many.labels({ from: r.tasks._id.through(r.taskLabels.taskId), to: r.labels._id.through(r.taskLabels.labelId) }),
  },
  projects: { organization: r.one.organizations({ from: r.projects.organizationId, to: r.organizations._id, optional: false }) },
}));
`,
  "app/kello/contracts/tasks.ts": `import { defineContract, oc, searchErrors } from "kello/contract";
export const policy = {
  scope: "public", columns: ["_id", "title", "body", "done", "at", "count", "amount"],
  filter: ["title", "body", "done"], text: ["title", "body"], fullText: ["content"], order: ["title"],
  through: { taskLabels: "public" },
  relations: {
    labels: { scope: "public", columns: ["name"] },
    project: { scope: "public", columns: ["name"], relations: { organization: { scope: "public", columns: ["name"] } } },
  },
  budgets: { pageSize: 7, nestedSize: 3, loadedPages: 2, textLength: 96, fullTextQueryBytes: 192, fullTextQueryNodes: 16, fullTextTimeoutMs: 1000 },
} as const;
export default defineContract(({ validators }) => {
  const finite = validators.tables.tasks.search(policy);
  const live = validators.tables.tasks.liveSearch(policy);
  return {
    list: oc.errors(searchErrors).input(finite.input).output(finite.output),
    watch: oc.errors(searchErrors).input(live.input).output(live.output),
  };
});
`,
  "app/kello/functions/tasks.ts": `import { os } from "../_generated/rpc";
export default os.tasks.router({
  list: os.tasks.list.handler(({ context, input }) => context.search.tasks.paginate(input)),
  watch: os.tasks.watch.handler(({ context, input }) => context.search.tasks.watch(input)),
});
`,
  "app/kello/app.config.ts": `import { defineApplication } from "kello/server";
export default defineApplication({ rpc: ({ os }) => ({ os }) });
`,
} as const;

export const packedFullTextPositive = `import type { Id } from "kello/server";
import type { RpcCallContext } from "kello/client";
import { createClient } from "./app/kello/_generated/api";
import { QueryClient, useQuery, useInfiniteQuery, useSuspenseQuery, useSuspenseInfiniteQuery } from "@tanstack/react-query";
const { client, rpc } = createClient({ getToken: async () => null });
const matching = { fullText: { document: "content", query: "database migrations" } } as const;
const literal = { ...matching, columns: { title: true } } as const;
const native = { ...matching, columns: { _id: true, body: true, at: true, count: true, amount: true }, with: {
  labels: { columns: { name: true } },
  project: { columns: { name: true }, with: { organization: { columns: { name: true } } } },
} } as const;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;
export async function finite(flag: boolean) {
  const page = await client.tasks.list(literal);
  const exact: Assert<Equal<(typeof page.rows)[number], { title: string }>> = true;
  const nested = await client.tasks.list(native);
  const keys: Assert<Equal<keyof (typeof nested.rows)[number], "_id" | "body" | "at" | "count" | "amount" | "labels" | "project">> = true;
  const id: Assert<Equal<(typeof nested.rows)[number]["_id"], Id<"tasks">>> = true;
  const body: Assert<Equal<(typeof nested.rows)[number]["body"], string | null>> = true;
  const at: Assert<Equal<(typeof nested.rows)[number]["at"], Date | null>> = true;
  const count: Assert<Equal<(typeof nested.rows)[number]["count"], bigint | null>> = true;
  const amount: Assert<Equal<(typeof nested.rows)[number]["amount"], string | null>> = true;
  const relations: Assert<Equal<(typeof nested.rows)[number]["project"], { name: string; organization: { name: string } } | null>> = true;
  const labels: Assert<Equal<(typeof nested.rows)[number]["labels"], { name: string }[]>> = true;
  const conditional = await client.tasks.list(flag ? literal : { ...matching, columns: { done: true } });
  const union: Assert<Equal<(typeof conditional.rows)[number], { title: string } | { done: boolean }>> = true;
  const columns: { title: boolean } = { title: flag };
  const widened = await client.tasks.list({ ...matching, columns });
  const uncertain: Assert<Equal<(typeof widened.rows)[number]["title"], string | undefined>> = true;
  const optional: { columns?: { title: true } } = flag ? { columns: { title: true } } : {};
  const defaults = await client.tasks.list({ ...matching, ...optional });
  const optionalDone: Assert<Equal<(typeof defaults.rows)[number]["done"], boolean | undefined>> = true;
  await client.tasks.list({ ...literal, where: { AND: [{ body: { isNull: false } }, { title: { contains: "database" } }] }, count: true, cursor: null, direction: "backward", limit: 7 });
  void [exact, keys, id, body, at, count, amount, relations, labels, union, uncertain, optionalDone];
}
export async function live(flag: boolean) {
  const stream = await client.tasks.watch({ ...native, loadedPages: 2, anchor: null, count: true });
  for await (const window of stream) {
    const row = window.pages[0]![0]!;
    const id: Assert<Equal<typeof row._id, Id<"tasks">>> = true;
    const body: Assert<Equal<typeof row.body, string | null>> = true;
    const at: Assert<Equal<typeof row.at, Date | null>> = true;
    const count: Assert<Equal<typeof row.count, bigint | null>> = true;
    const amount: Assert<Equal<typeof row.amount, string | null>> = true;
    const relations: Assert<Equal<typeof row.project, { name: string; organization: { name: string } } | null>> = true;
    const labels: Assert<Equal<typeof row.labels, { name: string }[]>> = true;
    void [id, body, at, count, amount, relations, labels];
  }
  for await (const window of await client.tasks.watch(literal)) {
    const exact: Assert<Equal<(typeof window.pages)[number][number], { title: string }>> = true;
    void exact;
  }
  for await (const window of await client.tasks.watch(flag ? literal : { ...matching, columns: { done: true } })) {
    const union: Assert<Equal<(typeof window.pages)[number][number], { title: string } | { done: boolean }>> = true;
    void union;
  }
  const columns: { title: boolean } = { title: flag };
  for await (const window of await client.tasks.watch({ ...matching, columns })) {
    const uncertain: Assert<Equal<(typeof window.pages)[number][number]["title"], string | undefined>> = true;
    void uncertain;
  }
}
// Hooks are compiled, never called by the runtime descriptor/bundle proof.
export function useRankedOptions(flag: boolean) {
  const conditional = flag ? literal : { ...matching, columns: { done: true } } as const;
  const columns: { title: boolean } = { title: flag };
  const widened = { ...matching, columns };
  const options = rpc.tasks.list.queryOptions({ input: literal });
  const page = useQuery(options).data!;
  const exact: Assert<Equal<(typeof page.rows)[number], { title: string }>> = true;
  const cached = new QueryClient().getQueryData(options.queryKey)!;
  const cache: Assert<Equal<(typeof cached.rows)[number], { title: string }>> = true;
  const suspense = useSuspenseQuery(options).data;
  const suspenseExact: Assert<Equal<(typeof suspense.rows)[number], { title: string }>> = true;
  const conditionalPage = useQuery(rpc.tasks.list.queryOptions({ input: conditional })).data!;
  const union: Assert<Equal<(typeof conditionalPage.rows)[number], { title: string } | { done: boolean }>> = true;
  const widenedPage = useQuery(rpc.tasks.list.queryOptions({ input: widened })).data!;
  const uncertain: Assert<Equal<(typeof widenedPage.rows)[number]["title"], string | undefined>> = true;
  const nested = useQuery(rpc.tasks.list.queryOptions({ input: native })).data!.rows[0]!;
  const nestedId: Assert<Equal<typeof nested._id, Id<"tasks">>> = true;
  const nestedBody: Assert<Equal<typeof nested.body, string | null>> = true;
  const nestedAt: Assert<Equal<typeof nested.at, Date | null>> = true;
  const nestedCount: Assert<Equal<typeof nested.count, bigint | null>> = true;
  const nestedAmount: Assert<Equal<typeof nested.amount, string | null>> = true;
  const nestedLabels: Assert<Equal<typeof nested.labels, { name: string }[]>> = true;
  const nestedProject: Assert<Equal<typeof nested.project, { name: string; organization: { name: string } } | null>> = true;
  const infiniteOptions = rpc.tasks.list.infiniteOptions({
    input: (cursor: string | null) => ({ ...literal, cursor }), initialPageParam: null,
    getNextPageParam: page => page.nextCursor,
    getPreviousPageParam: page => page.previousCursor,
  });
  const infinite = useInfiniteQuery(infiniteOptions).data!.pages[0]!;
  const infiniteExact: Assert<Equal<(typeof infinite.rows)[number], { title: string }>> = true;
  const infiniteSuspense = useSuspenseInfiniteQuery(infiniteOptions).data.pages[0]!;
  const infiniteSuspenseExact: Assert<Equal<(typeof infiniteSuspense.rows)[number], { title: string }>> = true;
  const infiniteConditional = useInfiniteQuery(rpc.tasks.list.infiniteOptions({
    input: (cursor: string | null) => ({ ...conditional, cursor }), initialPageParam: null, getNextPageParam: page => page.nextCursor,
  })).data!.pages[0]!;
  const infiniteUnion: Assert<Equal<(typeof infiniteConditional.rows)[number], { title: string } | { done: boolean }>> = true;
  const infiniteWidened = useInfiniteQuery(rpc.tasks.list.infiniteOptions({
    input: (cursor: string | null) => ({ ...widened, cursor }), initialPageParam: null, getNextPageParam: page => page.nextCursor,
  })).data!.pages[0]!;
  const infiniteUncertain: Assert<Equal<(typeof infiniteWidened.rows)[number]["title"], string | undefined>> = true;
  const infiniteNative = useInfiniteQuery(rpc.tasks.list.infiniteOptions({
    input: (cursor: string | null) => ({ ...native, cursor }), initialPageParam: null, getNextPageParam: page => page.nextCursor,
  })).data!.pages[0]!.rows[0]!;
  const infiniteId: Assert<Equal<typeof infiniteNative._id, Id<"tasks">>> = true;
  const infiniteBody: Assert<Equal<typeof infiniteNative.body, string | null>> = true;
  const infiniteAt: Assert<Equal<typeof infiniteNative.at, Date | null>> = true;
  const infiniteCount: Assert<Equal<typeof infiniteNative.count, bigint | null>> = true;
  const infiniteAmount: Assert<Equal<typeof infiniteNative.amount, string | null>> = true;
  const infiniteLabels: Assert<Equal<typeof infiniteNative.labels, { name: string }[]>> = true;
  const infiniteProject: Assert<Equal<typeof infiniteNative.project, { name: string; organization: { name: string } } | null>> = true;
  const window = useQuery(rpc.tasks.watch.liveOptions({ input: literal })).data!;
  const liveExact: Assert<Equal<(typeof window.pages)[number][number], { title: string }>> = true;
  const conditionalWindow = useQuery(rpc.tasks.watch.liveOptions({ input: conditional })).data!;
  const liveUnion: Assert<Equal<(typeof conditionalWindow.pages)[number][number], { title: string } | { done: boolean }>> = true;
  const widenedWindow = useQuery(rpc.tasks.watch.liveOptions({ input: widened })).data!;
  const liveUncertain: Assert<Equal<(typeof widenedWindow.pages)[number][number]["title"], string | undefined>> = true;
  const liveNative = useQuery(rpc.tasks.watch.liveOptions({ input: native })).data!.pages[0]![0]!;
  const liveId: Assert<Equal<typeof liveNative._id, Id<"tasks">>> = true;
  const liveBody: Assert<Equal<typeof liveNative.body, string | null>> = true;
  const liveAt: Assert<Equal<typeof liveNative.at, Date | null>> = true;
  const liveCount: Assert<Equal<typeof liveNative.count, bigint | null>> = true;
  const liveAmount: Assert<Equal<typeof liveNative.amount, string | null>> = true;
  const liveLabels: Assert<Equal<typeof liveNative.labels, { name: string }[]>> = true;
  const liveProject: Assert<Equal<typeof liveNative.project, { name: string; organization: { name: string } } | null>> = true;
  const context: RpcCallContext = { idempotencyKey: "packed-ranked" };
  const initial = useQuery(rpc.tasks.list.queryOptions({ input: literal, context, retry: 1, staleTime: 100,
    initialData: { rows: [{ title: "cached" }], nextCursor: null, previousCursor: null },
    placeholderData: () => ({ rows: [{ title: "placeholder" }], nextCursor: null, previousCursor: null }),
    queryFn: async ({ signal }) => { signal.throwIfAborted(); return { rows: [{ title: "custom" }], nextCursor: null, previousCursor: null }; },
  })).data;
  const initialExact: Assert<Equal<(typeof initial.rows)[number], { title: string }>> = true;
  const selected: string[] | undefined = useQuery(rpc.tasks.list.queryOptions({ input: literal, select: page => page.rows.map(row => row.title) })).data;
  void [exact, cache, suspenseExact, union, uncertain, nestedId, nestedBody, nestedAt, nestedCount, nestedAmount, nestedLabels,
    nestedProject, infiniteExact, infiniteSuspenseExact, infiniteUnion, infiniteUncertain, infiniteId, infiniteBody,
    infiniteAt, infiniteCount, infiniteAmount, infiniteLabels, infiniteProject, liveExact, liveUnion, liveUncertain,
    liveId, liveBody, liveAt, liveCount, liveAmount, liveLabels, liveProject, initialExact, selected];
}
`;

// Each case gets its own compiler invocation. A red dependency or generated
// declaration cannot satisfy a forbidden-input assertion.
export const packedFullTextNegativeCases = [
  {
    name: "undeclared-document",
    statement: 'client.tasks.list({ fullText: { document: "absent", query: "database" } });',
    control: 'client.tasks.list({ fullText: { document: "content", query: "database" } });',
  },
  {
    name: "ungranted-document",
    statement: 'client.tasks.list({ fullText: { document: "hidden", query: "database" } });',
    control: 'client.tasks.list({ fullText: { document: "content", query: "database" } });',
  },
  {
    name: "live-ungranted-document",
    statement: 'client.tasks.watch({ fullText: { document: "hidden", query: "database" } });',
    control: 'client.tasks.watch({ fullText: { document: "content", query: "database" } });',
  },
  {
    name: "config",
    prelude: 'const input = { ...literal, fullText: { ...literal.fullText, config: "pg_catalog.simple" } } as const;',
    statement: "client.tasks.list(input);",
    control: "const input = { ...literal, fullText: { ...literal.fullText } } as const; client.tasks.list(input);",
  },
  {
    name: "rank-control",
    prelude: "const input = { ...literal, fullText: { ...literal.fullText, rank: 1 } } as const;",
    statement: "client.tasks.list(input);",
    control: "const input = { ...literal, fullText: { ...literal.fullText } } as const; client.tasks.list(input);",
  },
  {
    name: "rank-selection",
    statement: "client.tasks.list({ ...literal, columns: { title: true, rank: true } });",
    control: "client.tasks.list({ ...literal, columns: { title: true } });",
  },
  {
    name: "nested-full-text",
    prelude: "const input = { ...literal, with: { project: { fullText: literal.fullText } } } as const;",
    statement: "client.tasks.list(input);",
    control: "const input = { ...literal, with: { project: {} } } as const; client.tasks.list(input);",
  },
  {
    name: "boolean-full-text",
    statement: "client.tasks.list({ ...literal, where: { AND: [{ fullText: literal.fullText }] } });",
    control: "client.tasks.list({ ...literal, where: { AND: [{}] } });",
  },
  {
    name: "rank-order-conflict",
    statement: 'client.tasks.list({ ...literal, orderBy: [{ field: "title", direction: "asc" }] });',
    control: "client.tasks.list({ ...literal });",
  },
  {
    name: "forbidden-field",
    prelude: "const input = { ...literal, columns: { title: true, secret: true } } as const;",
    statement: "client.tasks.list(input);",
    control: "const input = { ...literal, columns: { title: true } } as const; client.tasks.list(input);",
  },
  {
    name: "options-forbidden-field",
    statement: "rpc.tasks.list.queryOptions({ input: { ...literal, columns: { title: true, secret: true } } });",
    control: "rpc.tasks.list.queryOptions({ input: { ...literal, columns: { title: true } } });",
  },
  {
    name: "infinite-forbidden-field",
    statement:
      "rpc.tasks.list.infiniteOptions({ input: (cursor: string | null) => ({ ...literal, columns: { title: true, secret: true }, cursor }), initialPageParam: null, getNextPageParam: () => null });",
    control:
      "rpc.tasks.list.infiniteOptions({ input: (cursor: string | null) => ({ ...literal, columns: { title: true }, cursor }), initialPageParam: null, getNextPageParam: () => null });",
  },
  {
    name: "live-forbidden-field",
    statement: "rpc.tasks.watch.liveOptions({ input: { ...literal, columns: { title: true, secret: true } } });",
    control: "rpc.tasks.watch.liveOptions({ input: { ...literal, columns: { title: true } } });",
  },
  {
    name: "nested-forbidden-field",
    statement: "client.tasks.list({ ...literal, with: { labels: { columns: { name: true, _id: true } } } });",
    control: "client.tasks.list({ ...literal, with: { labels: { columns: { name: true } } } });",
  },
  {
    name: "unselected-output",
    statement: "async function output() { const page = await client.tasks.list(literal); page.rows[0]!.body; }",
    control: "async function output() { const page = await client.tasks.list(literal); page.rows[0]!.title; }",
  },
  {
    name: "unsafe-initial-data",
    statement:
      "rpc.tasks.list.queryOptions({ input: literal, initialData: { rows: [{ title: 42 }], nextCursor: null, previousCursor: null } });",
    control:
      'rpc.tasks.list.queryOptions({ input: literal, initialData: { rows: [{ title: "safe" }], nextCursor: null, previousCursor: null } });',
  },
  {
    name: "unsafe-placeholder-data",
    statement:
      "rpc.tasks.list.queryOptions({ input: literal, placeholderData: () => ({ rows: [{ done: true }], nextCursor: null, previousCursor: null }) });",
    control:
      'rpc.tasks.list.queryOptions({ input: literal, placeholderData: () => ({ rows: [{ title: "safe" }], nextCursor: null, previousCursor: null }) });',
  },
  {
    name: "unsafe-query-fn",
    statement:
      "rpc.tasks.list.queryOptions({ input: literal, queryFn: async () => ({ rows: [{ done: true }], nextCursor: null, previousCursor: null }) });",
    control:
      'rpc.tasks.list.queryOptions({ input: literal, queryFn: async () => ({ rows: [{ title: "safe" }], nextCursor: null, previousCursor: null }) });',
  },
  {
    name: "unsafe-previous-data",
    statement: "rpc.tasks.list.queryOptions({ input: literal, placeholderData: keepPreviousData });",
    control: "rpc.tasks.list.queryOptions({ input: literal, placeholderData: () => undefined });",
  },
  {
    name: "unsafe-infinite-data",
    statement:
      "rpc.tasks.list.infiniteOptions({ input: (cursor: string | null) => ({ ...literal, cursor }), initialPageParam: null, getNextPageParam: () => null, initialData: { pages: [{ rows: [{ title: 42 }], nextCursor: null, previousCursor: null }], pageParams: [null] } });",
    control:
      'rpc.tasks.list.infiniteOptions({ input: (cursor: string | null) => ({ ...literal, cursor }), initialPageParam: null, getNextPageParam: () => null, initialData: { pages: [{ rows: [{ title: "safe" }], nextCursor: null, previousCursor: null }], pageParams: [null] } });',
  },
  {
    name: "unsafe-live-data",
    statement:
      "rpc.tasks.watch.liveOptions({ input: literal, initialData: { pages: [[{ title: 42 }]], nextCursor: null, previousCursor: null } });",
    control:
      'rpc.tasks.watch.liveOptions({ input: literal, initialData: { pages: [[{ title: "safe" }]], nextCursor: null, previousCursor: null } });',
  },
] as const;

export const packedFullTextRuntime = `import assert from "node:assert/strict";
import { searchPublicNode, generateRpcOpenAPI } from "kello/server";
import { createSearchDataGuard } from "kello/client";
import { contract } from "./app/kello/_generated/contract-registry.ts";
import tasks from "./app/kello/functions/tasks.ts";
const forbidden = /pg_catalog|packed-content-v1|packed-hidden-v1|fts_packed_private_marker|ts_rank|to_tsvector|plainto_tsquery|representation|weights?|taskLabels|secret|"(?:rank|_kello_rank|config|vector)"/;
for (const name of ["list", "watch"]) {
  const input = contract.tasks[name]["~orpc"].inputSchemas[0];
  const node = searchPublicNode(input);
  assert.ok(node, "generated contract must retain the public descriptor");
  assert.deepEqual(Object.keys(node.fullText), ["content"]);
  assert.deepEqual(Object.keys(node.fullText.content), ["semantics"]);
  assert.match(node.fullText.content.semantics, /^[a-f0-9]{64}$/);
  assert.equal(node.budgets.fullTextQueryBytes, 192);
  assert.equal(node.budgets.fullTextQueryNodes, 16);
  assert.equal(node.budgets.fullTextTimeoutMs, 1000);
  assert.doesNotMatch(JSON.stringify(node), forbidden);
  const json = input["~standard"].jsonSchema.input({ target: "draft-2020-12" });
  assert.deepEqual(json.properties.fullText, {
    type: "object", properties: { document: { type: "string", enum: ["content"] }, query: { type: "string", maxLength: 96 } },
    required: ["document", "query"], additionalProperties: false,
  });
  assert.deepEqual(json.not, { required: ["fullText", "orderBy"] });
  assert.equal(json.properties.limit.maximum, 7);
  assert.equal(json.properties.with.properties.labels.properties.limit.maximum, 3);
  assert.equal(json.properties.with.properties.project.properties.fullText, undefined);
  if (name === "watch") assert.equal(json.properties.loadedPages.maximum, 2);
  assert.doesNotMatch(JSON.stringify(json), forbidden);
  const selected = { fullText: { document: "content", query: "database" }, columns: { title: true } };
  const guard = createSearchDataGuard(["tasks", name], node);
  function data(row) { return { ...(name === "list" ? { rows: [row] } : { pages: [[row]] }), nextCursor: null, previousCursor: null }; }
  for (const [label, row] of [
    ["selected title", { title: "safe" }],
    ["compatible extra", { title: "safe", extra: "compatible" }],
    ["granted body", { title: "safe", body: "unselected" }],
  ]) assert.equal(guard.accepts({ input: selected, data: data(row) }), true, name + ": cache " + label);
  for (const [label, row] of [["missing title", {}], ["wrong title", { title: 42 }]]) {
    assert.equal(guard.accepts({ input: selected, data: data(row) }), false, name + ": cache " + label);
  }
  // Cache compatibility permits extras. The public output descriptor instead
  // checks policy-eligible fields; request-specific projection is enforced by
  // the server executor and has separate prior native-handler evidence.
  const output = contract.tasks[name]["~orpc"].outputSchemas[0];
  assert.ok(output, name + ": public output descriptor is required");
  for (const [label, row, expected] of [
    ["selected title", { title: "safe" }, true],
    ["eligible body", { title: "safe", body: "unselected" }, true],
    ["rank", { title: "safe", rank: 1 }, false],
    ["_kello_rank", { title: "safe", _kello_rank: 1 }, false],
    ["vector", { title: "safe", vector: "private" }, false],
    ["secret", { title: "safe", secret: "private" }, false],
    ["wrong title", { title: 42 }, false],
  ]) {
    if (name === "list") {
      const checked = await output["~standard"].validate(data(row));
      assert.equal(checked.issues === undefined, expected, name + ": output " + label);
      if (expected) assert.deepEqual(checked.value, data(row), name + ": output preserves " + label);
    } else {
      async function* event() { yield data(row); }
      const checked = await output["~standard"].validate(event());
      assert.equal(checked.issues, undefined, name + ": iterator structure " + label);
      const iterator = checked.value;
      try {
        if (expected) {
          assert.deepEqual(await iterator.next(), { done: false, value: data(row) }, name + ": yielded output " + label);
          assert.equal((await iterator.next()).done, true, name + ": completed " + label);
        } else {
          await assert.rejects(() => iterator.next(), { code: "ASYNC_ITERATOR_OBJECT_VALIDATION_FAILED" }, name + ": rejected yield " + label);
        }
      } finally {
        await iterator.return();
      }
    }
  }
  assert.equal((await input["~standard"].validate({ fullText: { document: "content", query: "database" }, columns: { title: true } })).issues, undefined);
  for (const value of [
    { fullText: { document: "hidden", query: "database" } },
    { fullText: { document: "content", query: "database", config: "pg_catalog.simple" } },
    { fullText: { document: "content", query: "database", rank: 1 } },
    { fullText: { document: "content", query: "x".repeat(97) } },
    { fullText: { document: "content", query: "界".repeat(65) } },
  ]) assert.ok((await input["~standard"].validate(value)).issues);
}
const openapi = await generateRpcOpenAPI({ tasks });
const json = JSON.stringify(openapi);
assert.doesNotMatch(json, forbidden);
// Pinned @orpc/openapi 2.0.0-beta.43: generate uses dotted operation IDs
// and pathToHttpPath; POST + compact defaults attach input to requestBody.
// buildRequest/toBodyContent retain schemas or hoist $defs into components.
// Follow only references reached from each operation's JSON request input.
function resolveReference(value) {
  const seen = new Set();
  assert.ok(value && typeof value === "object" && !Array.isArray(value), "attached OpenAPI object is required");
  while (value.$ref !== undefined) {
    const { $ref, ...siblings } = value;
    assert.equal(typeof $ref, "string");
    assert.ok($ref.startsWith("#/"), "request proof requires a local JSON Pointer");
    assert.equal(seen.has($ref), false, "cyclic request reference");
    seen.add($ref);
    let target = openapi;
    for (const segment of $ref.slice(2).split("/")) {
      const key = decodeURIComponent(segment).replace(/~1/g, "/").replace(/~0/g, "~");
      assert.ok(target && typeof target === "object" && Object.hasOwn(target, key), "missing attached reference: " + $ref);
      target = target[key];
    }
    assert.ok(target && typeof target === "object" && !Array.isArray(target), "reference must resolve to an object");
    value = { ...target, ...siblings };
  }
  return value;
}
const operations = [];
for (const name of ["list", "watch"]) {
  const path = resolveReference(openapi.paths?.["/tasks/" + name]);
  const operation = resolveReference(path.post);
  assert.equal(operation.operationId, "tasks." + name);
  const body = resolveReference(operation.requestBody);
  const input = resolveReference(body.content?.["application/json"]?.schema);
  assert.equal(input.type, "object");
  const fullText = resolveReference(input.properties?.fullText);
  assert.equal(fullText.type, "object");
  assert.deepEqual(Object.keys(fullText.properties).sort(), ["document", "query"]);
  const document = resolveReference(fullText.properties.document);
  const query = resolveReference(fullText.properties.query);
  assert.equal(document.type, "string");
  assert.deepEqual(document.enum, ["content"]);
  assert.equal(query.type, "string");
  assert.equal(query.maxLength, 96);
  assert.deepEqual(fullText.required, ["document", "query"]);
  assert.equal(fullText.additionalProperties, false);
  const exclusion = resolveReference(input.not);
  assert.deepEqual(Reflect.ownKeys(exclusion), ["required"]);
  assert.equal(Object.prototype.propertyIsEnumerable.call(exclusion, "required"), true);
  assert.deepEqual(exclusion.required, ["fullText", "orderBy"]);
  assert.equal(resolveReference(input.properties.limit).maximum, 7);
  const withInput = resolveReference(input.properties.with);
  const labels = resolveReference(withInput.properties.labels);
  assert.equal(resolveReference(labels.properties.limit).maximum, 3);
  assert.equal(resolveReference(withInput.properties.project).properties.fullText, undefined);
  if (name === "watch") {
    const loadedPages = resolveReference(input.properties.loadedPages);
    assert.equal(loadedPages.type, "integer");
    assert.equal(loadedPages.maximum, 2);
  }
  operations.push(operation.operationId);
}
assert.deepEqual(operations, ["tasks.list", "tasks.watch"]);
console.info(JSON.stringify({ proof: "packed-full-text-descriptor-openapi", descriptors: 2, operations }));
`;

export const packedFullTextBrowser = `import assert from "node:assert/strict";
import { build, stop } from "esbuild";
try {
const result = await build({ entryPoints: ["./app/kello/_generated/api.js"], bundle: true, platform: "browser", format: "esm", write: false, metafile: true });
assert.ok(result.outputFiles.length > 0);
const output = result.outputFiles.map(file => file.text).join("\\n");
const inputs = Object.keys(result.metafile.inputs);
assert.ok(inputs.some(input => input.includes("node_modules/kello/")), "bundle must traverse the installed public package");
for (const input of inputs) {
  const parts = input.split("/");
  for (const dependency of ["pg", "pg-pool", "pg-protocol", "drizzle-orm", "drizzle-kit", "libpg-query", "@neon", "@neondatabase", "@aws-sdk"]) {
    assert.equal(parts.includes(dependency), false, "server-only browser dependency: " + input);
  }
  for (const fragment of ["kello/dist/core/server/", "kello/dist/tooling/", "core/search/compiler", "core/search/executor", "core/search/full-text", "core/search/rank", "core/search/cursor"]) {
    assert.equal(input.includes(fragment), false, "server-only browser module: " + input);
  }
}
assert.match(output, /loom-search-projections/);
assert.match(output, /fullText/);
assert.match(output, /content/);
assert.doesNotMatch(output, /fts_packed_private_marker|packed-content-v1|packed-hidden-v1|taskLabels|projectId|organizationId|secret|pg_catalog|ts_rank|to_tsvector|plainto_tsquery|DATABASE_URL|node:fs|node:crypto|pg-protocol|drizzle-orm|libpg-query|kello.search.descriptor/);
console.info(JSON.stringify({ proof: "packed-full-text-public-browser", outputs: result.outputFiles.length, inputs, bytes: Buffer.byteLength(output) }));
} finally { stop(); }
`;
