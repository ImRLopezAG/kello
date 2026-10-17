import assert from "node:assert/strict";
import { test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import * as v from "valibot";

// Execute the shipped publication guard, without invoking GitHub or npm.
test("publication requires successful exact-revision Neon acceptance", async () => {
  const workflow = v.parse(
    v.object({
      jobs: v.object({
        publish: v.object({
          steps: v.array(
            v.object({
              name: v.optional(v.string()),
              run: v.optional(v.string()),
            }),
          ),
        }),
      }),
    }),
    Bun.YAML.parse(await readFile(new URL("../../../.github/workflows/release.yml", import.meta.url), "utf8")),
  );
  const script = workflow.jobs.publish.steps.find(
    (step) => step.name === "Require Neon acceptance for this exact commit",
  )?.run;
  assert(script, "Publication has no exact-revision cloud acceptance guard");
  const root = await mkdtemp(`${tmpdir()}/kello-release-gate-`);
  try {
    const executable = `${root}/gh`;
    await writeFile(
      executable,
      `#!/usr/bin/env bun
import assert from "node:assert/strict";
const args = process.argv.slice(2);
assert.deepEqual(args.slice(0, 2), ["run", "list"]);
for (const [flag, value] of [["--workflow", "cloud-acceptance.yml"], ["--commit", process.env.EXPECTED_COMMIT], ["--event", "workflow_dispatch"]]) {
  assert.equal(args[args.indexOf(flag) + 1], value);
}
if (process.env.CLOUD_RESULT === "api-error") process.exit(1);
console.log(process.env.CLOUD_RESULT);
`,
    );
    await chmod(executable, 0o700);
    const cwd = fileURLToPath(new URL("../../../", import.meta.url));
    const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd });
    assert.equal(head.exitCode, 0);
    for (const [result, expected] of [
      ["true", 0],
      ["false", 1],
      ["", 1],
      ["api-error", 1],
    ] as const) {
      const child: Bun.Subprocess<"ignore", "pipe", "pipe"> = Bun.spawn(
        ["bash", "-e", "-o", "pipefail", "-c", script],
        {
          cwd,
          env: {
            ...process.env,
            PATH: `${root}:${process.env.PATH}`,
            GITHUB_REPOSITORY: "ImRLopezAG/kello",
            EXPECTED_COMMIT: head.stdout.toString().trim(),
            CLOUD_RESULT: result,
          },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          timeout: 10000,
        },
      );
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      assert.equal(code, expected, `${result}: ${stdout} ${stderr}`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
