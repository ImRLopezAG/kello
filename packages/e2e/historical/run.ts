import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as v from "valibot";

export const historicalCommit = "b8ddb6a9d7bb398f8e2993ae6cafe7710ba1dafc";

/** Archive a fixed historical runtime; only the acceptance harness is overlaid. */
export async function runHistoricalAcceptance(env: NodeJS.ProcessEnv, receipt: string) {
  const projectId = v.parse(v.pipe(v.string(), v.minLength(1)), env.KELLO_CLOUD_PROJECT_ID);
  const branchId = v.parse(v.pipe(v.string(), v.minLength(1)), env.LOOM_CLOUD_BRANCH_ID);
  const root = await mkdtemp(join(tmpdir(), "loom-historical-"));
  const repository = fileURLToPath(new URL("../../../", import.meta.url));
  const fixtures = fileURLToPath(new URL("./", import.meta.url));
  try {
    const archive = join(root, "source.tar");
    await promisify(execFile)("git", ["archive", historicalCommit, "--output", archive], { cwd: repository });
    await promisify(execFile)("tar", ["xf", archive, "-C", root]);
    await rm(archive);
    for (const [source, target] of [
      ["baseline-live.test.ts.fixture", "cloud/baseline-live.test.ts"],
      ["cloud-baseline-browser.ts.fixture", "fixtures/cloud-baseline-browser.ts"],
      ["cloud-live-services.ts.fixture", "fixtures/cloud-live-services.ts"],
      ["cloud-issuer.ts.fixture", "fixtures/cloud-issuer.ts"],
    ] as const)
      await cp(join(fixtures, source), join(root, "packages/e2e", target));
    // Build tooling needs no provider credentials. Frozen pins are the historical baseline.
    const buildEnv = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR };
    for (const args of [
      ["install", "--frozen-lockfile"],
      ["run", "build"],
    ]) {
      const child = Bun.spawn(["bun", ...args], { cwd: root, env: buildEnv, stdout: "pipe", stderr: "pipe" });
      const [_out, _error, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      assert.equal(code, 0, "Historical frozen build failed");
    }
    await rm(receipt, { force: true });
    const child = Bun.spawn(["bun", "test", "packages/e2e/cloud/baseline-live.test.ts"], {
      cwd: root,
      env: { ...env, LOOM_CLOUD_LIVE: "1", LOOM_CLOUD_RECEIPT: receipt },
      stdout: "inherit",
      stderr: "inherit",
    });
    assert.equal(await child.exited, 0, "Historical hosted fixture failed");
    return v.parse(
      v.object({
        projectId: v.literal(projectId),
        branchId: v.literal(branchId),
        version: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
        passed: v.literal(true),
      }),
      JSON.parse(await readFile(receipt, "utf8")),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
