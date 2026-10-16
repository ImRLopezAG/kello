/// <reference types="../apps/loom/node_modules/@types/node" />
import { createRequire } from "node:module";

const require = createRequire(new URL("../apps/loom/package.json", import.meta.url));

interface MaintenanceOutput {
  status: "RATE_LIMIT_CLEANUP_FAILED" | "RATE_LIMIT_CLEANUP_BACKLOG" | "RATE_LIMIT_CLEANUP_OK";
  removed?: number;
  batches?: number;
  hasMore?: boolean;
  oldestExpiredAgeMs?: number | null;
  stoppedBy?: "empty" | "batch-budget" | "time-budget";
}

async function main(): Promise<void> {
  let status: MaintenanceOutput;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const args = process.argv.slice(2);
    const flags = new Map<string, string>();
    const allowed = new Set(["--metadata-namespace", "--batch-size", "--max-batches", "--max-duration-ms"]);
    for (let index = 0; index < args.length; index += 2) {
      const name = args[index]!;
      const value = args[index + 1];
      if (!allowed.has(name) || flags.has(name) || value === undefined) throw new Error();
      flags.set(name, value);
    }
    const metadataNamespace = flags.get("--metadata-namespace");
    if (!metadataNamespace || !/^[a-z][a-z0-9_]{0,62}$/.test(metadataNamespace)) throw new Error();
    function numeric(name: string, maximum: number): number {
      const value = flags.get(name);
      if (value === undefined) return maximum;
      if (!/^[1-9][0-9]*$/.test(value)) throw new Error();
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed > maximum) throw new Error();
      return parsed;
    }
    const batchSize = numeric("--batch-size", 500);
    const maxBatches = numeric("--max-batches", 20);
    const maxDurationMs = numeric("--max-duration-ms", 30_000);
    const connectionString = process.env.LOOM_MIGRATION_DATABASE_URL;
    if (!connectionString) throw new Error();
    const url = new URL(connectionString);
    if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error();
    // The root workspace intentionally has no runtime package dependency. Resolve
    // the public built kello/tooling export from the package's own scope.
    const { cleanupRateLimits } = await import(require.resolve("kello/tooling"));
    const result = await cleanupRateLimits({
      connectionString,
      metadataNamespace,
      batchSize,
      maxBatches,
      maxDurationMs,
      signal: controller.signal,
    });
    const backlog = result.oldestExpiredAgeMs !== null && result.oldestExpiredAgeMs > 3_600_000;
    status = {
      status: backlog ? "RATE_LIMIT_CLEANUP_BACKLOG" : "RATE_LIMIT_CLEANUP_OK",
      removed: result.removed,
      batches: result.batches,
      hasMore: result.hasMore,
      oldestExpiredAgeMs: result.oldestExpiredAgeMs,
      stoppedBy: result.stoppedBy,
    };
    process.exitCode = backlog ? 2 : 0;
  } catch (error) {
    status = { status: "RATE_LIMIT_CLEANUP_FAILED" };
    // Only cleanup's confirmed counters cross the failure boundary. Arguments,
    // credential errors and other failures have no progress to report.
    if (error instanceof Error) {
      try {
        const v = await import(require.resolve("valibot"));
        const progressSchema = v.pipe(
          v.object({
            removed: v.pipe(v.number(), v.safeInteger(), v.minValue(0), v.maxValue(10_000)),
            batches: v.pipe(v.number(), v.safeInteger(), v.minValue(0), v.maxValue(20)),
          }),
          v.check((progress: { removed: number; batches: number }) => progress.removed <= progress.batches * 500),
        );
        const progress = v.safeParse(progressSchema, error);
        if (progress.success) {
          status.removed = progress.output.removed;
          status.batches = progress.output.batches;
        }
      } catch {
        /* Missing tooling dependencies still produce a fixed failure. */
      }
    }
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
  console.log(JSON.stringify(status));
}

await main();
