import { expect, test } from "vite-plus/test";
import { classifyFrameworkHistory } from "../../../apps/kello-cli/src/tooling/migrations/framework-history";
import { releaseHistoryNeedsRecovery } from "../../../apps/kello-cli/src/tooling/deploy/neon/history-readiness";

const expected = [
  { version: 1, hash: "first" },
  { version: 2, hash: "second" },
  { version: 3, hash: "third" },
] as const;
const existing = { metadataExists: true, frameworkHistoryExists: true, migrationHistoryExists: true, expected };

test("framework history authenticates the entire ordered prefix and returns its suffix", () => {
  expect(classifyFrameworkHistory({ ...existing, applied: expected })).toEqual({
    state: "current",
    appliedVersion: 3,
    pending: [],
  });
  expect(classifyFrameworkHistory({ ...existing, applied: expected.slice(0, 2) })).toEqual({
    state: "upgrade-required",
    appliedVersion: 2,
    pending: expected.slice(2),
  });
  expect(classifyFrameworkHistory({ ...existing, metadataExists: false, applied: [] })).toEqual({
    state: "fresh",
    appliedVersion: 0,
    pending: expected,
  });
});

test.each([
  ["empty-ledger", []],
  ["gap-or-unsupported-version", [expected[0], expected[2]]],
  ["gap-or-unsupported-version", [expected[0], expected[0]]],
  ["gap-or-unsupported-version", [expected[1], expected[0]]],
  ["gap-or-unsupported-version", [...expected, { version: 4, hash: "newer" }]],
  ["hash-mismatch", [{ version: 1, hash: "changed" }]],
] as const)("framework history refuses %s rather than treating it as an upgrade", (reason, applied) => {
  expect(classifyFrameworkHistory({ ...existing, applied })).toEqual({ state: "diverged", reason });
});

test("an existing incomplete metadata installation cannot authenticate a prefix", () => {
  expect(classifyFrameworkHistory({ ...existing, applied: expected, frameworkHistoryExists: false })).toEqual({
    state: "diverged",
    reason: "unversioned",
  });
  expect(
    classifyFrameworkHistory({ ...existing, applied: expected.slice(0, 2), migrationHistoryExists: false }),
  ).toEqual({
    state: "diverged",
    reason: "missing-migration-history",
  });
});

test("release readiness permits an authenticated prefix even after metadata acknowledgement", () => {
  const prefix = {
    initialized: true,
    consistent: false,
    issues: ["FRAMEWORK_UPGRADE_REQUIRED" as const],
    framework: classifyFrameworkHistory({ ...existing, applied: expected.slice(0, 2) }),
  };
  expect(releaseHistoryNeedsRecovery(prefix, false)).toBe(false);
  expect(releaseHistoryNeedsRecovery(prefix, true)).toBe(false);
  for (const issue of ["HISTORY_DIVERGED", "ORM_HISTORY_DIVERGED", "LIVE_DRIFT"] as const)
    expect(releaseHistoryNeedsRecovery({ ...prefix, issues: [...prefix.issues, issue] }, true)).toBe(true);
  expect(releaseHistoryNeedsRecovery({ ...prefix, initialized: false }, true)).toBe(true);
  expect(
    releaseHistoryNeedsRecovery({ ...prefix, framework: { state: "diverged", reason: "hash-mismatch" } }, false),
  ).toBe(true);
  expect(releaseHistoryNeedsRecovery({ ...prefix, issues: ["FRAMEWORK_HISTORY_DIVERGED"] }, false)).toBe(true);
});
