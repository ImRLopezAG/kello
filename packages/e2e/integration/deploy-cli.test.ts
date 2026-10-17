import assert from "node:assert/strict";
import { test } from "bun:test";
import { mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cases: [string[], number, string][] = [
  [["deploy"], 5, "DEPLOYMENT_FAILED"],
  [["deploy", "--release", "release.json", "--name", "ignored"], 2, "USAGE"],
  [["init", "--name", "unwanted", "--release", "release.json"], 2, "USAGE"],
  [["deploy", "preview", "--release", "release.json"], 2, "USAGE"],
  [["deploy", "", "ignored", "--release", "release.json"], 2, "USAGE"],
  [["deploy", "--release", "release.json", "--dry-run"], 5, "DEPLOYMENT_FAILED"],
  [["migrations", "apply", "--runtime-role", "runtime", "--dry-run"], 2, "USAGE"],
  [["deploy", "--release", "release.json"], 5, "DEPLOYMENT_FAILED"],
  [["retire", "database"], 2, "USAGE"],
  [["retire", "--retirement", "release.json"], 2, "USAGE"],
  [["retire", "database", "--retirement", "release.json", "--dry-run"], 2, "USAGE"],
  [["init", "--name", "unwanted", "--retirement", "release.json"], 2, "USAGE"],
  [["retire", "database", "--retirement", "release.json"], 5, "RETIREMENT_FAILED"],
];

test.each(cases)("deployment CLI rejects %j with %i/%s and redacts release contents", async (args, code, error) => {
  const root = await mkdtemp(join(tmpdir(), "loom-deploy-cli-"));
  const cli = fileURLToPath(new URL("../../../apps/kello/src/cli.ts", import.meta.url));
  async function run(args: string[], code: number, error: string) {
    const child = Bun.spawn([process.execPath, cli, ...args, "--cwd", root, "--json"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    assert.equal(exit, code);
    assert.equal(stdout, "");
    assert.ok(stderr.includes(`"code":"${error}"`));
    assert.ok(!stderr.includes("sensitive-fixture-value"));
  }
  try {
    await writeFile(join(root, "release.json"), '{"activationToken":"sensitive-fixture-value"}');
    await run(args, code, error);
    assert.deepEqual(
      (await readdir(root)).filter((name) => name !== ".kello"),
      ["release.json"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
