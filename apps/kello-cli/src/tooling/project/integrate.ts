import { lstat, mkdir, readFile, writeFile, link, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { projectTemplates } from "./initialize";
import { resolveProjectPath } from "../config/paths";
import { withProjectConfigurationLock } from "../config/environment-file";

/** Existing framework files are compared before any write; frontend configuration stays consumer-owned. */
export async function integrateProject(root: string, apply = false) {
  async function inspect() {
    const files: { path: string; content: string }[] = [];
    const collisions: string[] = [];
    for (const [path, content] of projectTemplates("app").filter(([path]) => path.startsWith("kello/"))) {
      const state = await lstat(join(root, path)).catch((cause: unknown) => {
        if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return undefined;
        throw cause;
      });
      await resolveProjectPath(root, path);
      if (!state) files.push({ path, content });
      else if (!state.isFile() || (await readFile(join(root, path), "utf8")) !== content) collisions.push(path);
    }
    return { files, collisions };
  }
  if (!apply) {
    const result = await inspect();
    return { applied: false, files: result.files.map(({ path }) => path), collisions: result.collisions };
  }
  return withProjectConfigurationLock(root, async () => {
    const result = await inspect();
    if (result.collisions.length) throw new Error(`Integration collision: ${result.collisions.join(", ")}`);
    for (const { path, content } of result.files) {
      const target = await resolveProjectPath(root, path);
      await mkdir(dirname(target), { recursive: true });
      const temporary = `${target}.${crypto.randomUUID()}.tmp`;
      try {
        await writeFile(temporary, content, { flag: "wx" });
        await link(temporary, target);
      } finally {
        await rm(temporary, { force: true });
      }
    }
    return { applied: true, files: result.files.map(({ path }) => path), collisions: [] };
  });
}
