import type { AnyNestedClient, Client, ClientRest } from "@orpc/client";
import type { PromiseWithError } from "@orpc/shared";
import type {
  QueryOptionsIn,
  QueryOptionsOut,
  InfiniteOptionsIn,
  InfiniteOptionsOut,
  RouterUtils,
} from "@orpc/tanstack-query";
import type { DataTag, InfiniteData, QueryKey, SkipToken, PlaceholderDataFunction } from "@tanstack/react-query";
import type { ExactSearchInput, InferSearchProjector, SearchProjection, SearchProjector } from "../search/types";

type Event<Output> = Output extends AsyncIterable<infer Value> ? Value : Output;
type ProjectionOf<Output> = InferSearchProjector<Event<Output>>;
type Selected<Projection extends SearchProjector, Input, Output> =
  Output extends AsyncIterable<unknown>
    ? AsyncIteratorObject<SearchProjection<Projection, Input>>
    : SearchProjection<Projection, Input>;

/** Raw native clients keep their transport/context and infer each search call's
 * selected shape. Ordinary contract procedures retain their upstream types. */
export type SearchRouterClient<Router extends AnyNestedClient> =
  Router extends Client<infer Context, infer Input, infer Output, infer Error>
    ? [ProjectionOf<Output>] extends [never]
      ? Router
      : <const Selection extends Input>(
          ...rest: ClientRest<Context, Selection & ExactSearchInput<Selection, Input>>
        ) => PromiseWithError<Selected<ProjectionOf<Output>, Selection, Output>, Error>
    : { [Key in keyof Router]: Router[Key] extends AnyNestedClient ? SearchRouterClient<Router[Key]> : never };

type PreviousData<Output> = {
  placeholderData?: Output | ((...args: Parameters<PlaceholderDataFunction>) => Output | undefined);
};
type QueryInput<Context extends object, Input, Output, Error, Selected, Initial> = Omit<
  QueryOptionsIn<Context, Input, Output, Error, Selected, Initial>,
  "placeholderData"
> &
  PreviousData<Output>;
type InfiniteInput<Context extends object, Input, Output, Error, Selected, Param, Initial> = Omit<
  InfiniteOptionsIn<Context, Input, Output, Error, Selected, Param, Initial>,
  "placeholderData"
> &
  PreviousData<InfiniteData<Output, Param>>;
type Replaced = "queryKey" | "queryOptions" | "infiniteKey" | "infiniteOptions" | "liveKey" | "liveOptions";
type FiniteUtils<Context extends object, Input, Output, Error, Projection extends SearchProjector> = Omit<
  RouterUtils<Client<Context, Input, Output, Error>>,
  Replaced
> & {
  queryKey<const Selection extends Input>(options: {
    input: (Selection & ExactSearchInput<Selection, Input>) | SkipToken;
    queryKey?: QueryKey;
  }): DataTag<QueryKey, SearchProjection<Projection, Selection>, Error>;
  queryOptions<const Selection extends Input, Selected = SearchProjection<Projection, Selection>, Initial = undefined>(
    options: { input: Selection | SkipToken } & QueryInput<
      Context,
      NoInfer<Selection & ExactSearchInput<Selection, Input>>,
      NoInfer<SearchProjection<Projection, Selection>>,
      Error,
      Selected,
      Initial
    >,
  ): NoInfer<QueryOptionsOut<SearchProjection<Projection, Selection>, Error, Selected, Initial>>;
  infiniteKey<const Selection extends Input, Param>(options: {
    input: ((param: Param) => Selection & ExactSearchInput<Selection, Input>) | SkipToken;
    initialPageParam: Param;
    queryKey?: QueryKey;
  }): DataTag<QueryKey, InfiniteData<SearchProjection<Projection, Selection>, Param>, Error>;
  infiniteOptions<
    const Selection extends Input,
    Param,
    Selected = InfiniteData<SearchProjection<Projection, Selection>, Param>,
    Initial = undefined,
  >(
    options: { input: ((param: Param) => Selection) | SkipToken } & InfiniteInput<
      Context,
      NoInfer<Selection & ExactSearchInput<Selection, Input>>,
      NoInfer<SearchProjection<Projection, Selection>>,
      Error,
      Selected,
      Param,
      Initial
    >,
  ): NoInfer<InfiniteOptionsOut<SearchProjection<Projection, Selection>, Error, Selected, Param, Initial>>;
};
type LiveUtils<Context extends object, Input, Output, Error, Projection extends SearchProjector> = Omit<
  RouterUtils<Client<Context, Input, Output, Error>>,
  Replaced
> & {
  liveKey<const Selection extends Input>(options: {
    input: (Selection & ExactSearchInput<Selection, Input>) | SkipToken;
    queryKey?: QueryKey;
  }): DataTag<QueryKey, SearchProjection<Projection, Selection>, Error>;
  liveOptions<const Selection extends Input, Selected = SearchProjection<Projection, Selection>, Initial = undefined>(
    options: { input: Selection | SkipToken } & QueryInput<
      Context,
      NoInfer<Selection & ExactSearchInput<Selection, Input>>,
      NoInfer<SearchProjection<Projection, Selection>>,
      Error,
      Selected,
      Initial
    >,
  ): NoInfer<QueryOptionsOut<SearchProjection<Projection, Selection>, Error, Selected, Initial>>;
};

/** Native option aliases specialized only for descriptor-bearing procedures.
 * Reconstructing utilities directly upstream still has fixed-output inference. */
export type SearchRouterUtils<Router extends AnyNestedClient> =
  Router extends Client<infer Context, infer Input, infer Output, infer Error>
    ? [ProjectionOf<Output>] extends [never]
      ? RouterUtils<Router>
      : Output extends AsyncIterable<unknown>
        ? LiveUtils<Context, Input, Output, Error, ProjectionOf<Output>>
        : FiniteUtils<Context, Input, Output, Error, ProjectionOf<Output>>
    : { [Key in keyof Router]: Router[Key] extends AnyNestedClient ? SearchRouterUtils<Router[Key]> : never } & Pick<
        RouterUtils<Router>,
        "key"
      >;
