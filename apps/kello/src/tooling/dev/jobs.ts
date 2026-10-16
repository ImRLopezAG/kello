import * as v from "valibot";
import type { createRpcJobWorker } from "kello/server";

export const developmentJobInterval = v.optional(
  v.pipe(v.number(), v.integer(), v.minValue(100), v.maxValue(60_000)),
  1000,
);

/** Owns one worker. Publication starts polling; halt prevents further passes and requests cooperative shutdown. */
export function createDevelopmentJobLoop(
  worker: Pick<ReturnType<typeof createRpcJobWorker>, "run" | "stop">,
  intervalMs?: number,
) {
  const interval = v.parse(developmentJobInterval, intervalMs);
  let started = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  let failure: Error | null = null;
  let cleanupFailed = false;
  function schedule(delay: number) {
    timer = setTimeout(() => {
      timer = undefined;
      if (stopped) return;
      running = Promise.resolve()
        .then(() => {
          if (!stopped) return worker.run(10);
        })
        .then(() => {
          if (!stopped) failure = null;
        })
        .catch(() => {
          if (!stopped) failure = new Error("Development job worker failed");
        })
        .finally(() => {
          running = undefined;
          if (!stopped) schedule(interval);
        });
    }, delay);
  }
  function halt(): void {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    timer = undefined;
    stopping = Promise.resolve()
      .then(() => worker.stop())
      .catch(() => {
        cleanupFailed = true;
      });
  }
  return {
    get failure(): Error | null {
      return failure;
    },
    start(): void {
      if (stopped) throw new Error("Development job worker stopped");
      if (started) return;
      started = true;
      schedule(0);
    },
    halt,
    async stop(): Promise<void> {
      halt();
      await stopping;
      await running;
      if (cleanupFailed) throw new Error("Development job worker cleanup failed");
    },
  };
}
