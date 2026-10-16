import { realpath, lstat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

function assertWithin(root: string, candidate: string): void {
  const local = relative(root, candidate);
  if (local === ".." || local.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(local)) {
    throw new Error("Project paths must not escape the project root");
  }
}

export async function resolveProjectPath(projectRoot: string, configuredPath: string): Promise<string> {
  const root = await realpath(projectRoot);
  if (isAbsolute(configuredPath)) throw new Error("Absolute paths can escape the project root");
  const candidate = resolve(root, configuredPath);
  assertWithin(root, candidate);
  let existing = candidate;
  while (true) {
    try {
      await lstat(existing);
      break;
    } catch (cause) {
      if (!(cause instanceof Error) || !("code" in cause) || cause.code !== "ENOENT") throw cause;
      const parent = dirname(existing);
      if (parent === existing) throw cause;
      existing = parent;
    }
  }
  const canonical = join(await realpath(existing), relative(existing, candidate));
  assertWithin(root, canonical);
  return canonical;
}
