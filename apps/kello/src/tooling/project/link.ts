import { copyFile, lstat, rename, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { resolveProjectPath } from "../config/paths";
import { withProjectConfigurationLock } from "../config/environment-file";
import { createKelloNeonClient } from "../neon/api";
import type { ResolvedNeonProject } from "../config/resolve";

/** Neon owns the context format; write a checked selection through its pinned CLI without pulling secrets. */
export async function writeNeonLink(root: string, project: ResolvedNeonProject): Promise<void> {
  const remote = await createKelloNeonClient().projects.get({ projectId: project.projectId });
  const orgId = remote.org_id;
  if (!orgId) throw new Error("Neon project organization is unavailable");
  await withProjectConfigurationLock(root, async () => {
    const target = join(root, ".neon");
    const state = await lstat(target).catch((cause: unknown) => {
      if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return undefined;
      throw cause;
    });
    if (state && !state.isFile()) throw new Error("Refusing to replace a non-file Neon context");
    const temporary = await resolveProjectPath(root, `.loom/link-${crypto.randomUUID()}.json`);
    try {
      if (state) await copyFile(target, temporary);
      const child = Bun.spawn(
        [
          process.execPath,
          fileURLToPath(import.meta.resolve("neon/cli")),
          "link",
          "--no-checks",
          "--no-env-pull",
          "--no-config",
          "--no-analytics",
          "--org-id",
          orgId,
          "--project-id",
          project.projectId,
          "--branch",
          project.branchName,
          "--context-file",
          temporary,
        ],
        {
          cwd: root,
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
          env: { ...process.env, CI: "true", DEBUG: "" },
          timeout: 30_000,
        },
      );
      if ((await child.exited) !== 0) throw new Error("Official Neon context writer failed");
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
  });
}
