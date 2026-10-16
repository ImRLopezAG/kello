import { assessMigration } from "../../../apps/kello/src/tooling/migrations/assessment";
import type { MigrationAssessment, BlockingGinOperation } from "../../../apps/kello/src/tooling/migrations/assessment";
import type { MigrationPlan } from "../../../apps/kello/src/tooling/migrations/planner";
import type { ApplyMigrationsOptions } from "../../../apps/kello/src/tooling/migrations/runner";

declare const plan: MigrationPlan;
const assessed: Promise<MigrationAssessment> = assessMigration(plan);
declare const result: Awaited<typeof assessed>;
const hash: string = result.artifactHash;
const operations: readonly BlockingGinOperation[] = result.blockingGinOperations;
if (result.blockingGinTimeout.eligible) {
  // @ts-expect-error eligible assessments have no rejection reason
  void result.blockingGinTimeout.reason;
} else {
  const reason: string = result.blockingGinTimeout.reason;
  void reason;
}
// @ts-expect-error callers cannot mutate returned evidence
result.artifactHash = "changed";
// @ts-expect-error the operation list is readonly
result.blockingGinOperations.push({ id: "a", schema: "app", table: "tasks", index: "search", kind: "create" });
// @ts-expect-error operation identity is readonly
result.blockingGinOperations[0]!.index = "changed";
// @ts-expect-error only create/replace are evidence kinds
const invalid: BlockingGinOperation = { id: "a", schema: "app", table: "tasks", index: "search", kind: "drop" };
// @ts-expect-error serialized assessment is not an artifact accepted for execution assessment
void assessMigration(result);
const apply: ApplyMigrationsOptions = {
  connectionString: "postgresql://localhost/disposable",
  root: ".",
  migrations: "migrations",
  namespace: "app",
  runtimeRole: "runtime",
  reviewedHashes: [hash],
  blockingGinTimeouts: [{ artifactHash: hash, statementTimeoutMs: 120_000 }],
};
void [operations, invalid, apply];
