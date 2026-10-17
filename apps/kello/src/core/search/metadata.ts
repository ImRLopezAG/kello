import { getAsyncIteratorObjectSchemaDetails } from "@orpc/contract";
import type { AnySchema, AnyProcedureContract } from "@orpc/contract";
import type { AnyRelations, TableRelationalConfig, SQL } from "drizzle-orm";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { InvocationIdentity } from "../server/auth/context";
import type { SearchPublicNode } from "./public";
import type { CompiledFullText } from "../schema/full-text";
import type { SearchBudgets } from "./types";
import * as v from "valibot";

/** Shared private semantics for public capability hashes and ranked cursor binding. */
export const fullTextSemantics = Object.freeze({
  parser: "plain-v1",
  rank: "ts_rank_cd",
  normalization: 32,
  weights: Object.freeze([0.1, 0.2, 0.4, 1]),
  codec: "float4-bits-v1",
  order: "rank-desc-id-asc",
});

type SearchInputIssueCode = "INVALID_SELECTION" | "QUERY_BUDGET_EXCEEDED";
const inputIssueCodes = new WeakMap<readonly StandardSchemaV1.Issue[], SearchInputIssueCode>();

/** Internal authority is the exact native issues array, never a serialized marker. */
export function createSearchInputIssues(code: SearchInputIssueCode): readonly StandardSchemaV1.Issue[] {
  const issues = [{ message: "Invalid search input" }];
  inputIssueCodes.set(issues, code);
  return issues;
}

/** Internal RPC seam; copied or third-party issues carry no search authority. */
export function searchInputIssueCode(issues: readonly StandardSchemaV1.Issue[]) {
  return inputIssueCodes.get(issues);
}

export interface RuntimeSearchScope {
  readonly name: string;
  readonly version: string;
  readonly where: (context: {
    readonly table: TableRelationalConfig["table"];
    readonly identity: InvocationIdentity | null;
  }) => SQL;
}
export interface SearchRuntimeNode {
  readonly entity: string;
  /** Granted schema-owned documents, never serialized into browser metadata. */
  readonly fullText?: CompiledFullText;
  readonly public: SearchPublicNode;
  readonly scope: "public" | RuntimeSearchScope;
  readonly through: Readonly<Record<string, "public" | RuntimeSearchScope>>;
  readonly relations: Readonly<Record<string, SearchRuntimeNode>>;
}
/** Private server identity shared by a descriptor's matching schemas. */
export interface SearchRuntimeDescriptor {
  readonly id: symbol;
  readonly entity: string;
  readonly graph: AnyRelations;
  readonly schemaFingerprint: string;
  readonly fingerprint: string;
  readonly node: SearchRuntimeNode;
  readonly budgets: SearchBudgets;
  readonly mode: "finite";
}
interface SearchSchemaMetadata {
  readonly descriptor: SearchRuntimeDescriptor;
  readonly role: "input" | "output";
}
const key = Symbol.for("kello.search.descriptor.v1");
const metadataParser = v.custom<SearchSchemaMetadata>((value) =>
  v.is(
    v.object({
      role: v.picklist(["input", "output"]),
      descriptor: v.object({
        id: v.symbol(),
        entity: v.string(),
        graph: v.object({}),
        schemaFingerprint: v.string(),
        fingerprint: v.string(),
        node: v.object({}),
        budgets: v.object({}),
        mode: v.literal("finite"),
      }),
    }),
    value,
  ),
);
export function attachSearchMetadata(
  schema: StandardSchemaV1,
  descriptor: SearchRuntimeDescriptor,
  role: SearchSchemaMetadata["role"],
) {
  Object.defineProperty(schema, key, { value: Object.freeze({ descriptor, role }) });
}
export function searchSchemaMetadata(schema: AnySchema | undefined) {
  if (!schema || !(key in schema)) return undefined;
  return v.parse(metadataParser, schema[key]);
}
/** Resolve native iterator schemas without inspecting third-party validator ASTs. */
export function searchContractDescriptor(
  procedure: Pick<AnyProcedureContract, "~orpc">,
): SearchRuntimeDescriptor | undefined {
  const inputs = procedure["~orpc"].inputSchemas ?? [];
  const outputs = procedure["~orpc"].outputSchemas ?? [];
  const inputMetadata = inputs.map(searchSchemaMetadata).filter((value) => value !== undefined);
  const outputMetadata = outputs.map((schema) => {
    const iterator = getAsyncIteratorObjectSchemaDetails(schema);
    return { metadata: searchSchemaMetadata(iterator?.yieldSchema ?? schema), streaming: iterator !== undefined };
  });
  if (!inputMetadata.length && !outputMetadata.some(({ metadata }) => metadata)) return undefined;
  const input = inputMetadata[0];
  const output = outputMetadata[0];
  if (
    inputs.length !== 1 ||
    outputs.length !== 1 ||
    inputMetadata.length !== 1 ||
    !input ||
    !output?.metadata ||
    input.role !== "input" ||
    output.metadata.role !== "output" ||
    input.descriptor !== output.metadata.descriptor ||
    output.streaming
  )
    throw new Error("Search contract requires matching input/output descriptor identity and mode");
  return input.descriptor;
}
