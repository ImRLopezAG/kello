import type { InvocationIdentity } from "../server/auth/context";
import type { SQL } from "drizzle-orm";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type {
  AnyRelations,
  BuildQueryResult,
  FindTargetTableInRelationalConfig,
  GetTableViewFieldSelection,
  TableRelationalConfig,
  AnyRelation,
  AnyOne,
  RelationResultKind,
} from "drizzle-orm";

/** All search work is bounded by server-owned budgets. */
export interface SearchBudgets {
  /** Maximum roots per finite page or per live display page (default 100). */
  readonly pageSize: number;
  /** Maximum rows in each selected child array (default 100). */
  readonly nestedSize: number;
  /** Maximum live display pages recomputed in one snapshot (default 10). */
  readonly loadedPages: number;
  /** Maximum filter operators, including nested Boolean and relation predicates. */
  readonly predicates: number;
  /** Maximum values in a membership list. */
  readonly listSize: number;
  /** Maximum characters in an explicit literal text operator. */
  readonly textLength: number;
  /** Maximum serialized selection bytes, checked before SQL execution. */
  readonly inputBytes: number;
  /** Maximum wire-encoded publication bytes; exhaustion throws QUERY_BUDGET_EXCEEDED. */
  readonly resultBytes: number;
  /** Maximum root plus nested rows in one publication; never silently truncates. */
  readonly rows: number;
  /** Lifetime of encrypted, branch-keyed cursors in seconds. */
  readonly cursorSeconds: number;
  /** FTS-only server budgets; absent on legacy descriptors. */
  readonly fullTextQueryBytes?: number;
  readonly fullTextQueryNodes?: number;
  readonly fullTextTimeoutMs?: number;
}
/** Authorization receives the native table alias used in this SQL invocation. */
export interface SearchScope<Table extends TableRelationalConfig, Graph extends AnyRelations = Record<never, never>> {
  /** Stable authorization policy name included in the cursor binding. */
  readonly name: string;
  /** Change when authorization semantics change to invalidate earlier cursors. */
  readonly version: string;
  /** Complete graph-local policy reads; omit when unknown, use [] for no additional reads. */
  readonly dependencies?: readonly (keyof Graph & string)[];
  readonly where: (context: { readonly table: Table["table"]; readonly identity: InvocationIdentity | null }) => SQL;
}
type FieldName<Table extends TableRelationalConfig> = keyof GetTableViewFieldSelection<Table["table"]> & string;
type Model<Graph extends AnyRelations, Table extends TableRelationalConfig> = BuildQueryResult<Graph, Table, true>;
type Orderable<Model> = {
  [Key in keyof Model]: NonNullable<Model[Key]> extends string | number | bigint | Date ? Key : never;
}[keyof Model] &
  string;
type Textual<Table extends TableRelationalConfig> = {
  [Key in FieldName<Table>]: GetTableViewFieldSelection<Table["table"]>[Key] extends {
    readonly _: { readonly dataType: "string" | "string enum" };
  }
    ? Key
    : never;
}[FieldName<Table>];
type TableDocuments<Table extends TableRelationalConfig> = Table["table"] extends {
  readonly _: { readonly fullText?: infer Documents };
}
  ? NonNullable<Documents>
  : never;
type DocumentName<Table extends TableRelationalConfig> = [TableDocuments<Table>] extends [never]
  ? never
  : keyof TableDocuments<Table> & string;
/** Registration checks all declared document sources against both explicit grants. */
export type FullTextPolicyCheck<Table extends TableRelationalConfig, Policy> = Policy extends {
  readonly fullText: readonly (infer Name extends string)[];
}
  ? Exclude<Name, DocumentName<Table>> extends never
    ? {
        [Key in Name]: Key extends keyof TableDocuments<Table>
          ? TableDocuments<Table>[Key] extends {
              readonly fields: readonly { readonly field: infer Source extends string }[];
            }
            ? Exclude<Source, Capability<Policy, "filter"> & Capability<Policy, "text">> extends never
              ? never
              : Key
            : Key
          : Key;
      }[Name] extends never
      ? unknown
      : never
    : never
  : unknown;
/** Projection, filtering, ordering and text matching are independent permissions.
 * Every root, child and M2M junction declares its server authorization scope. */
export type SearchPolicy<
  Graph extends AnyRelations,
  Table extends TableRelationalConfig,
  Root extends boolean = true,
