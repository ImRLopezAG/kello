import assert from "node:assert/strict";
import { test } from "bun:test";
import { mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("branch provisioning CLI rejects unrelated options and redacts invalid declarations", async () => {
  const root = await mkdtemp(join(tmpdir(), "loom-provision-cli-"));
  const cli = fileURLToPath(new URL("../../../apps/kello-cli/src/cli.ts", import.meta.url));
  async function run(args: string[], code: number, error: string) {
    const child = Bun.spawn([process.execPath, cli, ...args, "--cwd", root, "--json"], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 5000,
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
    await writeFile(join(root, "branch.json"), '{"apiKey":"sensitive-fixture-value"}');
    await run(["provision", "--branch", "branch.json"], 5, "PROVISIONING_FAILED");
    await run(["provision", "--branch", "branch.json", "--dry-run"], 5, "PROVISIONING_FAILED");
    await run(["provision"], 2, "USAGE");
    await run(["provision", "--branch", "branch.json", "--name", "ignored"], 2, "USAGE");
    await run(["provision", "--branch", "branch.json", "--release", "ignored"], 2, "USAGE");
    await run(["init", "--name", "unwanted", "--branch", "branch.json"], 2, "USAGE");
    await run(["provision", "preview", "--branch", "branch.json"], 2, "USAGE");
    await run(["provision", "", "ignored", "--branch", "branch.json"], 2, "USAGE");
    assert.deepEqual(await readdir(root), ["branch.json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 45_000);
