import { isDeepStrictEqual } from "node:util";
import { parse, type Node } from "libpg-query";
import type { MigrationSnapshot } from "./adapter";
import type { MigrationSafety, MigrationIssue } from "./classifier";
import { fullTextExpression, withoutLocations } from "./expressions";
import { validateMigration } from "./history";
import type { MigrationPlan } from "./planner";

export interface BlockingGinOperation {
  readonly id: string;
  readonly schema: string;
  readonly table: string;
  readonly index: string;
  readonly kind: "create" | "replace";
}
export interface MigrationAssessment {
  readonly artifactHash: string;
  readonly safety: MigrationSafety;
  readonly blockingGinOperations: readonly BlockingGinOperation[];
  readonly blockingGinTimeout: { readonly eligible: true } | { readonly eligible: false; readonly reason: string };
}
type Entity = MigrationSnapshot["ddl"][number];
type Index = Extract<Entity, { entityType: "indexes" }>;
function identity(entity: Entity): string {
  return JSON.stringify([
    entity.entityType,
    "schema" in entity ? entity.schema : null,
    "table" in entity ? entity.table : null,
    entity.name,
  ]);
}
function physical(entity: Entity) {
  return { ...entity, nameExplicit: undefined };
}
function quote(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}
async function bounded(index: Index, snapshot: MigrationSnapshot): Promise<boolean> {
  if (index.concurrently || index.isUnique || index.where !== null || index.with !== "" || index.columns.length !== 1)
    return false;
  const column = index.columns[0];
  if (!column || !column.isExpression || !column.asc || column.nullsFirst || column.opclass !== null) return false;
  let expression;
  try {
    expression = await fullTextExpression(column.value, false);
  } catch {
    return false;
  }
  if (!expression) return false;
  // Every referenced field must belong to this exact physical relation and be scalar text.
  const tree = await parse(`SELECT ${expression}`);
  let valid = snapshot.ddl.some(
    (entity) => entity.entityType === "tables" && entity.schema === index.schema && entity.name === index.table,
  );
  const sources: string[] = [];
  const configurations: string[] = [];
  // The strict parser above proves the vocabulary; extract only its concatenations and weighted vectors.
  function document(node: Node): void {
    if ("A_Expr" in node) {
      const { lexpr, rexpr } = node.A_Expr;
      if (!lexpr || !rexpr) {
        valid = false;
        return;
      }
      document(lexpr);
      document(rexpr);
      return;
    }
    const vector = "FuncCall" in node ? node.FuncCall.args?.[0] : undefined;
    const config = vector && "FuncCall" in vector ? vector.FuncCall.args?.[0] : undefined;
    const coalesce = vector && "FuncCall" in vector ? vector.FuncCall.args?.[1] : undefined;
    const field = coalesce && "CoalesceExpr" in coalesce ? coalesce.CoalesceExpr.args?.[0] : undefined;
    const name = field && "ColumnRef" in field ? field.ColumnRef.fields?.[0] : undefined;
    const language = config && "TypeCast" in config ? config.TypeCast.arg : undefined;
    if (!name || !("String" in name) || !language || !("A_Const" in language) || !language.A_Const.sval) {
      valid = false;
      return;
    }
    const source = name.String.sval;
    const configuration = language.A_Const.sval.sval;
    if (source === undefined || configuration === undefined) {
      valid = false;
      return;
    }
    sources.push(source);
    configurations.push(configuration);
    valid &&= snapshot.ddl.some(
      (entity) =>
        entity.entityType === "columns" &&
        entity.schema === index.schema &&
        entity.table === index.table &&
        entity.name === source &&
        entity.type === "text" &&
        entity.typeSchema === null &&
        entity.dimensions === 0,
    );
  }
  const statement = tree.stmts?.[0]?.stmt;
  const target = statement && "SelectStmt" in statement ? statement.SelectStmt.targetList?.[0] : undefined;
  const root = target && "ResTarget" in target ? target.ResTarget.val : undefined;
  if (!root) return false;
  document(root);
  return (
    valid &&
    sources.length >= 1 &&
    sources.length <= 8 &&
    new Set(sources).size === sources.length &&
    configurations.length === sources.length &&
    new Set(configurations).size === 1
  );
}

