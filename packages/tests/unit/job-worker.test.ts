import { expect, test, vi } from "vite-plus/test";
import { channel } from "node:diagnostics_channel";
import * as v from "valibot";
import { createDurableJobWorker } from "../../../apps/kello/src/core/server/jobs/durable-worker";
import type { JobExecutionResult, DurableWorkerOptions } from "../../../apps/kello/src/core/server/jobs/durable-worker";
import type { DurableJob } from "../../../apps/kello/src/core/server/jobs/durable-queue";
import { encodeRpcJobCall } from "kello/server";
import type { RpcJobCall } from "kello/server";
type ClaimedJob = DurableJob<RpcJobCall>;

function observeLeaseLoss() {
  const schema = v.strictObject({
    type: v.literal("job.lease.lost"),
    reason: v.picklist(["deadline", "ownership", "activation", "queue"]),
  });
  const events: v.InferOutput<typeof schema>[] = [];
  const metrics = channel("kello.runtime.metric");
  const capture: Parameters<typeof metrics.subscribe>[0] = (event) => {
    if (v.parse(v.object({ type: v.string() }), event).type === "job.lease.lost") {
      events.push(v.parse(schema, event));
    }
  };
  metrics.subscribe(capture);
  return { events, close: () => metrics.unsubscribe(capture) };
}

function fixture() {
  const id = crypto.randomUUID();
  const job: ClaimedJob = {
    id,
    owner: "worker",
    token: "1",
    attempt: 1,
    call: encodeRpcJobCall("a".repeat(64), ["jobs", "write"], null),
    identity: { issuer: "test", subject: "alice" },
  };
  const queue = {
    claim: vi.fn(async (): Promise<ClaimedJob | null> => job),
    renew: vi.fn(async () => true),
    complete: vi.fn(async () => true),
    fail: vi.fn(async () => true),
  };
  const execute = vi.fn<DurableWorkerOptions<RpcJobCall>["execute"]>(async () => ({ ok: true, value: "saved" }));
  const assertActive = vi.fn(async () => {});
  return { job, queue, execute, assertActive };
}

test("worker coalesces bounded passes and settles with the persisted job identity", async () => {
  const setup = fixture();
  const worker = createDurableJobWorker({ ...setup, owner: "worker", leaseSeconds: 3 });
  const run = worker.run(2);
  expect(worker.run(10)).toBe(run);
  expect(await run).toEqual({ claimed: 2, completed: 2, failed: 0, leaseLost: 0 });
  expect(setup.execute).toHaveBeenCalledWith(setup.job, expect.any(AbortSignal));
  expect(setup.queue.complete).toHaveBeenCalledWith(setup.job, "saved");
  expect(setup.assertActive.mock.calls.length).toBeGreaterThanOrEqual(2);
  await worker.stop();
  await expect(worker.run()).rejects.toThrow("stopped");
});

test("worker requires active authority and a current lease before executing", async () => {
  const denied = fixture();
  denied.assertActive.mockRejectedValue(new Error("secret activation detail"));
  const blocked = createDurableJobWorker({ ...denied, owner: "worker" });
  await expect(blocked.run(1)).rejects.toThrow("ACTIVATION_DENIED");
  expect(denied.queue.claim).not.toHaveBeenCalled();
  await blocked.stop();
  const expired = fixture();
  expired.queue.renew.mockResolvedValue(false);
  const worker = createDurableJobWorker({ ...expired, owner: "worker" });
  expect(await worker.run(1)).toEqual({ claimed: 1, completed: 0, failed: 0, leaseLost: 1 });
  expect(expired.execute).not.toHaveBeenCalled();
  expect(expired.queue.complete).not.toHaveBeenCalled();
  await worker.stop();
});