> = {
  readonly columns: readonly FieldName<Table>[];
  readonly filter?: readonly Exclude<FieldName<Table>, "AND" | "OR" | "NOT" | "relations">[];
  readonly order?: readonly Orderable<Model<Graph, Table>>[];
  readonly text?: readonly Textual<Table>[];
  readonly fullText?: Root extends true ? readonly [DocumentName<Table>, ...DocumentName<Table>[]] : never;
  readonly scope: "public" | SearchScope<Table, Graph>;
  readonly through?: { readonly [Name in keyof Graph]?: "public" | SearchScope<Graph[Name], Graph> };
  readonly budgets?: Partial<SearchBudgets>;
  readonly relations?: {
    readonly [Name in keyof Table["relations"]]?: SearchPolicy<
      Graph,
      FindTargetTableInRelationalConfig<Graph, Table["relations"][Name]>,
      false
    >;
  };
};
type Capability<Policy, Name extends string> = Policy extends { [Key in Name]: readonly (infer Field extends string)[] }
  ? Field
  : never;
type ScalarFilter<Value> = {
  readonly eq?: NonNullable<Value>;
  readonly ne?: NonNullable<Value>;
  readonly in?: readonly NonNullable<Value>[];
  readonly notIn?: readonly NonNullable<Value>[];
} & (null extends Value ? { readonly isNull?: boolean } : object) &
  (NonNullable<Value> extends string | number | bigint | Date
    ? {
        readonly gt?: NonNullable<Value>;
        readonly gte?: NonNullable<Value>;
        readonly lt?: NonNullable<Value>;
        readonly lte?: NonNullable<Value>;
      }
    : object);
export type SearchFilter<Graph extends AnyRelations, Table extends TableRelationalConfig, Policy> = {
  readonly [Name in Extract<Capability<Policy, "filter">, keyof Model<Graph, Table>>]?: ScalarFilter<
    Model<Graph, Table>[Name]
  > &
    (Name extends Capability<Policy, "text">
      ? {
          readonly contains?: string;
          readonly startsWith?: string;
          readonly endsWith?: string;
          readonly insensitive?: boolean;
        }
      : object);
} & {
  readonly AND?: readonly SearchFilter<Graph, Table, Policy>[];
  readonly OR?: readonly SearchFilter<Graph, Table, Policy>[];
  readonly NOT?: SearchFilter<Graph, Table, Policy>;
  readonly relations?: Policy extends { relations: infer Policies }
    ? {
        readonly [
          Name in keyof Policies & keyof Table["relations"]
        ]?: Table["relations"][Name]["relationType"] extends "many"
          ? {
              readonly some?: SearchFilter<
                Graph,
                FindTargetTableInRelationalConfig<Graph, Table["relations"][Name]>,
                Policies[Name]
              >;
              readonly none?: SearchFilter<
                Graph,
                FindTargetTableInRelationalConfig<Graph, Table["relations"][Name]>,
                Policies[Name]
              >;
            }
          : {
              readonly is?: SearchFilter<
                Graph,
                FindTargetTableInRelationalConfig<Graph, Table["relations"][Name]>,
                Policies[Name]
              >;
              readonly isNot?: SearchFilter<
                Graph,
                FindTargetTableInRelationalConfig<Graph, Table["relations"][Name]>,
                Policies[Name]
              >;
            };
      }
    : never;
};
/** Nested arrays use bounded limits; paginate a child endpoint for child cursors. */
export type SearchNestedSelection<Graph extends AnyRelations, Table extends TableRelationalConfig, Policy> = {
  readonly columns?: Policy extends { columns: readonly (infer Column extends string)[] }
    ? { readonly [Name in Column]?: boolean }
    : never;
  readonly where?: SearchFilter<Graph, Table, Policy>;
  readonly orderBy?: readonly {
    readonly field: Capability<Policy, "order">;
    readonly direction: "asc" | "desc";
    readonly nulls?: "first" | "last";
  }[];
  readonly with?: Policy extends { relations: infer Relations }
    ? {
        readonly [Name in keyof Relations & keyof Table["relations"]]?: SearchNestedSelection<
          Graph,
          FindTargetTableInRelationalConfig<Graph, Table["relations"][Name]>,
          Relations[Name]
        >;
      }
    : never;
  readonly limit?: number;
};
type RootMatching<Policy> = [Capability<Policy, "fullText">] extends [never]
  ? { readonly fullText?: never }
  :
      | { readonly fullText?: never }
      | {
          readonly fullText: { readonly document: Capability<Policy, "fullText">; readonly query: string };
          readonly orderBy?: never;
        };
