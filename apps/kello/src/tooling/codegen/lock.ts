import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { resolveProjectPath } from "../config/paths";

/** Fail closed on an abandoned lock; only its current owner removes it. */
export async function withGenerationLock<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const state = await resolveProjectPath(root, ".loom");
  await mkdir(state, { recursive: true });
  const lock = join(state, "generation.lock");
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      await mkdir(lock);
      break;
    } catch (cause) {
      if (!(cause instanceof Error) || !("code" in cause) || cause.code !== "EEXIST") throw cause;
      if (Date.now() >= deadline) throw new Error("Project generation is locked by another operation");
      await setTimeout(25);
    }
  }
  try {
    return await operation();
  } finally {
    await rm(lock, { recursive: true });
  }
}
