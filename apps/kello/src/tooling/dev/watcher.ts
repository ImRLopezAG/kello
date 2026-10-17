import { watch } from "node:fs";
import { resolveProjectPath } from "../config/paths";
import { createDevelopmentCoordinator } from "./coordinator";
import type { DevelopmentCoordinatorOptions, DevelopmentRevision } from "./coordinator";

const ignoredDirectories = new Set([".git", ".loom", "node_modules", "dist", ".astro"]);
// Release publication owns the root .env.local and its temporary sibling; neither is part of the source version.
const publicationOutput =
  /^(?:\.env\.local|\.\.env\.local-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp)$/;
const componentArtifacts =
  /^_generated\.(?:staging|previous)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Watch dependencies anywhere in the project, including helpers outside backend/functions. */
export async function watchDevelopment(
  root: string,
  update: (revision: DevelopmentRevision) => Promise<void>,
  options: DevelopmentCoordinatorOptions = {},
  signal?: AbortSignal,
) {
  const directory = await resolveProjectPath(root, ".");
  signal?.throwIfAborted();
  const coordinator = createDevelopmentCoordinator(update, options);
  let stopped = false;
  let watchError: Error | null = null;
  const watcher = watch(directory, { recursive: true, encoding: "utf8" }, (_event, filename) => {
    if (stopped) return;
    // A missing filename means the OS could not identify the change: conservatively rebuild.
    const parts = filename?.split(/[\\/]/);
    if (parts?.some((part) => ignoredDirectories.has(part))) return;
    if (parts?.length === 1 && publicationOutput.test(parts[0] ?? "")) return;
    // Component codegen swaps sibling directories before publishing _generated.
    if (parts?.some((part) => componentArtifacts.test(part))) return;
    const generated = parts?.indexOf("_generated") ?? -1;
    if (generated !== -1 && parts?.[generated + 1] !== "migrations") return;
    if (generated !== -1 && parts?.some((part) => /^\.auth-ownership(?:\.json|-[0-9a-f-]+\.tmp)$/.test(part))) return;
    coordinator.invalidate();
  });
  const closed = new Promise<void>((resolve) => watcher.once("close", resolve));
  let stopping: Promise<void> | undefined;
  // Listener-triggered stops are observed here; the same rejection is returned to the caller's stop().
  const cancel = () => {
    stop().catch(() => {});
  };
  function stop(): Promise<void> {
    signal?.removeEventListener("abort", cancel);
    if (!stopped) {
      stopped = true;
      watcher.close();
    }
    stopping ??= Promise.all([closed, coordinator.stop()]).then(() => {});
    return stopping;
  }
  watcher.on("error", (cause) => {
    watchError = new Error("Development filesystem watcher failed", { cause });
    cancel();
  });
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) {
    await stop();
    signal.throwIfAborted();
  }
  coordinator.invalidate();
  return {
    get failure() {
      return coordinator.failure;
    },
    get watchError(): Error | null {
      return watchError;
    },
    flush: coordinator.flush,
    settled: coordinator.settled,
    stop,
  };
}