test("worker heartbeat observes cancellation and shutdown drains active execution", async () => {
  const observation = observeLeaseLoss();
  vi.useFakeTimers();
  const setup = fixture();
  const started = Promise.withResolvers<void>();
  const result = Promise.withResolvers<JobExecutionResult>();
  let signal: AbortSignal | undefined;
  setup.execute.mockImplementation(async (_job, abort): Promise<JobExecutionResult> => {
    signal = abort;
    started.resolve();
    return result.promise;
  });
  const worker = createDurableJobWorker({ ...setup, owner: "worker", leaseSeconds: 3 });
  try {
    const run = worker.run(1);
    await started.promise;
    setup.queue.renew.mockResolvedValue(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(signal?.aborted).toBe(true);
    expect(observation.events).toEqual([{ type: "job.lease.lost", reason: "ownership" }]);
    let stopped = false;
    const stop = worker.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    result.resolve({ ok: false, error: { code: "CANCELLED" } });
    expect(await run).toEqual({ claimed: 1, completed: 0, failed: 1, leaseLost: 0 });
    await stop;
    expect(setup.queue.fail).toHaveBeenCalledWith(setup.job, "CANCELLED");
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    observation.close();
    result.resolve({ ok: true, value: null });
    await worker.stop();
    vi.useRealTimers();
  }
});

test("worker aborts on a stalled renewal and redacts queue failures", async () => {
  const observation = observeLeaseLoss();
  vi.useFakeTimers();
  const setup = fixture();
  const started = Promise.withResolvers<void>();
  const renewal = Promise.withResolvers<boolean>();
  const result = Promise.withResolvers<JobExecutionResult>();
  let signal: AbortSignal | undefined;
  setup.execute.mockImplementation(async (_job, abort): Promise<JobExecutionResult> => {
    signal = abort;
    started.resolve();
    return result.promise;
  });
  const worker = createDurableJobWorker({ ...setup, owner: "worker", leaseSeconds: 3 });
  try {
    const run = worker.run(1);
    await started.promise;
    setup.queue.renew.mockImplementation(() => renewal.promise);
    await vi.advanceTimersByTimeAsync(3001);
    expect(signal?.aborted).toBe(true);
    expect(observation.events).toEqual([{ type: "job.lease.lost", reason: "deadline" }]);
    renewal.resolve(true);
    result.resolve({ ok: false, error: { code: "CANCELLED" } });
    await run;
    expect(observation.events).toHaveLength(1);
    await worker.stop();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    observation.close();
    renewal.resolve(false);
    result.resolve({ ok: true, value: null });
    await worker.stop();
    vi.useRealTimers();
  }
  const broken = fixture();
  broken.queue.claim.mockRejectedValue(new Error("postgres://secret"));
  const unavailable = createDurableJobWorker({ ...broken, owner: "worker" });
  await expect(unavailable.run(1)).rejects.toThrow("QUEUE_UNAVAILABLE");
  await unavailable.stop();
});

test("shutdown during a claim prevents dispatch and stops are idempotent", async () => {
  const setup = fixture();
  const claiming = Promise.withResolvers<void>();
  const claimed = Promise.withResolvers<ClaimedJob | null>();
  setup.queue.claim.mockImplementation(async () => {
    claiming.resolve();
    return claimed.promise;
  });
  const worker = createDurableJobWorker({ ...setup, owner: "worker" });
  for (const count of [0, 101, 1.5]) await expect(worker.run(count)).rejects.toThrow("maxJobs");
  const run = worker.run(1);
  await claiming.promise;
  const stop = worker.stop();
  expect(worker.stop()).toBe(stop);
  claimed.resolve(setup.job);
  expect(await run).toEqual({ claimed: 1, completed: 0, failed: 0, leaseLost: 1 });
  await stop;
  expect(setup.execute).not.toHaveBeenCalled();
  expect(setup.queue.renew).not.toHaveBeenCalled();
  expect(setup.assertActive).toHaveBeenCalledTimes(1);
});

test.each(["activation", "queue"] as const)(
  "worker reports %s renewal failure without error contents",
  async (reason) => {
    const setup = fixture();
    const observation = observeLeaseLoss();
    if (reason === "activation") {
      setup.assertActive.mockResolvedValueOnce(undefined).mockRejectedValue(new Error("secret activation detail"));
    } else {
      setup.queue.renew.mockRejectedValue(new Error("postgres://secret"));
    }
    const worker = createDurableJobWorker({ ...setup });
    try {
      await expect(worker.run(1)).rejects.toThrow(reason === "activation" ? "ACTIVATION_DENIED" : "QUEUE_UNAVAILABLE");
      expect(observation.events).toEqual([{ type: "job.lease.lost", reason }]);
      expect(setup.execute).not.toHaveBeenCalled();
    } finally {
      await worker.stop();
      observation.close();
    }
  },
);
