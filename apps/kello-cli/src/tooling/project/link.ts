import { copyFile, lstat, rename, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { resolveProjectPath } from "../config/paths";
import { withProjectConfigurationLock } from "../config/environment-file";
import { createKelloNeonClient, neonCall, resolveNeonApiKey } from "../neon/api";
import type { ResolvedNeonProject } from "../config/resolve";

/**
 * Neon owns the context format; write a checked selection through its pinned CLI without pulling secrets.
 * The resolved key reaches the child only through `NEON_API_KEY`, never argv or a Neon CLI profile.
 */
export async function writeNeonLink(
  root: string,
  project: ResolvedNeonProject,
  cli: string = fileURLToPath(import.meta.resolve("neon/cli")),
): Promise<void> {
  const remote = await neonCall(createKelloNeonClient().projects.get({ projectId: project.projectId }));
  const orgId = remote.org_id;
  if (!orgId) throw new Error("Neon project organization is unavailable");
  const apiKey = await resolveNeonApiKey();
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== "NEON_PROFILE"));
  await withProjectConfigurationLock(root, async () => {
    const target = join(root, ".neon");
    const state = await lstat(target).catch((cause: unknown) => {
      if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return undefined;
      throw cause;
    });
    if (state && !state.isFile()) throw new Error("Refusing to replace a non-file Neon context");
    const temporary = await resolveProjectPath(root, `.kello/link-${crypto.randomUUID()}.json`);
    try {
      if (state) await copyFile(target, temporary);
      const child = Bun.spawn(
        [
          process.execPath,
          cli,
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
          env: { ...environment, NEON_API_KEY: apiKey, CI: "true", DEBUG: "" },
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
