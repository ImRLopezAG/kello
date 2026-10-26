export interface FrameworkHistoryEntry {
  readonly version: number;
  readonly hash: string;
}

export type FrameworkReadiness =
  | { readonly state: "fresh"; readonly appliedVersion: 0; readonly pending: readonly FrameworkHistoryEntry[] }
  | {
      readonly state: "current" | "upgrade-required";
      readonly appliedVersion: number;
      readonly pending: readonly FrameworkHistoryEntry[];
    }
  | {
      readonly state: "diverged";
      readonly reason:
        | "unversioned"
        | "missing-migration-history"
        | "empty-ledger"
        | "gap-or-unsupported-version"
        | "hash-mismatch";
    };

/** Only an exact, nonempty ordered ledger prefix authenticates an existing installation. */
export function classifyFrameworkHistory(input: {
  readonly metadataExists: boolean;
  readonly frameworkHistoryExists: boolean;
  readonly migrationHistoryExists: boolean;
  readonly applied: readonly FrameworkHistoryEntry[];
  readonly expected: readonly FrameworkHistoryEntry[];
}): FrameworkReadiness {
  const suffix = (start: number) => input.expected.slice(start).map(({ version, hash }) => ({ version, hash }));
  if (!input.metadataExists) return { state: "fresh", appliedVersion: 0, pending: suffix(0) };
  if (!input.frameworkHistoryExists) return { state: "diverged", reason: "unversioned" };
  if (!input.migrationHistoryExists) return { state: "diverged", reason: "missing-migration-history" };
  if (!input.applied.length) return { state: "diverged", reason: "empty-ledger" };
  for (const [index, row] of input.applied.entries()) {
    const expected = input.expected[index];
    if (!expected || row.version !== expected.version)
      return { state: "diverged", reason: "gap-or-unsupported-version" };
    if (row.hash !== expected.hash) return { state: "diverged", reason: "hash-mismatch" };
  }
  return {
    state: input.applied.length === input.expected.length ? "current" : "upgrade-required",
    appliedVersion: input.applied[input.applied.length - 1]!.version,
    pending: suffix(input.applied.length),
  };
}
