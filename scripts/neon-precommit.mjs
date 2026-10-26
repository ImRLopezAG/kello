import { spawnSync } from "node:child_process";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} failed; commit blocked.`);
  }
  return result.stdout?.toString().trim();
}

function stagedTree() {
  const diff = spawnSync("git", ["diff", "--quiet"], { stdio: "inherit" });
  if (diff.error || diff.status !== 0) {
    throw new Error("Stage all tracked changes before Neon verification; commit blocked.");
  }
  const untracked = run(
    "git",
    ["ls-files", "--others", "--exclude-standard", "--", "apps", "packages", "scripts", ".githooks"],
    { stdio: "pipe" },
  );
  if (untracked) throw new Error("Stage or remove untracked source files before Neon verification.");
  return run("git", ["write-tree"], { stdio: "pipe" });
}

try {
  const tree = stagedTree();
  for (const name of ["KELLO_CLOUD_PROJECT_ID", "LOOM_CLOUD_BRANCH_ID"]) {
    if (!process.env[name]?.trim()) throw new Error(`${name} is required; commit blocked.`);
  }
  if (process.env.KELLO_CLOUD_PROJECT_ID !== "late-moon-69483649") {
    throw new Error("Use the admitted disposable Neon acceptance project.");
  }
  // Existing Neon tooling accepts an API key or the authenticated Neon CLI profile.
  // Existing fixtures validate disposable targets and own their resource cleanup.
  run("bun", ["run", "--cwd", "apps/kello", "build"]);
  run("bun", ["run", "--cwd", "apps/kello-cli", "build"]);
  run("bun", ["./cloud/run.ts"], {
    cwd: "packages/e2e",
    env: { ...process.env, LOOM_CLOUD_SUITE: "tasks", LOOM_CLOUD_SETUP_AUTH: "1" },
  });
  run("bun", ["fixtures/neon-realtime-smoke.ts"], { cwd: "packages/e2e" });
  run("bun", ["fixtures/live-functions-neon.ts", "--verify"], { cwd: "packages/e2e" });
  for (const fixture of ["cloud-bundle-smoke", "cloud-jobs-smoke", "cloud-storage-smoke"]) {
    run("bun", [`fixtures/${fixture}.ts`], { cwd: "packages/e2e" });
  }
  run("bun", ["test", "cloud/dev-component-watch.test.ts"], {
    cwd: "packages/e2e",
    env: { ...process.env, LOOM_CLOUD_DEV_COMPONENT_WATCH: "1" },
  });
  if (stagedTree() !== tree) throw new Error("The index changed during Neon verification; commit blocked.");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
