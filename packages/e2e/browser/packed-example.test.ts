import assert from "node:assert/strict";
import { test } from "bun:test";
import { cp, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import type { Browser } from "playwright";
import * as v from "valibot";
import { startLocalTasks } from "../fixtures/local-tasks";

const connectionString = process.env.LOOM_TEST_DATABASE_URL;
test.skipIf(!connectionString)(
  "copied tasks example builds and runs using isolated packed artifacts",
  async () => {
    assert(connectionString);
    const root = await realpath(await mkdtemp(join(tmpdir(), "loom-packed-example-")));
    const example = join(root, "tasks");
    let app: Awaited<ReturnType<typeof startLocalTasks>> | undefined;
    let browser: Browser | undefined;
    async function run(command: string[], cwd: string) {
      const child = Bun.spawn(command, {
        cwd,
        env: { ...process.env, VITE_LOOM_ACCEPTANCE: "1" },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 90000,
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      assert.equal(code, 0, `${command.join(" ")}\n${stdout}\n${stderr}`);
    }
    try {
      for (const name of ["kello", "ts-config"])
        await run(
          ["bun", "pm", "pack", "--filename", join(root, `${name}.tgz`), "--ignore-scripts"],
          fileURLToPath(new URL(name === "kello" ? "../../../apps/kello/" : `../../${name}/`, import.meta.url)),
        );
      await cp(fileURLToPath(new URL("../../examples/tasks/", import.meta.url)), example, {
        recursive: true,
        filter: (path) => !["node_modules", "dist", "_generated", ".turbo", ".loom"].includes(basename(path)),
      });
      await cp(
        fileURLToPath(new URL("../../examples/tasks/kello/migrations/", import.meta.url)),
        join(example, "kello/migrations"),
        { recursive: true },
      );
      const manifest = v.parse(
        v.object({
          name: v.string(),
          version: v.string(),
          private: v.boolean(),
          type: v.string(),
          scripts: v.record(v.string(), v.string()),
          dependencies: v.record(v.string(), v.string()),
          devDependencies: v.record(v.string(), v.string()),
        }),
        JSON.parse(await readFile(join(example, "package.json"), "utf8")),
      );
      for (const dependencies of [manifest.dependencies, manifest.devDependencies])
        for (const [name, version] of Object.entries(dependencies))
          if (version.startsWith("workspace:")) dependencies[name] = `file:../${name.replace("@kello/", "")}.tgz`;
      await writeFile(join(example, "package.json"), JSON.stringify(manifest));
      await run(["bun", "install", "--linker", "isolated"], example);
      await run(["bun", "install", "--frozen-lockfile"], example);
      await run(["bun", "run", "build"], example);
      await run(["bun", "run", "typecheck"], example);
      const tooling: typeof import("kello/tooling") = await import(Bun.resolveSync("kello/tooling", example));
      const core: typeof import("kello/server") = await import(Bun.resolveSync("kello/server", example));
      app = await startLocalTasks({ connectionString, port: 0, root: example, tooling, core });
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({ ignoreHTTPSErrors: true });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(app.url);
      await page.getByRole("button", { name: "Continue as Alice" }).click();
      await page.getByLabel("Project name").fill("Packed release");
      await page.getByRole("button", { name: "Create project" }).click();
      await page.getByLabel("Task title").fill("Run outside the workspace");
      await page.getByRole("button", { name: "Add task" }).click();
      await page.getByRole("checkbox", { name: "Run outside the workspace" }).click();
      await page.waitForFunction(() => document.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked);
      assert.deepEqual(errors, []);
    } finally {
      try {
        await browser?.close();
      } finally {
        try {
          await app?.stop();
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      }
    }
  },
  180000,
);
