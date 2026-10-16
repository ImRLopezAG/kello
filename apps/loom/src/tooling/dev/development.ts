import * as v from "valibot";
import { prepareProject, activateProject } from "../codegen/generate";
import { synchronizeDevelopment } from "./sync";
import { startDevelopmentRuntime, developmentRuntimeOptions } from "./runtime";
import type { DevelopmentRuntimeOptions } from "./runtime";
import { startDevelopmentServer, developmentServerLimits } from "./server";
import type { DevelopmentServerOptions } from "./server";
import type { DevelopmentTarget } from "./target";
import type { DevelopmentDatabaseProvider } from "./connection";
import { watchDevelopment, watchDevelopmentWithOwnedOutput } from "./watcher";
import type { DevelopmentCoordinatorOptions, DevelopmentRevision } from "./coordinator";
import { createDevelopmentJobLoop, developmentJobInterval } from "./jobs";
import { createDevelopmentCronLoop } from "./crons";

export interface DevelopmentOptions
  extends
    Omit<DevelopmentRuntimeOptions, "sourceVersion" | "signal">,
    DevelopmentServerOptions,
    DevelopmentCoordinatorOptions {
  readonly jobPollMs?: number;
}
export interface ActiveDevelopmentGeneration {
  readonly version: string;
  readonly target: DevelopmentTarget;
}

/** Owns the watcher and listener; initial or later failed edits remain observable and recover on the next save. */
export async function startDevelopment(input: DevelopmentOptions, provider?: DevelopmentDatabaseProvider) {
  return startDevelopmentInternal(input, provider);
}

/** Source-internal CLI ownership forwarding; absent from the public tooling barrel. */
export async function startDevelopmentWithOwnedOutput(
  input: DevelopmentOptions,
  provider: DevelopmentDatabaseProvider | undefined,
  ownedOutputPath: string,
) {
  return startDevelopmentInternal(input, provider, ownedOutputPath);
}

async function startDevelopmentInternal(
  input: DevelopmentOptions,
  provider?: DevelopmentDatabaseProvider,
  ownedOutputPath?: string,
) {
  const { port, maxConnections, debounceMs, jobPollMs, storageBackend, ...values } = input;
  const parsed = v.safeParse(v.omit(developmentRuntimeOptions, ["sourceVersion"]), values);
  const transport = v.safeParse(developmentServerLimits, { port, maxConnections });
  const debounce = v.safeParse(
    v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(60_000)), 75),
    debounceMs,
  );
  const jobsInterval = v.safeParse(developmentJobInterval, jobPollMs);
  if (!parsed.success || !transport.success || !debounce.success || !jobsInterval.success)
    throw new Error("Invalid development options");
  const options = parsed.output;
  const storage: Partial<Record<"storageBackend", NonNullable<DevelopmentOptions["storageBackend"]>>> = {};
  if (storageBackend) storage.storageBackend = Object.freeze({ ...storageBackend });
  let server: Awaited<ReturnType<typeof startDevelopmentServer>> | undefined;
  let active: ActiveDevelopmentGeneration | null = null;
  let fatal: Error | null = null;
  let stopping: Promise<void> | undefined;
  let background: ReturnType<typeof createDevelopmentJobLoop> | undefined;
  let cronBackground: ReturnType<typeof createDevelopmentCronLoop> | undefined;
  const update = async (revision: DevelopmentRevision) => {
    if (fatal) throw fatal;
    const candidate = await prepareProject(options.root);
    revision.assertCurrent();
    if (candidate.version === active?.version) return;
    await synchronizeDevelopment(
      {
        root: options.root,
        sourceVersion: candidate.version,
        databaseName: options.databaseName,
        migrationRole: options.migrationRole,
        runtimeRole: options.runtimeRole,
        signal: revision.signal,
      },
      provider,
    );
    revision.assertCurrent();
    const started = await startDevelopmentRuntime(
      { ...options, ...storage, sourceVersion: candidate.version, signal: revision.signal },
      provider,
    );
    let transferred = false;
    let runtime = started.runtime;
    try {
      const jobs = createDevelopmentJobLoop(started.runtime.worker, jobsInterval.output);
      const crons = createDevelopmentCronLoop(started.cronSchedules, started.runtime.crons);
      runtime = {
        ...started.runtime,
        async stop() {
          jobs.halt();
          crons.halt();
          try {
            await crons.stop();
          } finally {
            try {
              await jobs.stop();
            } finally {
              await started.runtime.stop();
            }
          }
        },
      };
      revision.assertCurrent();
      const activated = () => {
        background?.halt();
        cronBackground?.halt();
        background = jobs;
        cronBackground = crons;
        if (stopping) {
          jobs.halt();
          crons.halt();
        } else {
          jobs.start();
          crons.start();
        }
        active = Object.freeze({ version: candidate.version, target: started.target });
      };
      if (server) {
        transferred = true;
        const result = await server.replace(runtime, revision.signal, async (install) => {
          await activateProject(options.root, candidate.version, revision.signal, () => {
            install();
            activated();
          });
        });
        if (!result.retired) {
          fatal = new Error("Development retirement failed; restart development");
          throw fatal;
        }
      } else {
        transferred = true;
        const initial = await startDevelopmentServer(runtime, transport.output);
        let installed = false;
        try {
          await activateProject(options.root, candidate.version, revision.signal, () => {
            server = initial;
            installed = true;
            activated();
          });
        } finally {
          if (!installed) await initial.stop();
        }
      }
    } finally {
      if (!transferred) await runtime.stop();
    }
  };
  const coordinatorOptions = { debounceMs: debounce.output };
  const watcher =
    ownedOutputPath === undefined
      ? await watchDevelopment(options.root, update, coordinatorOptions)
      : await watchDevelopmentWithOwnedOutput(options.root, update, coordinatorOptions, ownedOutputPath);
  return {
    get url(): URL | null {
      return server ? new URL(server.url) : null;
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
    get workerFailure() {
      return background?.failure ?? null;
    },
    get cronFailure() {
      return cronBackground?.failure ?? null;
    },
    flush: watcher.flush,
    settled: watcher.settled,
    stop(): Promise<void> {
      if (!stopping)
        stopping = (async () => {
          background?.halt();
          cronBackground?.halt();
          try {
            await watcher.stop();
          } finally {
            await server?.stop();
          }
        })();
      return stopping;
    },
  };
}
