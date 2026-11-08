import { describe, expect, test } from "vite-plus/test";
import { createORPCClient } from "@orpc/client";
import { implement, os } from "@orpc/server";
import { drizzle } from "drizzle-orm/node-postgres";
import { pgTable, text } from "drizzle-orm/pg-core";
import { QueryClient } from "@tanstack/react-query";
import * as v from "valibot";
import {
  createSearchDataGuard,
  createSearchQueryPlugin,
  createTanstackQueryUtils,
  StreamQuerySSRUtilsPlugin,
} from "../../../apps/kello/src/core/client/index";
import { createProjectContext, searchPublicNode } from "../../../apps/kello/src/core/server/index";
import { defineContract, eventIterator, oc, resolveContract } from "../../../apps/kello/src/core/contract";
import type { RouterContractClient } from "../../../apps/kello/src/core/contract";
import "../../../apps/kello/src/core/server/realtime/procedure";
import { applicationClientArtifacts } from "../../../apps/kello-cli/src/tooling/codegen/application";
import { discoverProcedures } from "../../../apps/kello-cli/src/tooling/codegen/procedures";
import { searchSchema, searchRelations } from "../fixtures/search-schema";

const ssrPlugin = "plugins: [new StreamQuerySSRUtilsPlugin()";
const searchPlugin = "createSearchQueryPlugin(";
const directory = "/project/src/generated";

const tasks = pgTable("tasks", { id: text().notNull(), title: text().notNull() });
const live = implement({
  list: oc
    .input(v.strictObject({ limit: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100)) }))
    .output(v.array(v.strictObject({ id: v.string(), title: v.string() })))
    .live(),
});
const liveRouter = live.router({
  list: live.list.live(({ input }) =>
    drizzle.mock().select({ id: tasks.id, title: tasks.title }).from(tasks).limit(input.limit),
  ),
});

const { validators } = createProjectContext(searchSchema, searchRelations);
const searchDescriptor = validators.tables.tasks.search({ scope: "public", columns: ["title", "done"] });
const searchContract = resolveContract(
  defineContract({ list: oc.input(searchDescriptor.input).output(searchDescriptor.output) }),
  { validators },
);
const searchBase = implement(searchContract);
const searchRouter = searchBase.router({
  list: searchBase.list.handler(() => ({ rows: [], nextCursor: null, previousCursor: null })),
});
const ordinaryRouter = { ordinary: os.output(v.string()).handler(() => "ok") };

type ProcedureExports = Parameters<typeof discoverProcedures>[0][number]["exports"];

const mountOptions = v.object({ refetchOnMount: v.optional(v.union([v.boolean(), v.literal("always")])) });

function refetchOnMount<Options>(options: Options) {
  return v.parse(mountOptions, options).refetchOnMount;
}

function artifact(router: ProcedureExports["default"]) {
  const project = {
    backend: "/project/kello",
    version: "a".repeat(64),
    procedures: discoverProcedures([{ path: "tasks.ts", visibility: "public", exports: { default: router } }]),
  };
  const source = applicationClientArtifacts(project, directory)["api.js"];
  if (!source) throw new Error("Generated api.js missing");
  return source;
}

describe("generated api.js stream SSR defaults", () => {
  test("imports the stream SSR plugin from kello/client", () => {
    expect(artifact(ordinaryRouter)).toContain(
      'import { createTanstackQueryUtils, StreamQuerySSRUtilsPlugin } from "kello/client";',
    );
  });

  test("registers it for an ordinary project without search plugin", () => {
    const source = artifact(ordinaryRouter);
    expect(source).toContain(ssrPlugin);
    expect(source).not.toContain(searchPlugin);
  });

  test("registers it for a live project without search plugin", () => {
    const source = artifact(liveRouter);
    expect(source).toContain("function queryUtils(link, options)");
    expect(source).toContain(ssrPlugin);
    expect(source).not.toContain(searchPlugin);
  });

  test("registers it before the search plugin for a search project", () => {
    const source = artifact(searchRouter);
    expect(source).toContain(searchPlugin);
    expect(source.indexOf("new StreamQuerySSRUtilsPlugin()")).toBeGreaterThan(-1);
    expect(source.indexOf("new StreamQuerySSRUtilsPlugin()")).toBeLessThan(source.indexOf(searchPlugin));
  });

  test("registers it in both the server client and the browser client", () => {
    const source = artifact(ordinaryRouter);
    expect(source.split("new StreamQuerySSRUtilsPlugin()")).toHaveLength(3);
  });
});

