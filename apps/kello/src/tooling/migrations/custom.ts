import { parse } from "libpg-query";
import type { SchemaDefinition } from "kello/server";
import { createSnapshot, snapshotHash } from "./adapter";
import type { MigrationSnapshot } from "./adapter";
import { classifyMigration } from "./classifier";
import type { MigrationSafety } from "./classifier";
import { migrationHash } from "./planner";
import type { MigrationPlan } from "./planner";

export type MigrationMode = "transactional" | "nontransactional";

// This is an execution contract, not a SQL sandbox. Reviewed SQL runs with the migration identity.
const supported = new Set([
  "InsertStmt",
  "UpdateStmt",
  "DeleteStmt",
  "MergeStmt",
  "SelectStmt",
  "CreateStmt",
  "AlterTableStmt",
  "IndexStmt",
  "DropStmt",
  "RenameStmt",
  "CreateSchemaStmt",
  "CreateSeqStmt",
  "AlterSeqStmt",
  "CreateFunctionStmt",
  "CreateTrigStmt",
  "ViewStmt",
  "CreatePolicyStmt",
  "AlterPolicyStmt",
  "CommentStmt",
  "TruncateStmt",
  "RuleStmt",
  "CompositeTypeStmt",
  "CreateEnumStmt",
  "AlterEnumStmt",
  "CreateDomainStmt",
  "AlterDomainStmt",
  "RefreshMatViewStmt",
  "ReindexStmt",
  "VacuumStmt",
  "ClusterStmt",
]);

/** PostgreSQL byte offsets preserve semicolons inside strings, comments and function bodies. */
export async function customStatements(sql: string, mode: MigrationMode): Promise<readonly string[]> {
  const result = await parse(sql);
  const raw = result.stmts ?? [];
  if (!raw.length) throw new Error("Custom migration requires SQL statements");
  const bytes = Buffer.from(sql);
  return raw.map((statement) => {
    const node = statement.stmt;
    const keys = Object.keys(node ?? {});
    if (!node || keys.length !== 1 || !supported.has(keys[0] ?? "")) {
      throw new Error(
        "Custom migration contains an unsupported statement; transaction and session control belong to Kello",
      );
    }
    const nontransactional =
      ("IndexStmt" in node && node.IndexStmt.concurrent) ||
      ("DropStmt" in node && node.DropStmt.concurrent) ||
      ("VacuumStmt" in node && node.VacuumStmt.is_vacuumcmd) ||
      "ClusterStmt" in node ||
      "ReindexStmt" in node;
    if (mode === "transactional" && nontransactional)
      throw new Error("Custom SQL requires explicit nontransactional mode");
    const start = statement.stmt_location ?? 0;
    const length = statement.stmt_len ?? 0;
    return bytes
      .subarray(start, length ? start + length : bytes.length)
      .toString("utf8")
      .trim();
  });
}

export async function customSafety(
  before: MigrationSnapshot,
  after: MigrationSnapshot,
  mode: MigrationMode,
): Promise<MigrationSafety> {
  const structural = await classifyMigration(before, after);
  return {
    automatic: false,
    transactional: mode === "transactional",
    issues: [
      ...structural.issues,
      { entity: "custom-sql", reason: "review-required" },
      ...(mode === "nontransactional" ? [{ entity: "custom-sql", reason: "nontransactional" } as const] : []),
    ],
  };
}

export async function planCustomMigration(
  before: MigrationSnapshot,
  schema: SchemaDefinition,
  sql: string,
  mode: MigrationMode,
  parent: string | null,
): Promise<MigrationPlan> {
  const after = await createSnapshot(schema, before);
  const statements = await customStatements(sql, mode);
  const content = {
    format: 2,
    kind: "custom",
    parent,
    before: snapshotHash(before),
    after: snapshotHash(after),
    baseline: before,
    snapshot: after,
    statements,
    renames: [],
    safety: await customSafety(before, after, mode),
  } as const;
  return { ...content, hash: migrationHash(content) };
}
