import assert from "node:assert/strict";
import { test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import * as v from "valibot";

test("CLI bootstrap skips only an identical published CI artifact and fails closed", async () => {
  const workflow = v.parse(
    v.object({
      jobs: v.object({
        publish: v.object({ steps: v.array(v.object({ name: v.optional(v.string()), run: v.optional(v.string()) })) }),
      }),
    }),
    Bun.YAML.parse(await readFile(new URL("../../../.github/workflows/release.yml", import.meta.url), "utf8")),
  );
  const script = workflow.jobs.publish.steps.find((step) => step.name === "Check CLI bootstrap artifact")?.run;
  assert(script, "The first CLI publication must not bypass artifact verification or be published twice");
  const root = await mkdtemp(`${tmpdir()}/kello-cli-bootstrap-`);
  const cwd = fileURLToPath(new URL("../../../", import.meta.url));
  try {
    await writeFile(`${root}/kello-cli.tgz`, "verified CLI bytes");
    await writeFile(
      `${root}/registry.mjs`,
      `
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
const {version} = JSON.parse(readFileSync('apps/kello-cli/package.json', 'utf8'));
const scenario = process.env.SCENARIO;
globalThis.fetch = async (url) => {
  assert.equal(new URL(url).origin, 'https://registry.npmjs.org');
  if (scenario === 'offline') throw new Error('offline');
  if (scenario === 'server-error') return new Response('', {status:503});
  if (String(url).endsWith('/dist-tags')) return Response.json({alpha: scenario === 'wrong-tag' ? '0.0.0' : version});
  if (String(url).endsWith('.tgz')) return new Response(scenario === 'changed-bytes' ? 'changed' : 'verified CLI bytes');
  if (scenario === 'absent') return new Response('', {status:404});
  return Response.json({name:'kello-cli', version:scenario === 'wrong-version' ? '0.0.0' : version,
    dist:{integrity:scenario === 'wrong-integrity' ? 'sha512-invalid' : 'sha512-'+createHash('sha512').update('verified CLI bytes').digest('base64')}});
};
`,
    );
    for (const scenario of [
      "absent",
      "identical",
      "changed-bytes",
      "wrong-version",
      "wrong-integrity",
      "wrong-tag",
      "server-error",
      "offline",
    ]) {
      const output = `${root}/output`;
      await writeFile(output, "");
      const child: Bun.Subprocess<"ignore", "pipe", "pipe"> = Bun.spawn(
        ["bash", "-e", "-o", "pipefail", "-c", script],
        {
          cwd,
          env: {
            ...process.env,
            ARTIFACT_DIR: root,
            GITHUB_OUTPUT: output,
            SCENARIO: scenario,
            NODE_OPTIONS: `--import=${root}/registry.mjs`,
          },
          stdout: "pipe",
          stderr: "pipe",
          stdin: "ignore",
          timeout: 10000,
        },
      );
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      const valid = scenario === "absent" || scenario === "identical";
      assert.equal(code === 0, valid, `${scenario}: ${stdout} ${stderr}`);
      assert.equal(await readFile(output, "utf8"), valid ? `published=${scenario === "identical"}\n` : "");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("publication verifies the CI tarball identity and rejects changed bytes", async () => {
  const workflow = v.parse(
    v.object({
      jobs: v.object({
        publish: v.object({ steps: v.array(v.object({ name: v.optional(v.string()), run: v.optional(v.string()) })) }),
      }),
    }),
    Bun.YAML.parse(await readFile(new URL("../../../.github/workflows/release.yml", import.meta.url), "utf8")),
  );
  const script = workflow.jobs.publish.steps.find((step) => step.name === "Verify CI package artifact")?.run;
  assert(script, "Publication rebuilds instead of validating the CI package artifact");
  const cwd = fileURLToPath(new URL("../../../", import.meta.url));
  const pkg = v.parse(
    v.object({ name: v.string(), version: v.string() }),
    JSON.parse(await readFile(new URL("../../../apps/kello/package.json", import.meta.url), "utf8")),
  );
  const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd });
  assert.equal(head.exitCode, 0);
  const commit = head.stdout.toString().trim();
  const root = await mkdtemp(`${tmpdir()}/kello-ci-package-`);
  try {
    const payload = "fixture archive bytes";
    const digest = new Bun.CryptoHasher("sha256").update(payload).digest("hex");
    for (const scenario of [
      "valid",
      "wrong-commit",
      "wrong-version",
      "wrong-name",
      "changed-bytes",
      "cli-wrong-commit",
      "cli-wrong-version",
      "cli-wrong-name",
      "cli-changed-bytes",
      "cli-missing",
    ] as const) {
      await writeFile(`${root}/kello.tgz`, scenario === "changed-bytes" ? "changed" : payload);
      await writeFile(
        `${root}/manifest.json`,
        JSON.stringify({
          commit: scenario === "wrong-commit" ? "0".repeat(40) : commit,
          name: scenario === "wrong-name" ? "other-package" : pkg.name,
          version: scenario === "wrong-version" ? "999.0.0-alpha.0" : pkg.version,
          sha256: digest,
        }),
      );
      await writeFile(`${root}/kello-cli.tgz`, scenario === "cli-changed-bytes" ? "changed" : payload);
      const cli = {
        commit: scenario === "cli-wrong-commit" ? "0".repeat(40) : commit,
        name: scenario === "cli-wrong-name" ? "other" : "kello-cli",
        version: scenario === "cli-wrong-version" ? "999.0.0-alpha.0" : pkg.version,
        sha256: digest,
      };
      if (scenario === "cli-missing") await rm(`${root}/cli-manifest.json`, { force: true });
      else await writeFile(`${root}/cli-manifest.json`, JSON.stringify(cli));
      const child: Bun.Subprocess<"ignore", "pipe", "pipe"> = Bun.spawn(
        ["bash", "-e", "-o", "pipefail", "-c", script],
        {
          cwd,
          env: { ...process.env, ARTIFACT_DIR: root, RELEASE_COMMIT: commit },
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
      assert.equal(code === 0, scenario === "valid", `${scenario}: ${stdout} ${stderr}`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("publication downloads only a successful exact-commit main CI run", async () => {
  const workflow = v.parse(
    v.object({
      jobs: v.object({
        publish: v.object({ steps: v.array(v.object({ name: v.optional(v.string()), run: v.optional(v.string()) })) }),
      }),
    }),
    Bun.YAML.parse(await readFile(new URL("../../../.github/workflows/release.yml", import.meta.url), "utf8")),
  );
  const script = workflow.jobs.publish.steps.find(
    (step) => step.name === "Require successful main CI for this exact commit",
  )?.run;
  assert(script);
  const cwd = fileURLToPath(new URL("../../../", import.meta.url));
  const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd });
  assert.equal(head.exitCode, 0);
  const commit = head.stdout.toString().trim();
  const root = await mkdtemp(`${tmpdir()}/kello-ci-run-`);
  try {
    await writeFile(
      `${root}/gh`,
      `#!/usr/bin/env bun
import assert from "node:assert/strict";
const args = process.argv.slice(2);
assert.deepEqual(args.slice(0, 2), ["run", "list"]);
for (const [flag, value] of [["--workflow", "ci.yml"], ["--commit", process.env.EXPECTED_COMMIT], ["--branch", "main"], ["--event", "push"]]) assert.equal(args[args.indexOf(flag) + 1], value);
if (process.env.CI_RESULT === "api-error") process.exit(1);
console.log(process.env.CI_RESULT);
`,
    );
    await chmod(`${root}/gh`, 0o700);
    for (const result of ["12345", "", "not-a-run-id", "api-error"]) {
      const output = `${root}/output`;
      await writeFile(output, "");
      const child: Bun.Subprocess<"ignore", "pipe", "pipe"> = Bun.spawn(
        ["bash", "-e", "-o", "pipefail", "-c", script],
        {
          cwd,
          env: {
            ...process.env,
            PATH: `${root}:${process.env.PATH}`,
            EXPECTED_COMMIT: commit,
            GITHUB_REPOSITORY: "ImRLopezAG/kello",
            GITHUB_OUTPUT: output,
            CI_RESULT: result,
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
      assert.equal(code === 0, result === "12345", `${result}: ${stdout} ${stderr}`);
      assert.equal(await readFile(output, "utf8"), result === "12345" ? `run_id=12345\ncommit=${commit}\n` : "");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
