import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vite-plus/test";

const dist = fileURLToPath(new URL("../../../apps/kello/dist/", import.meta.url));
const driverImport =
  /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["'](?:pg|pg\/[^"']*|drizzle-orm\/node-postgres(?:\/[^"']*)?)["']/;

async function declarations(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".d.ts"))
    .map((entry) => join(entry.parentPath, entry.name));
}

test("Kello's emitted declarations import neither pg nor node-postgres", async () => {
  const files = await declarations(dist);
  expect(files.length, "build kello before running this test").toBeGreaterThan(0);
  const leaking: string[] = [];
  for (const file of files) if (driverImport.test(await readFile(file, "utf8"))) leaking.push(relative(dist, file));
  expect(leaking).toEqual([]);
});
