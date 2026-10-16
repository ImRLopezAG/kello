import type { MigrationStatus } from "../../migrations/status";

/** Only an authenticated framework prefix permits bootstrap of acknowledged metadata. */
export function releaseHistoryNeedsRecovery(
  status: Pick<MigrationStatus, "initialized" | "consistent" | "issues" | "framework">,
  metadataAcknowledged: boolean,
): boolean {
  if (status.framework.state === "diverged") return true;
  if (status.issues.some((issue) => issue !== "FRAMEWORK_UPGRADE_REQUIRED")) return true;
  if (status.framework.state === "upgrade-required") return !status.initialized;
  if (status.issues.length) return true;
  return metadataAcknowledged && (!status.initialized || !status.consistent || status.framework.state !== "current");
}
