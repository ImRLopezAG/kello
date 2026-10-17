import type { NeonApi } from "@neon/config-runtime/v1";
import { loadProjectConfig } from "../project/load";
import { startDevelopment } from "./development";
import type { DevelopmentOptions } from "./development";

/** Watches the project and deploys it to the linked preview target through the ordinary release path. */
export async function startProjectDevelopment(
  root: string,
  file = "kello.config.ts",
  provider?: NeonApi,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const { config } = await loadProjectConfig(root);
  const input: DevelopmentOptions = { root, file };
  if (config.development) Object.assign(input, { debounceMs: config.development.debounceMs });
  if (signal) Object.assign(input, { signal });
  return startDevelopment(input, provider);
}
