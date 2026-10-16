import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

export async function sourceFiles(root: string, directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith("_") || entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Function discovery does not follow symlinks: ${relative(root, path)}`);
    if (entry.isDirectory()) result.push(...(await sourceFiles(root, path)));
    else if (/\.(?:[cm]?[jt]s)$/.test(entry.name) && !/\.(?:test|spec|d)\.[cm]?[jt]s$/.test(entry.name))
      result.push(path);
  }
  return result.sort();
}
