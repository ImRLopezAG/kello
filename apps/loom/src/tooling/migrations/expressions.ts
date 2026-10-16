import { parse } from "libpg-query";
import * as v from "valibot";
import type { MigrationSnapshot } from "./adapter";

const expressionNode = v.record(v.string(), v.unknown());
type ExpressionNode = v.InferOutput<typeof expressionNode>;
const stringNode = v.strictObject({ String: v.strictObject({ sval: v.string() }) });
const constant = v.strictObject({ A_Const: v.strictObject({ sval: v.strictObject({ sval: v.string() }) }) });
const cast = v.strictObject({
  TypeCast: v.strictObject({
    arg: constant,
    typeName: v.strictObject({ names: v.array(stringNode), typemod: v.literal(-1) }),
  }),
});
const weightedVector = v.strictObject({
  FuncCall: v.strictObject({
    funcname: v.strictTuple([v.strictObject({ String: v.strictObject({ sval: v.literal("setweight") }) })]),
    funcformat: v.literal("COERCE_EXPLICIT_CALL"),
    args: v.strictTuple([
      v.strictObject({
        FuncCall: v.strictObject({
          funcname: v.strictTuple([v.strictObject({ String: v.strictObject({ sval: v.literal("to_tsvector") }) })]),
          funcformat: v.literal("COERCE_EXPLICIT_CALL"),
          args: v.strictTuple([
            cast,
            v.strictObject({
              CoalesceExpr: v.strictObject({
                args: v.strictTuple([
                  v.strictObject({ ColumnRef: v.strictObject({ fields: v.strictTuple([stringNode]) }) }),
                  v.union([constant, cast]),
                ]),
              }),
            }),
          ]),
        }),
      }),
      cast,
    ]),
  }),
});

export function withoutLocations(tree: Awaited<ReturnType<typeof parse>>): string {
  return JSON.stringify(tree, <Value>(key: string, value: Value) =>
    ["location", "stmt_location", "stmt_len", "list_start", "list_end"].includes(key) ? undefined : value,
  );
}

function isType(node: v.InferOutput<typeof cast>, type: string): boolean {
  return node.TypeCast.typeName.names.length === 1 && node.TypeCast.typeName.names[0]?.String.sval === type;
}

/** Only PG's deparsed spelling of the bounded weighted text-document vocabulary is canonicalized. */
export async function fullTextExpression(expression: string, catalogDeparsed: boolean): Promise<string | null> {
  const tree = v.safeParse(
    v.strictObject({
      version: v.number(),
      stmts: v.strictTuple([
        v.strictObject({
          stmt: v.strictObject({
            SelectStmt: v.strictObject({
              targetList: v.strictTuple([v.strictObject({ ResTarget: v.strictObject({ val: expressionNode }) })]),
              limitOption: v.literal("LIMIT_OPTION_DEFAULT"),
              op: v.literal("SETOP_NONE"),
            }),
          }),
        }),
      ]),
    }),
    JSON.parse(withoutLocations(await parse(`SELECT ${expression}`))),
  );
  if (!tree.success) return null;
  const root = tree.output.stmts[0].stmt.SelectStmt.targetList[0].ResTarget.val;
  function vector(node: ExpressionNode): string | null {
    const result = v.safeParse(weightedVector, node);
    if (!result.success) return null;
    const [document, weight] = result.output.FuncCall.args;
    const [config, coalesce] = document.FuncCall.args;
    const language = config.TypeCast.arg.A_Const.sval.sval;
    const configurations = catalogDeparsed
      ? ["simple", "english", "pg_catalog.simple", "pg_catalog.english"]
      : ["pg_catalog.simple", "pg_catalog.english"];
    if (!isType(config, "regconfig") || !configurations.includes(language)) return null;
    if (!isType(weight, "char") || !["A", "B", "C", "D"].includes(weight.TypeCast.arg.A_Const.sval.sval)) return null;
    const [field, fallback] = coalesce.CoalesceExpr.args;
    const empty = "TypeCast" in fallback ? fallback.TypeCast.arg : fallback;
    if (("TypeCast" in fallback && !isType(fallback, "text")) || empty.A_Const.sval.sval !== "") return null;
    const identifier = field.ColumnRef.fields[0].String.sval.replaceAll('"', '""');
    return `setweight(to_tsvector('pg_catalog.${language.replace(/^pg_catalog\./, "")}'::regconfig, coalesce("${identifier}", '')), '${weight.TypeCast.arg.A_Const.sval.sval}'::"char")`;
  }
  function document(node: ExpressionNode): string | null {
    const part = vector(node);
    if (part) return part;
    const concatenation = v.safeParse(
      v.strictObject({
        A_Expr: v.strictObject({
          kind: v.literal("AEXPR_OP"),
          name: v.strictTuple([v.strictObject({ String: v.strictObject({ sval: v.literal("||") }) })]),
          lexpr: expressionNode,
          rexpr: expressionNode,
        }),
      }),
      node,
    );
    if (!concatenation.success) return null;
    const left = document(concatenation.output.A_Expr.lexpr);
    const right = document(concatenation.output.A_Expr.rexpr);
    return left && right ? `(${left} || ${right})` : null;
  }
  return document(root);
}

