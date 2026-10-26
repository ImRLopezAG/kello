import type { NeonApi } from "@neon/config-runtime/v1";
import * as v from "valibot";
import { generateProject } from "../codegen/generate";
import { readResolvedProject } from "../config/resolve";
import { deployProjectRelease, readProjectRelease } from "../deploy/neon/project";
import { inspectDeploymentTarget } from "../deploy/neon/target";
import { watchDevelopment } from "./watcher";
import type { DevelopmentCoordinatorOptions, DevelopmentRevision } from "./coordinator";

export interface DevelopmentOptions extends DevelopmentCoordinatorOptions {
  readonly root: string;
  /** Release declaration; kello.config.ts uses its linked preview deployment settings. */
  readonly file?: string;
  readonly signal?: AbortSignal;
}
export interface ActiveDevelopmentGeneration {
  readonly version: string;
  readonly branchId: string;
}

/** Refuses anything except the linked, unprotected, non-default preview branch before any release work. */
async function assertLinkedPreview(root: string, file: string, provider?: NeonApi, signal?: AbortSignal) {
  const { project, declaration } = await readProjectRelease(root, file, signal);
  if (declaration.environment !== "preview") throw new Error("Development deploys only to a preview target");
  const target = await inspectDeploymentTarget(project.config, "preview", provider);
  const linked = await readResolvedProject(root);
  if (!linked || linked.projectId !== target.projectId || linked.branchId !== target.branchId)
    throw new Error("Development preview target must be the linked branch");
  signal?.throwIfAborted();
  return {
    projectId: target.projectId,
    branchId: target.branchId,
    endpointId: target.endpointId,
    databaseName: declaration.databaseName,
    migrationRole: declaration.migrationRole,
    runtimeRole: declaration.runtimeRole,
    namespace: project.config.database.namespace,
    metadataNamespace: project.config.database.metadataNamespace,
    deployment: declaration.deployment,
  };
}

/** Watches sources and deploys each new source version to the one linked preview target. No local backend runs. */
export async function startDevelopment(input: DevelopmentOptions, provider?: NeonApi) {
  const { root, file = "kello.config.ts", signal } = input;
  const debounce = v.safeParse(
    v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(60_000)), 75),
    input.debounceMs,
  );
  if (!debounce.success) throw new Error("Invalid development options");
  signal?.throwIfAborted();
  const selected = await assertLinkedPreview(root, file, provider, signal);
  let active: ActiveDevelopmentGeneration | null = null;
  let url: URL | null = null;
  const update = async (revision: DevelopmentRevision) => {
    signal?.throwIfAborted();
    // A failed build throws here, leaving the previous cloud release serving.
    const candidate = await generateProject(root);
    revision.assertCurrent();
    // Publication rewrites .env.local; an unchanged source version is not a new release.
    if (candidate.version === active?.version) return;
    const current = await assertLinkedPreview(root, file, provider, revision.signal);
    if (JSON.stringify(selected) !== JSON.stringify(current))
      throw new Error(
        "Development must keep the selected preview target; restart development to select another target",
      );
    revision.assertCurrent();
    const receipt = await deployProjectRelease(root, file, provider, revision.signal, {
      ...selected,
      version: candidate.version,
    });
    revision.assertCurrent();
    const linked = await readResolvedProject(root);
    url = linked?.public.serviceUrl ? new URL(linked.public.serviceUrl) : null;
    active = Object.freeze({ version: candidate.version, branchId: receipt.identity.target.branchId });
  };
  const coordinatorOptions = { debounceMs: debounce.output };
  const watcher = await watchDevelopment(root, update, coordinatorOptions, signal);
  return {
    get url(): URL | null {
      return url;
    },
    get active(): ActiveDevelopmentGeneration | null {
      return active;
    },
    get failure() {
      return watcher.failure;
    },
    get watchError() {
      return watcher.watchError;
    },
    flush: watcher.flush,
    settled: watcher.settled,
    // Stops watching and awaits any started release's own cleanup; the shared preview branch is kept.
    stop: watcher.stop,
  };
}
