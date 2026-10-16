import type { AnyNestedClient } from "@orpc/client";
import type { RouterUtilsPlugin } from "@orpc/tanstack-query";
import * as v from "valibot";
import { acceptsSearchPage, validSearchSelection } from "../search/public";
import type { SearchPublicNode, SearchPublicSelection } from "../search/public";

/** Public projection validation emitted by generation. It contains no database,
 * authorization policy, environment values, or server implementation. */
export interface SearchCacheEntry {
  readonly input: SearchPublicSelection;
  readonly data: object;
}

export interface SearchDataGuard {
  readonly path: readonly string[];
  readonly accepts: (entry: unknown) => entry is SearchCacheEntry;
}

/** Build a browser-safe cache validator from masked generated metadata. */
export function createSearchDataGuard(path: readonly string[], node: SearchPublicNode): SearchDataGuard {
  const accepts: SearchDataGuard["accepts"] = (entry): entry is SearchCacheEntry =>
    v.is(cacheEntry, entry) &&
    validSearchSelection(node, entry.input) &&
    acceptsSearchPage(node, entry.input, entry.data);
  return Object.freeze({ path, accepts });
}

const callable = v.function();
const cacheEntry = v.object({ input: v.unknown(), data: v.unknown() });
function isModifier<Arg, Result>(value: Result | ((arg: Arg) => Result)): value is (arg: Arg) => Result {
  return v.is(callable, value);
}
const infiniteData = v.object({ pages: v.array(v.unknown()), pageParams: v.array(v.unknown()) });

/** Extend native oRPC utilities for generated search procedures. Global, key,
 * and scoped data defaults are shadowed; explicit per-call data is validated.
 * Other native options, keys, transports, and ordinary procedures are retained. */
export function createSearchQueryPlugin<Client extends AnyNestedClient>(
  guards: readonly SearchDataGuard[],
): RouterUtilsPlugin<Client> {
  const indexed = new Map(guards.map((guard) => [JSON.stringify(guard.path), guard]));
  if (indexed.size !== guards.length) throw new Error("Duplicate search guard path");
  return {
    name: "loom-search-projections",
    initProcedureOptions(path, options) {
      const guard = indexed.get(JSON.stringify(path));
      if (!guard) return options;
      const { queryOptions, liveOptions, infiniteOptions } = options;
      return {
        ...options,
        queryOptions: (call) => {
          const merged = isModifier(queryOptions) ? queryOptions(call) : { ...queryOptions, ...call };
          return {
            ...merged,
            ...dataOptions(call, (value): value is unknown => guard.accepts({ input: merged.input, data: value })),
          };
        },
        liveOptions: (call) => {
          const merged = isModifier(liveOptions) ? liveOptions(call) : { ...liveOptions, ...call };
          return {
            ...merged,
            ...dataOptions(call, (value): value is unknown => guard.accepts({ input: merged.input, data: value })),
          };
        },
        infiniteOptions: (call) => {
          const merged = isModifier(infiniteOptions) ? infiniteOptions(call) : { ...infiniteOptions, ...call };
          return {
            ...merged,
            ...dataOptions(call, (value): value is v.InferOutput<typeof infiniteData> => {
              const input = merged.input;
              return (
                v.is(infiniteData, value) &&
                v.is(callable, input) &&
                value.pages.length === value.pageParams.length &&
                value.pages.every((page, index) => guard.accepts({ input: input(value.pageParams[index]), data: page }))
              );
            }),
          };
        },
      };
    },
  };
}

function dataOptions<Data>(
  options: { initialData?: unknown; placeholderData?: unknown },
  accepts: (value: unknown) => value is Data,
) {
  const initialParser = v.optional(
    v.custom<Data>(accepts, "Search initialData does not match the selected projection"),
  );
  const initialSource = options.initialData;
  const initialValue = v.is(callable, initialSource) ? undefined : v.parse(initialParser, initialSource);
  // Lazy empty values shadow inherited defaults, including infinite data whose
  // exact-optional native declarations do not admit an explicit undefined.
  const initialData = () => (v.is(callable, initialSource) ? v.parse(initialParser, initialSource()) : initialValue);
  const source = options.placeholderData;
  // Each call gets its own wrapper. TanStack's same-callback placeholder reuse
  // must not reuse data validated for a different projection.
  const placeholderData = (...args: unknown[]) => {
    const value: unknown = v.is(callable, source) ? source(...args) : source;
    return value !== undefined && accepts(value) ? value : undefined;
  };
  return { initialData, placeholderData };
}