/** Canonical catalog spelling; generated artifacts retain their native authoring spelling. */
export async function normalizeFullTextIndexes(
  snapshot: MigrationSnapshot,
  catalogDeparsed = false,
): Promise<MigrationSnapshot> {
  const ddl = await Promise.all(
    snapshot.ddl.map(async (entity) => {
      if (entity.entityType !== "indexes" || entity.method !== "gin") return entity;
      const columns = await Promise.all(
        entity.columns.map(async (column) => {
          if (!column.isExpression) return column;
          const value = await fullTextExpression(column.value, catalogDeparsed);
          return value ? { ...column, value } : column;
        }),
      );
      return { ...entity, columns };
    }),
  );
  return { ...snapshot, ddl };
}

/** Preserve the baseline spelling only for proved-equivalent weighted GIN expressions.
 * This is generation alignment, deliberately excluded from historical safety classification.
 */
export async function alignFullTextIndexes(
  current: MigrationSnapshot,
  previous: MigrationSnapshot,
): Promise<MigrationSnapshot> {
  const indexes = previous.ddl
    .filter((entity) => entity.entityType === "indexes")
    .filter((index) => index.method === "gin");
  const ddl = await Promise.all(
    current.ddl.map(async (entity) => {
      if (entity.entityType !== "indexes" || entity.method !== "gin") return entity;
      const baseline = indexes.find(
        (index) => index.schema === entity.schema && index.table === entity.table && index.name === entity.name,
      );
      if (!baseline) return entity;
      const columns = await Promise.all(
        entity.columns.map(async (column, position) => {
          const prior = baseline.columns[position];
          if (!column.isExpression || !prior?.isExpression || column.value === prior.value) return column;
          const value = await fullTextExpression(column.value, false);
          return value && value === (await fullTextExpression(prior.value, false))
            ? { ...column, value: prior.value }
            : column;
        }),
      );
      return { ...entity, columns };
    }),
  );
  return { ...current, ddl };
}

async function expressionIdentity(expression: string): Promise<string> {
  const tree = await parse(`SELECT ${expression}`);
  // PostgreSQL's parser preserves identifiers, literal values and casts. Only source offsets vary.
  return withoutLocations(tree);
}

/** Align only parser-identical CHECK expressions before invoking Drizzle's diff. */
export async function alignCheckExpressions(
  before: MigrationSnapshot,
  after: MigrationSnapshot,
): Promise<MigrationSnapshot> {
  const checks = after.ddl.filter((entity) => entity.entityType === "checks");
  const ddl = await Promise.all(
    before.ddl.map(async (entity) => {
      if (entity.entityType !== "checks") return entity;
      const target = checks.find(
        (check) => check.schema === entity.schema && check.table === entity.table && check.name === entity.name,
      );
      if (!target || target.value === entity.value) return entity;
      return (await expressionIdentity(entity.value)) === (await expressionIdentity(target.value))
        ? { ...entity, value: target.value }
        : entity;
    }),
  );
  return { ...before, ddl };
}