describe("StreamQuerySSRUtilsPlugin composed as generated", () => {
  const contract = {
    watch: oc.output(eventIterator(v.string())),
    feed: oc
      .input(v.object({ limit: v.number() }))
      .output(v.array(v.string()))
      .live(),
  };
  type Client = RouterContractClient<typeof contract>;
  const client = createORPCClient<Client>({
    call: async () => {
      throw new Error("Option construction must not call the client");
    },
  });
  const utils = (isServer: boolean) =>
    createTanstackQueryUtils(client, { plugins: [new StreamQuerySSRUtilsPlugin({ isServer })] });

  test("does not refetch streamed and live data on mount while rendering on the server", () => {
    const rpc = utils(true);
    expect(refetchOnMount(rpc.watch.streamedOptions({}))).toBe(false);
    expect(refetchOnMount(rpc.feed.liveOptions({ input: { limit: 1 } }))).toBe(false);
  });

  test("reopens streamed and live data on every mount in the browser", () => {
    const rpc = utils(false);
    expect(refetchOnMount(rpc.watch.streamedOptions({}))).toBe("always");
    expect(refetchOnMount(rpc.feed.liveOptions({ input: { limit: 1 } }))).toBe("always");
  });

  test("leaves ordinary query options untouched", () => {
    expect(refetchOnMount(utils(true).watch.queryOptions({}))).toBeUndefined();
  });

  async function liveQuery(isServer: boolean) {
    const open = Promise.withResolvers<void>();
    async function* stream() {
      yield ["first"];
      await open.promise;
      yield ["second"];
    }
    const feed = createORPCClient<Client>({ call: async () => stream() });
    const rpc = createTanstackQueryUtils(feed, { plugins: [new StreamQuerySSRUtilsPlugin({ isServer })] });
    const cache = new QueryClient();
    const fetched = cache.fetchQuery(rpc.feed.liveOptions({ input: { limit: 1 } }));
    const early = await Promise.race([
      fetched,
      new Promise<"pending">((resolve) => setTimeout(resolve, 25, "pending")),
    ]);
    const stop = () => {
      open.resolve();
      cache.clear();
    };
    return { early, fetched, cache, stop };
  }

  test("settles a live query at its first data on the server instead of waiting for the stream to end", async () => {
    const query = await liveQuery(true);
    try {
      expect(query.early).toEqual(["first"]);
    } finally {
      query.stop();
    }
  });

  test("keeps a live query open past its first data in the browser", async () => {
    const query = await liveQuery(false);
    try {
      expect(query.early).toBe("pending");
      expect(query.cache.getQueryCache().getAll()[0]?.state.data).toEqual(["first"]);
    } finally {
      query.stop();
      await query.fetched.catch(() => undefined);
    }
  });
});

describe("StreamQuerySSRUtilsPlugin with search validation", () => {
  const descriptor = validators.tables.tasks.search({ scope: "public", columns: ["title", "done"] });
  const node = searchPublicNode(descriptor.input);
  if (!node) throw new Error("Search metadata missing");
  const contract = {
    list: oc.input(descriptor.input).output(descriptor.output),
    watch: oc.input(descriptor.input).output(eventIterator(descriptor.output)),
  };
  type Client = RouterContractClient<typeof contract>;
  const page = { rows: [{ title: "task" }], nextCursor: null, previousCursor: null };
  const invalid = { rows: [{ title: 1 }], nextCursor: null, previousCursor: null };
  const rpc = createTanstackQueryUtils(createORPCClient<Client>({ call: async () => page }), {
    plugins: [
      new StreamQuerySSRUtilsPlugin({ isServer: true }),
      createSearchQueryPlugin<Client>([createSearchDataGuard(["list"], node), createSearchDataGuard(["watch"], node)]),
    ],
  });

  test("keeps the stream SSR defaults on a guarded search procedure", () => {
    expect(refetchOnMount(rpc.watch.streamedOptions({ input: { columns: { title: true } } }))).toBe(false);
  });

  test("still rejects initial data that violates the search projection", () => {
    const input = { columns: { title: true } } as const;
    expect(() => rpc.list.queryOptions({ input, initialData: page })).not.toThrow();
    expect(() => rpc.list.queryOptions({ input, initialData: invalid })).toThrow("initialData");
  });
});
