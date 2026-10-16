import { setTimeout } from "node:timers/promises";
import { startDiagnostics, startProjectDevelopment } from "kello/tooling";
import type { DiagnosticsOptions, DiagnosticsSession } from "kello/tooling";
import { closeOwnedFile } from "../tooling/diagnostics/output";
import { startProjectDevelopmentWithOwnedOutput } from "../tooling/dev/project";

export async function devCommand(
  root: string,
  file: string,
  structured: boolean,
  diagnosticsOptions?: DiagnosticsOptions,
): Promise<number> {
  return devCommandInternal(root, file, structured, diagnosticsOptions);
}

/** CLI-only forwarding; the public command and DiagnosticsOptions remain unchanged. */
export async function devCommandWithOwnedOutput(
  root: string,
  file: string,
  structured: boolean,
  diagnosticsOptions: DiagnosticsOptions,
  ownedOutputPath: string,
): Promise<number> {
  return devCommandInternal(root, file, structured, diagnosticsOptions, ownedOutputPath);
}

async function devCommandInternal(
  root: string,
  file: string,
  structured: boolean,
  diagnosticsOptions?: DiagnosticsOptions,
  ownedOutputPath?: string,
): Promise<number> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  let development: Awaited<ReturnType<typeof startProjectDevelopment>> | undefined;
  let diagnostics: DiagnosticsSession | undefined;
  let failed = false;
  let stopFailure: { cause: unknown } | undefined;
  function report(event: "watching" | "ready" | "stopped", version?: string, url?: string) {
    console.log(
      structured
        ? JSON.stringify({ ok: true, command: "dev", event, version, url })
        : event === "ready"
          ? `Development ready at ${url} (${version}).`
          : event === "watching"
            ? "Watching development sources."
            : "Development stopped.",
    );
  }
  try {
    if (diagnosticsOptions) diagnostics = await startDiagnostics(diagnosticsOptions);
    development =
      ownedOutputPath === undefined
        ? await startProjectDevelopment(root, file)
        : await startProjectDevelopmentWithOwnedOutput(root, file, undefined, ownedOutputPath);
    report("watching");
    let version: string | undefined;
    let failure: typeof development.failure = null;
    let workerFailed = false;
    let cronFailed = false;
    while (!controller.signal.aborted) {
      if (development.watchError) throw new Error("Development watcher failed");
      const nextWorkerFailed = development.workerFailure !== null;
      if (nextWorkerFailed && !workerFailed) {
        const code = "DEVELOPMENT_WORKER_FAILED";
        const message = "Development job worker failed. Check database access and activation; polling will retry.";
        console.error(
          structured
            ? JSON.stringify({ ok: false, command: "dev", event: "worker-failed", error: { code, message } })
            : `${code}: ${message}`,
        );
      }
      workerFailed = nextWorkerFailed;
      const nextCronFailed = development.cronFailure !== null;
      if (nextCronFailed && !cronFailed) {
        const code = "DEVELOPMENT_CRON_FAILED";
        const message =
          "Development cron dispatch failed. Check database access and activation; the current occurrence will retry while its minute remains current.";
        console.error(
          structured
            ? JSON.stringify({ ok: false, command: "dev", event: "cron-failed", error: { code, message } })
            : `${code}: ${message}`,
        );
      }
      cronFailed = nextCronFailed;
      const nextFailure = development.failure;
      const nextVersion = development.active?.version;
      if (nextFailure && nextFailure !== failure) {
        const code = "DEVELOPMENT_UPDATE_FAILED";
        const message =
          "Development update failed. Check source, schema changes, credentials and target access; save to retry.";
        console.error(
          structured
            ? JSON.stringify({
                ok: false,
                command: "dev",
                event: "update-failed",
                revision: nextFailure.revision,
                error: { code, message },
              })
            : `${code}: ${message}`,
        );
      }
      if (nextVersion && (nextVersion !== version || (failure && !nextFailure)))
        report("ready", nextVersion, development.url?.href);
      version = nextVersion;
      failure = nextFailure;
      try {
        await setTimeout(100, undefined, { signal: controller.signal });
      } catch (cause) {
        if (!controller.signal.aborted) throw cause;
      }
    }
  } catch (cause) {
    failed = true;
    throw cause;
  } finally {
    try {
      try {
        await development?.stop();
      } catch (cause) {
        if (!failed) stopFailure = { cause };
      }
    } finally {
      try {
        // Diagnostics cleanup cannot replace a development failure or exit class.
        if (diagnosticsOptions) {
          const deadline = performance.now() + 2000;
          try {
            await diagnostics?.stop().catch(() => {});
          } finally {
            await closeOwnedFile(diagnosticsOptions.output?.write, deadline);
          }
        }
      } finally {
        process.off("SIGINT", cancel);
        process.off("SIGTERM", cancel);
      }
    }
  }
  if (stopFailure) throw stopFailure.cause;
  report("stopped");
  return 0;
}
