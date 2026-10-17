import { test, expect } from "bun:test";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { unzipSync } from "fflate";
import { buildNeonFunctionBundle } from "kello/tooling";

test("Vite+ creates a standalone Neon Node 24 archive without running application build config", async () => {
  const root = await mkdtemp(join(tmpdir(), "kello-neon-bundle-"));
  try {
    await mkdir(join(root, "node_modules/cjs-fixture"), { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify({ private: true, type: "module" }));
    await writeFile(join(root, "vite.config.ts"), 'throw new Error("application build config must not run");');
    await writeFile(join(root, "node_modules/cjs-fixture/package.json"), JSON.stringify({ main: "index.cjs" }));
    await writeFile(
      join(root, "node_modules/cjs-fixture/index.cjs"),
      'const path = require("node:path"); module.exports = { value: path.basename("/neon/cloud") };',
    );
    await writeFile(join(root, "lazy.ts"), 'export const value: string = "ready";');
    const entry = join(root, "entry.ts");
    await writeFile(
      entry,
      'import dependency from "cjs-fixture"; export default { async fetch() { const lazy = await import("./lazy"); return Response.json({ dependency: dependency.value, lazy: lazy.value }); } };',
    );
    const before = await readdir(root);
    const archive = unzipSync(await buildNeonFunctionBundle(entry));
    expect(await readdir(root)).toEqual(before);
    expect(archive["index.mjs"]).toBeDefined();
    const output = join(root, "isolated");
    await mkdir(output);
    for (const [name, contents] of Object.entries(archive)) {
      const destination = join(output, name);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, contents);
    }
    // No source package can be resolved when the uploaded archive executes.
    await rm(join(root, "node_modules"), { recursive: true });
    const execution = Bun.spawn(
      [
        "node",
        "--input-type=module",
        "-e",
        `import assert from "node:assert/strict"; import entry from ${JSON.stringify(pathToFileURL(join(output, "index.mjs")).href)}; assert.deepEqual(await (await entry.fetch()).json(), { dependency: "cloud", lazy: "ready" });`,
      ],
      { cwd: output, stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exit] = await Promise.all([
      new Response(execution.stdout).text(),
      new Response(execution.stderr).text(),
      execution.exited,
    ]);
    expect({ stdout, stderr, exit }).toEqual({ stdout: "", stderr: "", exit: 0 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
