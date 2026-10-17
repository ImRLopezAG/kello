import { expect, test } from "vite-plus/test";
import { createDevelopmentCoordinator } from "kello/tooling";

function deferred() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test("development revisions serialize work and supersede an in-flight candidate", async () => {
  const entered = deferred();
  const finish = deferred();
  const prepared: number[] = [];
  const activated: number[] = [];
  let active = 0;
  let maximumActive = 0;
  const coordinator = createDevelopmentCoordinator(
    async (revision) => {
      active++;
      maximumActive = Math.max(maximumActive, active);
      try {
        prepared.push(revision.number);
        if (revision.number === 1) {
          entered.release();
          await finish.promise;
        }
        revision.assertCurrent();
        activated.push(revision.number);
      } finally {
        active--;
      }
    },
    { debounceMs: 60_000 },
  );
  coordinator.invalidate();
  const drained = coordinator.flush();
  await entered.promise;
  coordinator.invalidate();
  coordinator.invalidate();
  const latest = coordinator.flush();
  finish.release();
  await Promise.all([drained, latest]);
  expect(prepared).toEqual([1, 3]);
  expect(activated).toEqual([3]);
  expect(maximumActive).toBe(1);
  expect(coordinator.failure).toBeNull();
  await coordinator.stop();
});

test("failed edits preserve active state and the next edit can recover", async () => {
  let activated = 0;
  const coordinator = createDevelopmentCoordinator(async (revision) => {
    if (revision.number === 2) throw new Error("Compilation failed");
    revision.assertCurrent();
    activated = revision.number;
  });
  coordinator.invalidate();
  await coordinator.flush();
  coordinator.invalidate();
  await coordinator.flush();
  expect(activated).toBe(1);
  expect(coordinator.failure?.revision).toBe(2);
  coordinator.invalidate();
  await coordinator.flush();
  expect(activated).toBe(3);
  expect(coordinator.failure).toBeNull();
  await coordinator.stop();
});

test("stop aborts active work, drains cleanup, and cancels debounced edits", async () => {
  const entered = deferred();
  const finish = deferred();
  let cleaned = false;
  let activated = false;
  const coordinator = createDevelopmentCoordinator(async (revision) => {
    entered.release();
    try {
      await finish.promise;
      revision.assertCurrent();
      activated = true;
    } finally {
      cleaned = true;
    }
  });
  coordinator.invalidate();
  const drained = coordinator.flush();
  await entered.promise;
  coordinator.invalidate();
  const stopped = coordinator.stop();
  expect(cleaned).toBe(false);
  finish.release();
  await Promise.all([drained, stopped]);
  expect(cleaned).toBe(true);
  expect(activated).toBe(false);
  expect(() => coordinator.invalidate()).toThrow("stopped");
  await coordinator.stop();
});

const source = await import("../../../apps/kello/src/tooling/dev/coordinator");

for (const [name, rejection] of [
  ["an error", new Error("cleanup-canary")],
  ["undefined", undefined],
  ["zero", 0],
] as const)
  test(`stop retains a non-cancellation cleanup rejection (${name}) from the draining revision`, async () => {
    const entered = deferred();
    const cleanup = deferred();
    const coordinator = source.createDevelopmentCoordinator(
      async () => {
        entered.release();
        await cleanup.promise;
        throw rejection;
      },
      { debounceMs: 0 },
    );
    coordinator.invalidate();
    await entered.promise;
    const stopping = coordinator.stop();
    cleanup.release();
    await expect(stopping).rejects.toMatchObject({ cause: rejection });
  });

test("expected cancellation of a draining revision stops cleanly", async () => {
  const { setTimeout: sleep } = await import("node:timers/promises");
  for (const cancel of ["reason", "timer", "stale"] as const) {
    const entered = deferred();
    const coordinator = source.createDevelopmentCoordinator(
      async (revision) => {
        entered.release();
        if (cancel === "timer") await sleep(60_000, undefined, { signal: revision.signal });
        await new Promise<void>((resolve) =>
          revision.signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        if (cancel === "reason") revision.signal.throwIfAborted();
        revision.assertCurrent();
      },
      { debounceMs: 0 },
    );
    coordinator.invalidate();
    await entered.promise;
    await expect(coordinator.stop()).resolves.toBeUndefined();
    expect(coordinator.failure).toBeNull();
  }
});

test("a superseded revision's cleanup failure survives a successful successor and preserves the primary", async () => {
  const entered = deferred();
  const cleanup = deferred();
  const coordinator = source.createDevelopmentCoordinator(
    async (revision) => {
      if (revision.number === 1) {
        entered.release();
        await cleanup.promise;
        throw new Error("first-cleanup");
      }
      if (revision.number === 2) throw new Error("second-cleanup");
    },
    { debounceMs: 0 },
  );
  coordinator.invalidate();
  await entered.promise;
  coordinator.invalidate();
  cleanup.release();
  await coordinator.flush();
  expect(coordinator.failure?.revision).toBe(2);
  coordinator.invalidate();
  await coordinator.flush();
  expect(coordinator.failure).toBeNull();
  await expect(coordinator.stop()).rejects.toMatchObject({ cause: { message: "first-cleanup" } });
});
