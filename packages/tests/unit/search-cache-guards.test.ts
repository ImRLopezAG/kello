import { createORPCClient } from "@orpc/client";
import type { Client } from "@orpc/client";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { keepPreviousData, QueryClient, QueryObserver, InfiniteQueryObserver } from "@tanstack/react-query";
import { createSearchQueryPlugin, createSearchDataGuard } from "../../../apps/kello/src/core/client/index";
import type { SearchCacheEntry } from "../../../apps/kello/src/core/client/index";
import { createProjectContext, searchPublicNode } from "../../../apps/kello/src/core/server/index";
import { oc, eventIterator } from "../../../apps/kello/src/core/contract/index";
import type { RouterContractClient } from "../../../apps/kello/src/core/contract/index";
import { describe, expect, it } from "vite-plus/test";
import * as v from "valibot";
import type { DonePage, TitlePage, titleSelection, doneSelection } from "../fixtures/search-schema";
import { searchSchema, searchRelations } from "../fixtures/search-schema";

type Page = TitlePage | DonePage;
type Input = typeof titleSelection | typeof doneSelection;
type SearchClient = { search: Client<object, Input, Page, Error>; ordinary: Client<object, void, string, Error> };
const donePage = v.object({ rows: v.array(v.object({ done: v.boolean() })), nextCursor: v.nullable(v.string()) });
const titlePage = v.object({ rows: v.array(v.object({ title: v.string() })), nextCursor: v.nullable(v.string()) });
const doneInput = v.object({ columns: v.object({ done: v.literal(true) }) });
const title: TitlePage = { rows: [{ title: "previous" }], nextCursor: null };
const done: DonePage = { rows: [{ done: true }], nextCursor: null };
function plugin() {
  return createSearchQueryPlugin<SearchClient>([
    {
      path: ["search"],
      accepts: (entry): entry is SearchCacheEntry =>
        v.is(v.object({ input: v.unknown(), data: v.unknown() }), entry) &&
        v.is(v.is(doneInput, entry.input) ? donePage : titlePage, entry.data),
    },
  ]);
}

