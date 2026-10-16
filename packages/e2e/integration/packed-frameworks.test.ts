import { writeFrameworkSearch } from "../fixtures/framework-search";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";
import * as v from "valibot";

const manifestSchema = v.object({
  name: v.string(),
  version: v.string(),
  private: v.boolean(),
  type: v.string(),
  scripts: v.record(v.string(), v.string()),
  dependencies: v.record(v.string(), v.string()),
  devDependencies: v.record(v.string(), v.string()),
});

test("CSR and SSR examples build as independent consumers of one packed Kello artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "loom-packed-frameworks-"));
  const archive = join(root, "kello.tgz");
  const privateMarker = `server-secret-${crypto.randomUUID()}`;
  async function run(command: string[], cwd = root) {
    const child = Bun.spawn(command, {
      cwd,
      env: { ...process.env, NEON_AUTH_COOKIE_SECRET: privateMarker },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 120000,
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    assert.equal(code, 0, `${command.join(" ")}\n${stdout}\n${stderr}`);
  }
  try {
    await run(
      ["bun", "pm", "pack", "--filename", archive, "--ignore-scripts"],
      fileURLToPath(new URL("../../../apps/kello/", import.meta.url)),
    );
    const digest = createHash("sha256")
      .update(await readFile(archive))
      .digest("hex");
    const applications = [];
    for (const name of ["tasks", "jobs-storage", "next", "start"]) {
      const source = fileURLToPath(new URL(`../../examples/${name}/`, import.meta.url));
      const target = join(root, name);
      await cp(source, target, {
        recursive: true,
        filter: (path) =>
          ![
            "node_modules",
            "dist",
            ".next",
            ".output",
            ".tanstack",
            ".nitro",
            "_generated",
            ".loom",
            ".turbo",
          ].includes(basename(path)) && !basename(path).startsWith("_generated.staging-"),
      });
      await cp(join(source, "kello/migrations"), join(target, "kello/migrations"), {
        recursive: true,
      });
      const manifest = v.parse(manifestSchema, JSON.parse(await readFile(join(target, "package.json"), "utf8")));
      manifest.dependencies.kello = "file:../kello.tgz";
      delete manifest.devDependencies["@kello/ts-config"];
      assert(
        !Object.values({ ...manifest.dependencies, ...manifest.devDependencies }).some((value) =>
          value.startsWith("workspace:"),
        ),
      );
      await writeFile(join(target, "package.json"), JSON.stringify(manifest, null, 2));
      const config = JSON.parse(await readFile(join(target, "tsconfig.json"), "utf8"));
      config.extends = "./tsconfig.base.json";
      await writeFile(join(target, "tsconfig.json"), JSON.stringify(config, null, 2));
      const base = JSON.parse(
        await readFile(fileURLToPath(new URL("../../ts-config/base.json", import.meta.url)), "utf8"),
      );
      base.compilerOptions.lib = ["ES2023", "DOM", "DOM.Iterable"];
      base.compilerOptions.jsx = "react-jsx";
      await writeFile(join(target, "tsconfig.base.json"), JSON.stringify(base, null, 2));
      if (name === "next" || name === "start") await writeFrameworkSearch(target, name);
      await run(["bun", "install", "--linker", "isolated"], target);
      await run(["bun", "run", "build"], target);
      await run(["bun", "run", "typecheck"], target);
      const browserRoot = join(target, name === "next" ? ".next/static" : name === "start" ? ".output/public" : "dist");
      for (const file of await readdir(browserRoot, { recursive: true, withFileTypes: true })) {
        if (!file.isFile()) continue;
        const contents = await readFile(join(file.parentPath, file.name));
        assert(!contents.includes(privateMarker), `${name} browser output contains a server secret`);
      }
      applications.push({ name, root: target });
    }
    if (process.env.LOOM_PACKED_RECEIPT)
      await writeFile(
        process.env.LOOM_PACKED_RECEIPT,
        JSON.stringify({ root, archive, digest, applications, passed: true, at: new Date().toISOString() }, null, 2),
      );
  } finally {
    if (!process.env.LOOM_PACKED_RECEIPT) await rm(root, { recursive: true, force: true });
  }
}, 600000);
