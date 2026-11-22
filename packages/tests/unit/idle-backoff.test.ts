import { expect, test, vi } from "vite-plus/test";
import { NodePgDatabase } from "drizzle-orm/node-postgres";
import { createNeonTriggers } from "../../../apps/kello/src/core/adapters/neon/triggers";
import { createIdleBackoff } from "../../../apps/kello/src/core/server/jobs/idle-backoff";
import { createDurableJobWorker } from "../../../apps/kello/src/core/server/jobs/durable-worker";
import { createDurableCronDispatcher } from "../../../apps/kello/src/core/server/jobs/durable-crons";
import type { DurableJob } from "../../../apps/kello/src/core/server/jobs/durable-queue";

const minute = 60_000;
function clock() {
  let time = 1_000_000;
  return { now: () => time, advance: (ms: number) => (time += ms) };
}

test("empty passes back off exponentially past Neon's five-minute suspend window", () => {
  const time = clock();
  const idle = createIdleBackoff({ now: time.now });
  expect(idle.shouldPoll()).toBe(true);
  const waits: number[] = [];
  for (let pass = 0; pass < 7; pass++) {
    idle.record(0);
    waits.push(idle.remainingMs());
    time.advance(idle.remainingMs() - 1);
    expect(idle.shouldPoll()).toBe(false);
    time.advance(1);
    expect(idle.shouldPoll()).toBe(true);
  }
  expect(waits).toEqual([1, 2, 4, 8, 10, 10, 10].map((m) => m * minute));
  // Minute wake-ups stay below 10% of the undisturbed rate once backed off.
  expect(Math.max(...waits)).toBeGreaterThan(5 * minute);
});

test("claimed work and explicit resets resume immediate polling", () => {
  const time = clock();
  const idle = createIdleBackoff({ now: time.now, initialMs: 1000, maxMs: 4000 });
  idle.record(0);
  idle.record(0);
  expect(idle.remainingMs()).toBe(2000);
  idle.record(3);
  expect(idle.shouldPoll()).toBe(true);
  idle.record(0);
  idle.reset();
  expect(idle.shouldPoll()).toBe(true);
  expect(() => createIdleBackoff({ initialMs: 5000, maxMs: 1000 })).toThrow();
  expect(() => createIdleBackoff({ initialMs: 10 })).toThrow();
});

function job(): DurableJob<string> {
  return { id: crypto.randomUUID(), owner: "worker", token: "1", attempt: 1, call: "c", identity: null };
}

test("worker records only clean passes, and backoff never interrupts a claimed lease", async () => {
  vi.useFakeTimers();
  try {
    const record = vi.fn();
    let pending: DurableJob<string>[] = [job()];
    const renew = vi.fn(async () => true);
    let release!: () => void;
    const worker = createDurableJobWorker<string>({
      queue: {
        claim: vi.fn(async () => pending.shift() ?? null),
        renew,
        complete: vi.fn(async () => true),
        fail: vi.fn(async () => true),
      },
      execute: () => new Promise((resolve) => (release = () => resolve({ ok: true, value: null }))),
      assertActive: async () => {},
      leaseSeconds: 3,
      idle: { record },
    });
    const run = worker.run();
    await vi.advanceTimersByTimeAsync(10_000);
    // Heartbeats keep renewing a long job regardless of idle state.
    expect(renew.mock.calls.length).toBeGreaterThanOrEqual(10);
    expect(record).not.toHaveBeenCalled();
    release();
    expect(await run).toMatchObject({ claimed: 1, completed: 1 });
    expect(record).toHaveBeenLastCalledWith(1);
    expect(await worker.run()).toMatchObject({ claimed: 0 });
    expect(record).toHaveBeenLastCalledWith(0);
    pending = [];
    const failing = createDurableJobWorker<string>({
      queue: {
        claim: async () => {
          throw new Error("down");
        },
        renew,
        complete: async () => true,
        fail: async () => true,
      },
      execute: async () => ({ ok: true, value: null }),
      assertActive: async () => {},
      idle: { record },
    });
    record.mockClear();
    await expect(failing.run()).rejects.toThrow("QUEUE_UNAVAILABLE");
    expect(record).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

function dispatcher(idle: ReturnType<typeof createIdleBackoff>) {
  const transaction = vi.fn(async () => {
    throw new Error("idle wakes must not open a transaction");
  });
  const enqueue = vi.fn(async () => "job-one");
  const options: Parameters<typeof createDurableCronDispatcher>[0] = {
    // SAFETY: idle wakes and undelivered cron dispatch use only the stubbed transaction method.
    db: Object.assign(Object.create(NodePgDatabase.prototype) as NodePgDatabase, { transaction }),
    crons: new Map([["reports", enqueue]]),
    assertActive: async () => {},
    deployment: "deployment",
    metadataNamespace: "kello_app",
    idle,
  };
  return { crons: createDurableCronDispatcher(options), transaction, enqueue };
}

test("idle wakes skip the receipt write entirely and cron enqueues reset the backoff", async () => {
  const time = clock();
  const idle = createIdleBackoff({ now: time.now });
  const { crons, transaction } = dispatcher(idle);
  idle.record(0);
  const delivery = { invocationId: "i", triggerId: "t", triggerName: "n" };
  expect(await crons.recordWake(delivery, new Date())).toBe(false);
  expect(transaction).not.toHaveBeenCalled();
  expect(await crons.dispatch("reports", new Date())).toBe("job-one");
  expect(idle.shouldPoll()).toBe(true);
});

test("an idle wake answers without running the worker, reconcile or cleanup", async () => {
  const run = vi.fn(async () => ({ claimed: 0, completed: 0, failed: 0, leaseLost: 0 }));
  const cleanup = vi.fn(async () => ({ processed: 0, failed: 0 }));
  const app = createNeonTriggers({
    bindings: { "trigger-wake": { kind: "wake", name: "worker" } },
    crons: { dispatch: async () => "unused", recordWake: async () => false },
    worker: { run },
    cleanup: { run: cleanup },
  });
  const response = await app.fetch(
    new Request("https://api.example.test/api/kello/triggers", {
      method: "POST",
      headers: { "content-type": "application/json", "x-neon-trigger-invocation-id": "d" },
      body: JSON.stringify({
        version: 1,
        invocation_id: "d",
        trigger: { type: "schedule", id: "trigger-wake", name: "worker" },
        data: { scheduled_at: "2026-01-01T00:00:00Z" },
      }),
    }),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true, idle: true });
  expect(run).not.toHaveBeenCalled();
  expect(cleanup).not.toHaveBeenCalled();
});
