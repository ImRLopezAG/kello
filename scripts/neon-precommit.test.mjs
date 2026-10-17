import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const gate = new URL("./neon-precommit.mjs", import.meta.url).pathname;
const installer = new URL("./install-git-hooks.mjs", import.meta.url).pathname;

function fixture(work) {
  const root = mkdtempSync(join(tmpdir(), "kello-hook-test-"));
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  try {
    git("init", "--quiet");
    mkdirSync(join(root, "packages/e2e"), { recursive: true });
    mkdirSync(join(root, "bin"));
    writeFileSync(join(root, "source.txt"), "staged\n");
    git("add", "source.txt");
    writeFileSync(
      join(root, "bin/bun"),
      `#!/bin/sh
printf '%s\\n' "$*" >> "$HOOK_TEST_LOG"
if [ "$1" = "./cloud/run.ts" ]; then printf '%s\\n' "$LOOM_CLOUD_SUITE" >> "$HOOK_TEST_ROOT/suites.log"; fi
if [ "$HOOK_TEST_FAIL" = "$*" ]; then exit 1; fi
if [ "$HOOK_TEST_DRIFT" = 1 ]; then printf changed > "$HOOK_TEST_ROOT/source.txt"; fi
`,
      { mode: 0o755 },
    );
    const env = {
      ...process.env,
      PATH: `${join(root, "bin")}:${process.env.PATH}`,
      NEON_API_KEY: "test-double-only",
      KELLO_CLOUD_PROJECT_ID: "late-moon-69483649",
      LOOM_CLOUD_BRANCH_ID: "br-test",
      HOOK_TEST_LOG: join(root, "commands.log"),
      HOOK_TEST_ROOT: root,
      HOOK_TEST_FAIL: "",
      HOOK_TEST_DRIFT: "",
    };
    work({ root, git, env, run: () => spawnSync(process.execPath, [gate], { cwd: root, env, encoding: "utf8" }) });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

await test("missing target blocks before any workload", () =>
  fixture(({ env, run }) => {
    env.KELLO_CLOUD_PROJECT_ID = "";
    const result = run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /KELLO_CLOUD_PROJECT_ID is required/);
  }));

await test("unstaged changes block before testing", () =>
  fixture(({ root, run }) => {
    writeFileSync(join(root, "source.txt"), "unstaged");
    assert.equal(run().status, 1);
  }));

await test("untracked source cannot affect staged verification", () =>
  fixture(({ root, run }) => {
    writeFileSync(join(root, "packages/untracked.ts"), "export {};");
    assert.equal(run().status, 1);
  }));

await test("runs build, hosted auth/RPC, actual SDK and mounted browser in order", () =>
  fixture(({ root, env, run }) => {
    assert.equal(run().status, 0);
    assert.deepEqual(readFileSync(env.HOOK_TEST_LOG, "utf8").trim().split("\n"), [
      "run --cwd apps/kello build",
      "./cloud/run.ts",
      "fixtures/neon-realtime-smoke.ts",
      "fixtures/live-functions-neon.ts --verify",
      "fixtures/cloud-bundle-smoke.ts",
      "fixtures/cloud-jobs-smoke.ts",
      "fixtures/cloud-storage-smoke.ts",
      "test cloud/dev-component-watch.test.ts",
    ]);
    assert.deepEqual(readFileSync(join(root, "suites.log"), "utf8").trim().split("\n"), ["tasks"]);
  }));

await test("first failed provider suite blocks and stops later commands", () =>
  fixture(({ env, run }) => {
    env.HOOK_TEST_FAIL = "./cloud/run.ts";
    assert.equal(run().status, 1);
    assert.equal(readFileSync(env.HOOK_TEST_LOG, "utf8").trim().split("\n").length, 2);
  }));

await test("source changes during testing invalidate success", () =>
  fixture(({ env, run }) => {
    env.HOOK_TEST_DRIFT = "1";
    assert.equal(run().status, 1);
  }));

await test("installer enables versioned hooks", () =>
  fixture(({ root, env }) => {
    const result = spawnSync(process.execPath, [installer], { cwd: root, env: { ...env, CI: "" } });
    assert.equal(result.status, 0);
    const configured = spawnSync("git", ["config", "--get", "core.hooksPath"], { cwd: root, encoding: "utf8" });
    assert.equal(configured.stdout.trim(), ".githooks");
  }));

await test("installer preserves another hooks configuration", () =>
  fixture(({ root, git, env }) => {
    git("config", "core.hooksPath", "other-hooks");
    const result = spawnSync(process.execPath, [installer], { cwd: root, env: { ...env, CI: "" } });
    assert.equal(result.status, 1);
    const configured = spawnSync("git", ["config", "--get", "core.hooksPath"], { cwd: root, encoding: "utf8" });
    assert.equal(configured.stdout.trim(), "other-hooks");
  }));

await test("authenticated CLI profile does not require an API key", () =>
  fixture(({ env, run }) => {
    delete env.NEON_API_KEY;
    assert.equal(run().status, 0);
  }));