describe("search projection cache guards", () => {
  for (const defaults of ["global", "key", "utility"] as const) {
    it(`shadows ${defaults} data defaults while preserving native options and ordinary procedures`, async () => {
      let finish: (value: Page) => void = () => {};
      const pending = new Promise<Page>((resolve) => {
        finish = resolve;
      });
      const client = createORPCClient<SearchClient>({
        call: async (_path, input) => (v.is(doneInput, input) ? pending : title),
      });
      const rpc = createTanstackQueryUtils(client, {
        prefix: "guard-proof",
        plugins: [plugin()],
        scoped:
          defaults === "utility"
            ? { search: { queryOptions: { initialData: title, placeholderData: keepPreviousData } } }
            : {},
      });
      const cache = new QueryClient({
        defaultOptions: {
          queries:
            defaults === "global"
              ? { initialData: title, placeholderData: keepPreviousData, retry: false }
              : { retry: false },
        },
      });
      if (defaults === "key")
        cache.setQueryDefaults(["guard-proof"], { initialData: title, placeholderData: keepPreviousData });
      const observer = new QueryObserver(cache, rpc.search.queryOptions({ input: { columns: { title: true } } }));
      const stop = observer.subscribe(() => {});
      try {
        await cache.query(rpc.search.queryOptions({ input: { columns: { title: true } } }));
        const next = rpc.search.queryOptions({ input: { columns: { done: true } }, enabled: true, staleTime: 5_000 });
        observer.setOptions(next);
        expect(observer.getCurrentResult().data).toBeUndefined();
        expect(observer.getCurrentResult().isPlaceholderData).toBe(false);
        expect(cache.defaultQueryOptions(next).staleTime).toBe(5_000);
        expect(cache.defaultQueryOptions(next).retry).toBe(false);
        finish(done);
        await cache.query(next);
        expect(observer.getCurrentResult().data).toEqual(done);
        const ordinary = rpc.ordinary.queryOptions({});
        expect(Object.hasOwn(ordinary, "initialData")).toBe(false);
        expect(Object.hasOwn(ordinary, "placeholderData")).toBe(false);
      } finally {
        finish(done);
        stop();
        observer.destroy();
        cache.clear();
      }
    });
  }

  it("retains compatible extra fields and validates lazy initial data", () => {
    const rpc = createTanstackQueryUtils(createORPCClient<SearchClient>({ call: async () => done }), {
      plugins: [plugin()],
    });
    const options = rpc.search.queryOptions({ input: { columns: { done: true } }, initialData: () => done });
    const cache = new QueryClient();
    const observer = new QueryObserver(cache, options);
    try {
      expect(observer.getCurrentResult().data).toEqual(done);
    } finally {
      observer.destroy();
      cache.clear();
    }
    expect(() => rpc.search.queryOptions({ input: { columns: { done: true } }, initialData: title })).toThrow(
      "initialData",
    );
  });

  it("revalidates a reused per-call placeholder callback for each projection", async () => {
    const rpc = createTanstackQueryUtils(createORPCClient<SearchClient>({ call: async () => done }), {
      plugins: [plugin()],
    });
    const cache = new QueryClient();
    const first = rpc.search.queryOptions({ input: { columns: { title: true } }, initialData: title, enabled: false });
    const observer = new QueryObserver(cache, first);
    const stop = observer.subscribe(() => {});
    try {
      observer.setOptions(
        rpc.search.queryOptions({
          input: { columns: { done: true } },
          enabled: false,
          placeholderData: keepPreviousData,
        }),
      );
      expect(observer.getCurrentResult().data).toBeUndefined();
      observer.setOptions(
        rpc.search.queryOptions({
          input: { columns: { title: true } },
          enabled: false,
          placeholderData: keepPreviousData,
          queryKey: ["second-title"],
        }),
      );
      expect(observer.getCurrentResult().data).toEqual(title);
      observer.setOptions(
        rpc.search.queryOptions({
          input: { columns: { done: true } },
          enabled: false,
          placeholderData: keepPreviousData,
          queryKey: ["second-done"],
        }),
      );
      expect(observer.getCurrentResult().data).toBeUndefined();
    } finally {
      stop();
      observer.destroy();
      cache.clear();
    }
  });
});