/** One finite root page. Order priority is an array, never object key order. */
export type SearchSelection<
  Graph extends AnyRelations,
  Table extends TableRelationalConfig,
  Policy,
> = SearchNestedSelection<Graph, Table, Policy> &
  RootMatching<Policy> & {
    readonly cursor?: string | null;
    readonly direction?: "forward" | "backward";
    readonly count?: boolean;
  };
/** A coherent live loaded window, with a contract-specific anchor. */
export type SearchLiveSelection<
  Graph extends AnyRelations,
  Table extends TableRelationalConfig,
  Policy,
> = SearchNestedSelection<Graph, Table, Policy> &
  RootMatching<Policy> & {
    readonly anchor?: string | null;
    readonly loadedPages?: number;
    readonly count?: boolean;
  };

type AllowedColumns<Policy> = Policy extends { columns: readonly (infer Key extends string)[] } ? Key : never;
type DefiniteKeys<Columns, Value> = {
  [Key in keyof Columns]-?: [Columns[Key]] extends [Value] ? Key : never;
}[keyof Columns];
type PossibleKeys<Columns, Value> = {
  [Key in keyof Columns]-?: Value extends Columns[Key] ? Key : never;
}[keyof Columns];
type GuaranteedColumns<Policy, Columns> = [DefiniteKeys<Columns, true>] extends [never]
  ? [PossibleKeys<Columns, true>] extends [never]
    ? Exclude<AllowedColumns<Policy>, PossibleKeys<Columns, false>>
    : never
  : Extract<AllowedColumns<Policy>, DefiniteKeys<Columns, true>>;
type PossibleColumns<Policy, Columns> = [DefiniteKeys<Columns, true>] extends [never]
  ? Exclude<AllowedColumns<Policy>, DefiniteKeys<Columns, false>>
  : Extract<AllowedColumns<Policy>, PossibleKeys<Columns, true>>;
type ColumnsOf<Input> = Input[Extract<"columns", keyof Input>];
type RequiredColumns<Policy, Input> = "columns" extends keyof Input
  ? [NonNullable<ColumnsOf<Input>>] extends [never]
    ? AllowedColumns<Policy>
    : GuaranteedColumns<Policy, NonNullable<ColumnsOf<Input>>>
  : AllowedColumns<Policy>;
type AvailableColumns<Policy, Input> = "columns" extends keyof Input
  ? undefined extends ColumnsOf<Input>
    ? AllowedColumns<Policy>
    : PossibleColumns<Policy, NonNullable<ColumnsOf<Input>>>
  : AllowedColumns<Policy>;
type ProjectedColumns<Model, Policy, Input> = {
  [Key in Extract<RequiredColumns<Policy, Input>, keyof Model>]: Model[Key];
} & {
  [Key in Extract<Exclude<AvailableColumns<Policy, Input>, RequiredColumns<Policy, Input>>, keyof Model>]?: Model[Key];
};
type RelationRow<
  Graph extends AnyRelations,
  Table extends TableRelationalConfig,
  Policy,
  Name extends keyof Table["relations"],
  Input,
> = Policy extends { relations: infer Policies }
  ? Name extends keyof Policies
    ? Table["relations"][Name] extends infer Relation extends AnyRelation
      ?
          | RelationResultKind<
              SearchRow<Graph, FindTargetTableInRelationalConfig<Graph, Relation>, Policies[Name], NonNullable<Input>>,
              Input,
              Relation
            >
          | (Relation extends AnyOne
              ? Policies[Name] extends { scope: "public" }
                ? "where" extends keyof NonNullable<Input>
                  ? null
                  : never
                : null
              : never)
      : never
    : never
  : never;
type SelectedRelations<Graph extends AnyRelations, Table extends TableRelationalConfig, Policy, With> = {
  [Name in keyof With & keyof Table["relations"] as undefined extends With[Name] ? never : Name]: RelationRow<
    Graph,
    Table,
    Policy,
    Name,
    With[Name]
  >;
} & {
  [Name in keyof With & keyof Table["relations"] as undefined extends With[Name] ? Name : never]?: RelationRow<
    Graph,
    Table,
    Policy,
    Name,
    With[Name]
  >;
};
type WithOf<Input> = Input[Extract<"with", keyof Input>];
type ProjectedRelations<
  Graph extends AnyRelations,
  Table extends TableRelationalConfig,
  Policy,
  Input,
