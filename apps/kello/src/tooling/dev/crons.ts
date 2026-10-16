import * as v from "valibot";
import { CronExpressionParser } from "cron-parser";
import { cronScheduleValidator } from "kello/server";
import type { createRpcCronDispatcher } from "kello/server";

/** Emits observed UTC minutes only; durable occurrence deduplication belongs to the supplied dispatcher. */
export function createDevelopmentCronLoop(
  input: Readonly<Record<string, string>>,
  dispatcher: Pick<ReturnType<typeof createRpcCronDispatcher>, "dispatch">,
) {
  const declarations = v.parse(v.record(v.string(), cronScheduleValidator), input);
  const schedules = Object.entries(declarations).map(([name, expression]) => ({
    name,
    expression: CronExpressionParser.parse(expression, { tz: "UTC" }),
  }));
  const controller = new AbortController();
  let started = false;
  let minute = 0;
  const completed = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let failure: Error | null = null;
  function schedule(retry = false) {
    if (controller.signal.aborted || schedules.length === 0) return;
    timer = setTimeout(
      () => {
        timer = undefined;
        running = tick().finally(() => {
          running = undefined;
          schedule(failure !== null);
        });
      },
      retry ? Math.min(1000, 60_000 - (Date.now() % 60_000)) : 60_000 - (Date.now() % 60_000),
    );
  }
  async function tick() {
    const observed = Math.floor(Date.now() / 60_000) * 60_000;
    if (observed < minute || controller.signal.aborted) return;
    if (observed > minute) {
      minute = observed;
      completed.clear();
    }
    let failed = false;
    for (const entry of schedules) {
      if (controller.signal.aborted) return;
      if (completed.has(entry.name) || !entry.expression.includesDate(new Date(minute))) continue;
      try {
        await dispatcher.dispatch(entry.name, new Date(minute), controller.signal);
        completed.add(entry.name);
      } catch {
        if (!controller.signal.aborted) failed = true;
      }
    }
    if (!controller.signal.aborted) failure = failed ? new Error("Development cron dispatch failed") : null;
  }
  function halt(): void {
    controller.abort();
    clearTimeout(timer);
    timer = undefined;
  }
  return {
    get failure(): Error | null {
      return failure;
    },
    start(): void {
      if (controller.signal.aborted) throw new Error("Development cron loop stopped");
      if (started) return;
      started = true;
      minute = Math.floor(Date.now() / 60_000) * 60_000;
      for (const entry of schedules) completed.add(entry.name);
      schedule();
    },
    halt,
    async stop(): Promise<void> {
      halt();
      await running;
    },
  };
}