describe("generated metadata guards across native option forms", () => {
  const { validators } = createProjectContext(searchSchema, searchRelations);
  const descriptor = validators.tables.tasks.search({
    scope: "public",
    through: { taskLabels: "public" },
    columns: ["title", "done"],
    relations: {
      labels: { scope: "public", columns: ["name"] },
    },
  });
  const node = searchPublicNode(descriptor.input);
  if (!node) throw new Error("Descriptor metadata missing");
  const contract = {
    list: oc.input(descriptor.input).output(descriptor.output),
    watch: oc.input(descriptor.input).output(eventIterator(descriptor.output)),
  };
  type Native = RouterContractClient<typeof contract>;
  const titlePage = { rows: [{ title: "old" }], nextCursor: null, previousCursor: null };
  const donePage = { rows: [{ done: true }], nextCursor: null, previousCursor: null };
  const guards = [createSearchDataGuard(["list"], node), createSearchDataGuard(["watch"], node)];
  const rpc = createTanstackQueryUtils(createORPCClient<Native>({ call: async () => donePage }), {
    plugins: [createSearchQueryPlugin<Native>(guards)],
  });

  it("validates selected scalars, nested shapes, defaults and policy-masked exclusions", () => {
    const guard = guards[0]!;
    expect(guard.accepts({ input: { columns: { done: true } }, data: donePage })).toBe(true);
    expect(guard.accepts({ input: { columns: { done: true } }, data: titlePage })).toBe(false);
    expect(guard.accepts({ input: { columns: { done: true } }, data: { ...donePage, rows: [{ done: "yes" }] } })).toBe(
      false,
    );
    expect(guard.accepts({ input: { columns: { title: false } }, data: donePage })).toBe(true);
    expect(
      guard.accepts({ input: {}, data: { ...donePage, rows: [{ done: true, title: "both", extra: "compatible" }] } }),
    ).toBe(true);
    expect(
      guard.accepts({
        input: { columns: { done: true }, with: { labels: {} } },
        data: { ...donePage, rows: [{ done: true, labels: [{ name: "label" }] }] },
      }),
    ).toBe(true);
    expect(guard.accepts({ input: { columns: { done: true }, with: { labels: {} } }, data: donePage })).toBe(false);
    expect(guard.accepts({ input: { columns: { projectId: true } }, data: donePage })).toBe(false);
  });

  it("matches nested router paths with cache prefixes", () => {
    const client = createORPCClient<{ organization: { tasks: { list: Native["list"] } } }>({
      call: async () => donePage,
    });
    const nested = createTanstackQueryUtils(client, {
      prefix: "identity-scope",
      plugins: [createSearchQueryPlugin([createSearchDataGuard(["organization", "tasks", "list"], node)])],
    });
    expect(() =>
      nested.organization.tasks.list.queryOptions({ input: { columns: { done: true } }, initialData: titlePage }),
    ).toThrow("initialData");
  });

  it("shadows inherited infinite data and checks all pages against their parameters", () => {
    const titleData = { pages: [titlePage], pageParams: [null] };
    const cache = new QueryClient({
      defaultOptions: { queries: { initialData: titleData, placeholderData: keepPreviousData } },
    });
    const first = rpc.list.infiniteOptions({
      input: () => ({ columns: { title: true } }),
      initialPageParam: null,
      getNextPageParam: () => null,
      initialData: titleData,
      enabled: false,
    });
    const observer = new InfiniteQueryObserver(cache, first);
    const stop = observer.subscribe(() => {});
    try {
      expect(observer.getCurrentResult().data).toEqual(titleData);
      observer.setOptions(
        rpc.list.infiniteOptions({
          input: () => ({ columns: { done: true } }),
          initialPageParam: null,
          getNextPageParam: () => null,
          enabled: false,
          placeholderData: keepPreviousData,
        }),
      );
      expect(observer.getCurrentResult().data).toBeUndefined();
      const malformed = { pages: [donePage, titlePage], pageParams: [null, null] };
      expect(() =>
        rpc.list.infiniteOptions({
          input: () => ({ columns: { done: true } }),
          initialPageParam: null,
          getNextPageParam: () => null,
          initialData: malformed,
        }),
      ).toThrow("initialData");
      expect(() =>
        rpc.list.infiniteOptions({
          input: () => ({ columns: { done: true } }),
          initialPageParam: null,
          getNextPageParam: () => null,
          initialData: { pages: [donePage], pageParams: [] },
        }),
      ).toThrow("initialData");
    } finally {
      stop();
      observer.destroy();
      cache.clear();
    }
  });

  it("shadows live defaults and repeated placeholders while the first event is pending", () => {
    const cache = new QueryClient({
      defaultOptions: { queries: { initialData: titlePage, placeholderData: keepPreviousData } },
    });
    const observer = new QueryObserver(
      cache,
      rpc.watch.liveOptions({ input: { columns: { title: true } }, initialData: titlePage, enabled: false }),
    );
    const stop = observer.subscribe(() => {});
    try {
      observer.setOptions(
        rpc.watch.liveOptions({
          input: { columns: { done: true } },
          enabled: false,
          placeholderData: keepPreviousData,
        }),
      );
      expect(observer.getCurrentResult().data).toBeUndefined();
      expect(observer.getCurrentResult().isPlaceholderData).toBe(false);
      expect(() => rpc.watch.liveOptions({ input: { columns: { done: true } }, initialData: titlePage })).toThrow(
        "initialData",
      );
      observer.setOptions(
        rpc.watch.liveOptions({
          input: { columns: { done: true } },
          initialData: () => donePage,
          enabled: false,
          queryKey: ["valid-done-live"],
        }),
      );
      expect(observer.getCurrentResult().data).toEqual(donePage);
    } finally {
      stop();
      observer.destroy();
      cache.clear();
    }
  });
});