> = "with" extends keyof Input
  ? undefined extends WithOf<Input>
    ? {
        [Name in keyof NonNullable<WithOf<Input>> & keyof Table["relations"]]?: RelationRow<
          Graph,
          Table,
          Policy,
          Name,
          NonNullable<WithOf<Input>>[Name]
        >;
      }
    : SelectedRelations<Graph, Table, Policy, NonNullable<WithOf<Input>>>
  : object;

/** Native Drizzle scalars and relation cardinality with the contract's field
 * mask. Literal selections are exact; uncertain fields remain optional and
 * unions stay unions, including at each nested relation. */
export type SearchRow<
  Graph extends AnyRelations,
  Table extends TableRelationalConfig,
  Policy,
  Input,
> = Input extends unknown
  ? {
      [
        Key in keyof (ProjectedColumns<BuildQueryResult<Graph, Table, true>, Policy, Input> &
          ProjectedRelations<Graph, Table, Policy, Input>)
      ]: (ProjectedColumns<BuildQueryResult<Graph, Table, true>, Policy, Input> &
        ProjectedRelations<Graph, Table, Policy, Input>)[Key];
    }
  : never;

/** One finite page. Boundary values remain opaque; refreshing starts a new
 * traversal snapshot. Counts are exact decimal strings when requested. */
export interface SearchPage<Row> {
  readonly rows: Row[];
  readonly nextCursor: string | null;
  readonly previousCursor: string | null;
  readonly count?: string;
}

/** Each live event replaces every loaded page from one read snapshot. */
export interface SearchWindow<Row> {
  readonly pages: Row[][];
  readonly nextCursor: string | null;
  readonly previousCursor: string | null;
  readonly count?: string;
}

/** Type-level projection retained by generated native client declarations. */
export interface SearchProjector<Input = unknown> {
  readonly selection: Input;
  readonly input: unknown;
  readonly output: object;
}
export type SearchProjection<Projection extends SearchProjector, Input> = (Projection & {
  readonly input: Input;
})["output"];
export interface SchemaSearchProjector<
  Graph extends AnyRelations,
  Table extends TableRelationalConfig,
  Policy,
> extends SearchProjector<SearchSelection<Graph, Table, Policy>> {
  readonly output: SearchPage<SearchRow<Graph, Table, Policy, this["input"]>>;
}

export interface SchemaLiveSearchProjector<
  Graph extends AnyRelations,
  Table extends TableRelationalConfig,
  Policy,
> extends SearchProjector<SearchLiveSelection<Graph, Table, Policy>> {
  readonly output: SearchWindow<SearchRow<Graph, Table, Policy, this["input"]>>;
}

declare const searchProjection: unique symbol;
declare const searchInvocationInput: unique symbol;

/** Validated handler input retains its contract's projection without a runtime property. */
export type SearchInvocationInput<Projection extends SearchProjector> = Projection["selection"] & {
  readonly [searchInvocationInput]?: Projection;
};
export type InferSearchInputProjector<Input> = typeof searchInvocationInput extends keyof Input
  ? NonNullable<Input[typeof searchInvocationInput]> extends infer Projection extends SearchProjector
    ? Projection
    : never
  : never;
/** Phantom type identity; this property is never present in wire results. */
export type SearchWire<Projection extends SearchProjector> = ("pages" extends keyof Projection["output"]
  ? { readonly pages: object[][] }
  : { readonly rows: object[] }) & {
  readonly nextCursor: string | null;
  readonly previousCursor: string | null;
  readonly count?: string;
  readonly [searchProjection]?: Projection;
};
export type InferSearchProjector<Output> = typeof searchProjection extends keyof Output
  ? NonNullable<Output[typeof searchProjection]> extends infer Projection extends SearchProjector
    ? Projection
    : never
  : never;

/** Matching Standard Schema instances used by native oRPC input/output chaining. */
export interface SearchDescriptor<Projection extends SearchProjector, Output = SearchWire<Projection>> {
  readonly input: StandardSchemaV1<SearchInvocationInput<Projection>>;
  readonly output: StandardSchemaV1<Output>;
}

/** Deep excess-key checks also apply to predeclared selections and spreads. */
export type ExactSearchInput<Input, Contract> = Input extends readonly unknown[]
  ? Contract extends readonly (infer Element)[]
    ? { [Index in keyof Input]: ExactSearchInput<Input[Index], NonNullable<Element>> }
    : never
  : Input extends object
    ? {
        [Key in keyof Input]: Key extends keyof Contract
          ? ExactSearchInput<Input[Key], NonNullable<Contract[Key]>>
          : never;
      }
    : Input;
