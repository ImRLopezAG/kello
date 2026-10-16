import { expect, test } from "vite-plus/test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../../../scripts/rate-limits-maintenance.ts", import.meta.url));
const failure = { status: "RATE_LIMIT_CLEANUP_FAILED" };

function invoke(args: string[], credential?: string) {
  const env = { ...process.env };
  delete env.LOOM_MIGRATION_DATABASE_URL;
  // A runtime credential must never substitute for the operator secret.
  env.LOOM_DATABASE_URL = "postgresql://runtime:do-not-print@127.0.0.1/runtime";
  if (credential !== undefined) env.LOOM_MIGRATION_DATABASE_URL = credential;
  return spawnSync("bun", [script, ...args], { env, encoding: "utf8", timeout: 5000 });
}

test("missing owner credential produces one fixed JSON failure without runtime fallback", () => {
  const result = invoke(["--metadata-namespace", "loom_u3_cleanup_unit"]);
  expect(result.status).toBe(1);
  expect(result.stderr).toBe("");
  expect(result.stdout).toBe(JSON.stringify(failure) + "\n");
});

test.each([
  [],
  ["--metadata-namespace", ""],
  ["--metadata-namespace", "loom_bad;sql"],
  ["--metadata-namespace", "loom_u3_cleanup_unit", "--unknown", "1"],
  ["--metadata-namespace", "loom_u3_cleanup_unit", "--metadata-namespace", "loom_duplicate"],
  ...["0", "-1", "1.5", "1e2", "0x10", " 1", "501", "NaN", "Infinity"].map((value) => [
    "--metadata-namespace",
    "loom_u3_cleanup_unit",
    "--batch-size",
    value,
  ]),
  ["--metadata-namespace", "loom_u3_cleanup_unit", "--max-batches", "21"],
  ["--metadata-namespace", "loom_u3_cleanup_unit", "--max-duration-ms", "30001"],
  ["--metadata-namespace", "loom_u3_cleanup_unit", "--batch-size"],
])("invalid arguments fail with only the allowlisted status: %j", (...args) => {
  const result = invoke(args, "postgresql://owner:SECRET_NEVER_PRINT@invalid.invalid/db");
  expect(result.status).toBe(1);
  expect(result.stderr).toBe("");
  expect(result.stdout).toBe(JSON.stringify(failure) + "\n");
});

test("malformed owner URL is redacted before loading built tooling", () => {
  const result = invoke(["--metadata-namespace", "loom_u3_cleanup_unit"], "SECRET_NOT_A_URL");
  expect(result.status).toBe(1);
  expect(result.stderr).toBe("");
  expect(result.stdout).toBe(JSON.stringify(failure) + "\n");
});