/** Current admission is derived from a private validated copy; historical format-2 content is untouched. */
export async function assessMigration(input: MigrationPlan): Promise<MigrationAssessment> {
  const plan = structuredClone(input);
  await validateMigration(plan);
  const before = new Map(plan.baseline.ddl.map((entity) => [identity(entity), entity]));
  const after = new Map(plan.snapshot.ddl.map((entity) => [identity(entity), entity]));
  const changed = new Set(
    [...before.keys(), ...after.keys()].filter(
      (key) =>
        !isDeepStrictEqual(before.get(key) && physical(before.get(key)!), after.get(key) && physical(after.get(key)!)),
    ),
  );
  const operations: BlockingGinOperation[] = [];
  const issues: MigrationIssue[] = [...plan.safety.issues];
  const expected: unknown[] = [];
  const recognition = new Map<Index, { readonly recognized: boolean; readonly create: unknown }>();
  async function recognize(index: Index): Promise<{ readonly recognized: boolean; readonly create: unknown }> {
    const cached = recognition.get(index);
    if (cached) return cached;
    const recognized = await bounded(index, plan.snapshot);
    const result = {
      recognized,
      create: recognized
        ? JSON.parse(
            withoutLocations(
              await parse(
                `CREATE INDEX ${quote(index.name)} ON ${quote(index.schema)}.${quote(index.table)} USING gin ((${index.columns[0]!.value}));`,
              ),
            ),
          )
        : undefined,
    };
    recognition.set(index, result);
    return result;
  }
  const ambiguous = [plan.baseline, plan.snapshot].some((snapshot) => {
    const identities = snapshot.ddl.map(identity);
    const indexes = snapshot.ddl
      .filter((entity) => entity.entityType === "indexes")
      .map((index) => JSON.stringify([index.schema, index.name]));
    return new Set(identities).size !== identities.length || new Set(indexes).size !== indexes.length;
  });
  let eligible = !ambiguous && plan.safety.transactional && changed.size > 0 && plan.renames.length === 0;
  const addReview = (entity: string) => {
    if (!issues.some((issue) => issue.entity === entity && issue.reason === "review-required"))
      issues.push({ entity, reason: "review-required" });
  };
  if (ambiguous) addReview("ambiguous-snapshot-identities");
  for (const key of changed) {
    const entity = after.get(key);
    if (!entity || entity.entityType !== "indexes" || entity.method !== "gin") {
      eligible = false;
      continue;
    }
    if (entity.concurrently) throw new Error("Concurrent GIN migrations are unsupported");
    const result = await recognize(entity);
    const old = before.get(key);
    const existingTable = plan.baseline.ddl.some(
      (table) => table.entityType === "tables" && table.schema === entity.schema && table.name === entity.table,
    );
    if (existingTable || !result.recognized) addReview(key);
    const kind = old ? "replace" : "create";
    if (existingTable)
      operations.push({
        id: JSON.stringify([entity.schema, entity.table, entity.name, kind]),
        schema: entity.schema,
        table: entity.table,
        index: entity.name,
        kind,
      });
    if (!result.recognized) {
      eligible = false;
      continue;
    }
    if (!existingTable) {
      eligible = false;
      expected.push(result.create);
      continue;
    }
    if (old)
      expected.push(
        JSON.parse(withoutLocations(await parse(`DROP INDEX ${quote(entity.schema)}.${quote(entity.name)};`))),
      );
    expected.push(result.create);
  }
  const unmatched = [...expected];
  for (const statement of plan.statements) {
    let tree;
    try {
      tree = await parse(statement);
    } catch {
      eligible = false;
      addReview("unsupported-sql");
      continue;
    }
    const normalized: unknown = JSON.parse(withoutLocations(tree));
    const nodes = tree.stmts ?? [];
    for (const node of nodes) {
      const index = node.stmt && "IndexStmt" in node.stmt ? node.stmt.IndexStmt : undefined;
      const drop = node.stmt && "DropStmt" in node.stmt ? node.stmt.DropStmt : undefined;
      if (drop?.removeType === "OBJECT_INDEX") {
        for (const object of drop.objects ?? []) {
          if (!("List" in object)) continue;
          const names = object.List.items?.map((item) => ("String" in item ? item.String.sval : null));
          const indexes = plan.baseline.ddl.filter(
            (entity) =>
              entity.entityType === "indexes" &&
              entity.method === "gin" &&
              (names?.length === 1
                ? entity.name === names[0]
                : entity.schema === names?.[0] && entity.name === names?.[1]),
          );
          if (indexes.length) {
            if (drop.concurrent) throw new Error("Concurrent GIN migrations are unsupported");
            if (indexes.length !== 1 || names?.length !== 2 || indexes.some((index) => !changed.has(identity(index))))
              addReview("unsupported-gin-sql");
          }
        }
      }
      if (index?.accessMethod === "gin") {
        if (index.concurrent) throw new Error("Concurrent GIN migrations are unsupported");
        const target = plan.snapshot.ddl.find(
          (entity) =>
            entity.entityType === "indexes" &&
            entity.method === "gin" &&
            entity.name === index.idxname &&
            entity.schema === index.relation?.schemaname &&
            entity.table === index.relation?.relname,
        );
        const result =
          target?.entityType === "indexes" && changed.has(identity(target)) ? await recognize(target) : undefined;
        if (!target || target.entityType !== "indexes" || !changed.has(identity(target)) || !result?.recognized)
          addReview("unsupported-gin-sql");
        else if (!isDeepStrictEqual(normalized, result.create)) addReview("unsupported-gin-sql");
      }
    }
    const match = unmatched.findIndex((candidate) => isDeepStrictEqual(candidate, normalized));
    if (match < 0) eligible = false;
    else unmatched.splice(match, 1);
  }
  if (unmatched.length) addReview("unsupported-gin-sql");
  eligible &&= operations.length > 0 && unmatched.length === 0 && plan.statements.length === expected.length;
  // A missing or mismatched SQL operation cannot turn existing-table GIN into an approval.
  return {
    artifactHash: plan.hash,
    safety: { automatic: issues.length === 0, transactional: plan.safety.transactional, issues },
    blockingGinOperations: operations.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    blockingGinTimeout: eligible
      ? { eligible: true }
      : {
          eligible: false,
          reason:
            "Requires exclusively matched bounded existing-table blocking GIN creation/replacement SQL and structural changes",
        },
  };
}
