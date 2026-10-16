import { expect, test, vi } from "vite-plus/test";
import { createRevisionCoordinator } from "../../../apps/loom/src/core/server/realtime/coordinator";
import type { TableRevisions } from "../../../apps/loom/src/core/server/realtime/revisions";
type Evaluation = { value: string; revisions: { tasks: string } };

const session = () => ({
  identity: { issuer: "test", subject: "alice" },
  expiresAt: Math.floor(Date.now() / 1000) + 60,
});
const result = (revision: string): Evaluation => ({
  value: revision,
  revisions: { tasks: revision },
});

test.each([
  ["initial", "absent"],
  ["initial", "inherited"],
  ["reevaluation", "absent"],
  ["reevaluation", "inherited"],
])("%s capture with an %s revision key closes before publication", async (stage, presence) => {
  let evaluations = 0;
  let revision = "1";
  const updates: string[] = [];
  const reasons: string[] = [];
  const poller = createRevisionCoordinator({
    intervalMs: 60_000,
    readRevisions: async () => {
      const polled = { tasks: revision };
      if (presence === "inherited") Object.setPrototypeOf(polled, { permissions: "0" });
      return polled;
    },
  });
  try {
    poller.subscribe(session(), {
      evaluate: async () => {
        evaluations++;
        return {
          value: revision,
          revisions:
            stage === "initial" || evaluations > 1 ? { tasks: revision, permissions: "0" } : { tasks: revision },
        };
      },
      publish: (value) => {
        updates.push(value);
        return true;
      },
      close: (reason) => reasons.push(reason),
    });
    await poller.poll();
    if (stage === "reevaluation") {
      expect(updates).toEqual(["1"]);
      revision = "2";
      await poller.poll();
    }
    expect(reasons).toEqual(["RESYNC_REQUIRED"]);
    expect(updates).toEqual(stage === "initial" ? [] : ["1"]);
    await poller.poll();
    expect(evaluations).toBe(stage === "initial" ? 1 : 2);
  } finally {
    await poller.stop();
  }
});

test.each([
  ["poll", "absent"],
  ["poll", "inherited"],
  ["notify", "absent"],
  ["notify", "inherited"],
])("%s closes on an %s retained key without reevaluation", async (mode, presence) => {
  let polled: TableRevisions = { tasks: "1", permissions: "0" };
  let wake: (() => void) | undefined;
  let reads = 0;
  let evaluations = 0;
  const updates: string[] = [];
  const reasons: string[] = [];
  const options = {
    intervalMs: 60_000,
    readRevisions: async () => {
      reads++;
      return polled;
    },
  };
  const poller =
    mode === "notify"
      ? createRevisionCoordinator({
          ...options,
          wakeups: (notify) => {
            wake = notify;
            return { ready: Promise.resolve(), stop: async () => {} };
          },
        })
      : createRevisionCoordinator(options);
  try {
    poller.subscribe(session(), {
      evaluate: async () => {
        evaluations++;
        return { value: "authorized", revisions: { tasks: "1", permissions: "0" } };
      },
      publish: (value) => {
        updates.push(value);
        return true;
      },
      close: (reason) => reasons.push(reason),
    });
    await poller.poll();
    expect(updates).toEqual(["authorized"]);
    polled = { tasks: "1" };
    if (presence === "inherited") Object.setPrototypeOf(polled, { permissions: "0" });
    wake?.();
    await poller.poll();
    expect(reasons).toEqual(["RESYNC_REQUIRED"]);
    expect(evaluations).toBe(1);
    expect(updates).toEqual(["authorized"]);
    expect(reads).toBe(2);
  } finally {
    await poller.stop();
  }
});

test("a capture newer than the shared poll publishes and becomes the retained revision", async () => {
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<Evaluation>();
  let revision = "1";
  let evaluations = 0;
  const updates: string[] = [];
  const reasons: string[] = [];
  const poller = createRevisionCoordinator({
    intervalMs: 60_000,
    readRevisions: async () => ({ tasks: revision }),
  });
  try {
    poller.subscribe(session(), {
      evaluate: async () => {
        evaluations++;
        started.resolve();
        return finish.promise;
      },
      publish: (value) => {
        updates.push(value);
        return true;
      },
      close: (reason) => reasons.push(reason),
    });
    const cycle = poller.poll();
    await started.promise;
    revision = "2";
    finish.resolve(result("2"));
    await cycle;
    expect(updates).toEqual(["2"]);
    expect(reasons).toEqual([]);
    await poller.poll();
    expect(evaluations).toBe(1);
  } finally {
    finish.resolve(result("2"));
    await poller.stop();
  }
});

test("selective subscriptions retain independent values and replace dependencies after successful publication", async () => {
  let revisions = { selector: "1", tasks: "1", permissions: "1", unrelated: "1" };
  let reads = 0;
  const evaluations = { alice: 0, bob: 0 };
  const updates: string[] = [];
  const poller = createRevisionCoordinator({
    intervalMs: 60_000,
    readRevisions: async () => {
      reads++;
      return revisions;
    },
  });
  try {
    for (const subject of ["alice", "bob"] as const) {
      const principalSession = { ...session(), identity: { issuer: "test", subject } };
      poller.subscribe(principalSession, {
        evaluate: async () => {
          evaluations[subject]++;
          return {
            value: `${subject}:${revisions.selector}`,
            revisions:
              revisions.selector === "1"
                ? { selector: revisions.selector, tasks: revisions.tasks }
                : { selector: revisions.selector, permissions: revisions.permissions },
          };
        },
        publish: (value) => {
          updates.push(value);
          return true;
        },
        close: () => {},
      });
    }
    await poller.poll();
    revisions = { ...revisions, unrelated: "2" };
    await poller.poll();
    expect(evaluations).toEqual({ alice: 1, bob: 1 });
    revisions = { ...revisions, selector: "2" };
    await poller.poll();
    expect(evaluations).toEqual({ alice: 2, bob: 2 });
    revisions = { ...revisions, tasks: "2" };
    await poller.poll();
    expect(evaluations).toEqual({ alice: 2, bob: 2 });
    revisions = { ...revisions, permissions: "2" };
    await poller.poll();
    expect(evaluations).toEqual({ alice: 3, bob: 3 });
    expect(updates).toEqual(["alice:1", "bob:1", "alice:2", "bob:2", "alice:2", "bob:2"]);
    expect(reads).toBe(5);
  } finally {
    await poller.stop();
  }
});

test("failed publication closes the stream and later polls cannot use its captured evidence", async () => {
  let revision = "1";
  let evaluations = 0;
  const updates: string[] = [];
  const reasons: string[] = [];
  const poller = createRevisionCoordinator({
    intervalMs: 60_000,
    readRevisions: async () => ({ tasks: revision }),
  });
  try {
    poller.subscribe(session(), {
      evaluate: async () => {
        evaluations++;
        return result(revision);
      },
      publish: (value) => {
        updates.push(value);
        return value === "1";
      },
      close: (reason) => reasons.push(reason),
    });
    await poller.poll();
    revision = "2";
    await poller.poll();
    expect(reasons).toEqual(["RESYNC_REQUIRED"]);
    revision = "3";
    await poller.poll();
    expect(evaluations).toBe(2);
    expect(updates).toEqual(["1", "2"]);
  } finally {
    await poller.stop();
  }
});

test("LISTEN readiness precedes snapshots and burst wakeups reconcile an in-flight commit", async () => {
  const ready = Promise.withResolvers<void>();
  const evaluated = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<Evaluation>();
  let wake: (() => void) | undefined;
  let revision = "1";
  let reads = 0;
  let evaluations = 0;
  let listeners = 0;
  const updates: string[] = [];
  const evaluate = async () => {
    evaluations++;
    if (evaluations === 1) {
      evaluated.resolve();
      return finish.promise;
    }
    return result(revision);
  };
  const poller = createRevisionCoordinator({
    intervalMs: 60_000,
    wakeups: (notify) => {
      wake = notify;
      listeners++;
      return {
        ready: ready.promise,
        stop: async () => {
          listeners--;
        },
      };
    },
    readRevisions: async () => {
      reads++;
      return { tasks: revision };
    },
  });
  const subscription = poller.subscribe(session(), {
    evaluate,
    publish: (update) => {
      updates.push(update);
      return true;
    },
    close: () => {},
  });
  const first = poller.poll();
  await vi.waitFor(() => expect(listeners).toBe(1));
  expect(reads).toBe(0);
  ready.resolve();
  await evaluated.promise;
  revision = "2";
  for (let i = 0; i < 1000; i++) wake?.();
  finish.resolve(result("1"));
  await first;
  await vi.waitFor(() => expect(updates).toHaveLength(2));
  expect(updates[1]).toBe("2");
  expect(evaluations).toBe(2);
  expect(reads).toBe(2);
  await subscription.unsubscribe();
  await poller.stop();
  expect(listeners).toBe(0);
});

test("one poll serves all subscriptions and unchanged revisions skip evaluation", async () => {
  let reads = 0;
  let evaluations = 0;
  let revision = "1";
  const updates: string[] = [];
  const evaluate = async () => {
    evaluations++;
    return result(revision);
  };
  const poller = createRevisionCoordinator({
    intervalMs: 60_000,
    readRevisions: async () => {
      reads++;
      return { tasks: revision };
    },
  });
  const subscribe = () =>
    poller.subscribe(session(), {
      evaluate,
      publish: (update) => {
        updates.push(update);
        return true;
      },
      close: () => {},
    });
  const first = subscribe();
  const second = subscribe();
  await Promise.all([poller.poll(), poller.poll()]);
  expect(reads).toBe(1);
  expect(evaluations).toBe(2);
  await poller.poll();
  expect(evaluations).toBe(2);
  revision = "2";
  await poller.poll();
  expect(evaluations).toBe(4);
  expect(updates).toEqual(["1", "1", "2", "2"]);
  void first.unsubscribe();
  await second.unsubscribe();
  await poller.poll();
  expect(reads).toBe(3);
  await poller.stop();
});

test("continuous notification traffic cannot postpone reconciliation indefinitely", async () => {
  vi.useFakeTimers();
  let wake: (() => void) | undefined;
  let revision = "1";
  let evaluations = 0;
  const evaluate = async () => {
    evaluations++;
    return result(revision);
  };
  const poller = createRevisionCoordinator({
    intervalMs: 60_000,
    wakeups: (notify) => {
      wake = notify;
      return { ready: Promise.resolve(), stop: async () => {} };
    },
    readRevisions: async () => ({ tasks: revision }),
  });
  try {
    poller.subscribe(session(), { evaluate, publish: () => true, close: () => {} });
    await poller.poll();
    revision = "2";
    for (let i = 0; i < 20; i++) {
      wake?.();
      await vi.advanceTimersByTimeAsync(1);
    }
    expect(evaluations).toBe(2);
  } finally {
    await poller.stop();
    vi.useRealTimers();
  }
});

test("subscriptions bound concurrency, discard cancelled work and disconnect slow consumers", async () => {
  const pending = Promise.withResolvers<Evaluation>();
  const started = Promise.withResolvers<void>();
  let attempts = 0;
  let signal: AbortSignal | undefined;
  const reasons: string[] = [];
  const updates: string[] = [];
  const evaluate = async (abort: AbortSignal) => {
    attempts++;
    signal = abort;
    if (attempts === 1) {
      started.resolve();
      return pending.promise;
    }
    return result("1");
  };
  const poller = createRevisionCoordinator({
    maxSubscriptions: 2,
    concurrency: 1,
    intervalMs: 60_000,
    readRevisions: async () => ({ tasks: "1" }),
  });
  const first = poller.subscribe(session(), {
    evaluate,
    publish: (update) => {
      updates.push(update);
      return true;
    },
    close: (reason) => {
      reasons.push(reason);
    },
  });
  poller.subscribe(session(), {
    evaluate,
    publish: () => false,
    close: (reason) => {
      reasons.push(reason);
    },
  });
  expect(() => poller.subscribe(session(), { evaluate, publish: () => true, close: () => {} })).toThrow(/limit/);
  const cycle = poller.poll();
  await started.promise;
  expect(attempts).toBe(1);
  void first.unsubscribe();
  expect(signal?.aborted).toBe(true);
  pending.resolve(result("old"));
  await cycle;
  expect(updates).toEqual([]);
  expect(reasons).toEqual(["UNSUBSCRIBED", "RESYNC_REQUIRED"]);
  await poller.stop();
});

test("expiry closes a session during evaluation and polling failures require resync", async () => {
  vi.useFakeTimers();
  try {
    const pending = Promise.withResolvers<Evaluation>();
    const started = Promise.withResolvers<void>();
    const reasons: string[] = [];
    let published = 0;
    const evaluate = async () => {
      started.resolve();
      return pending.promise;
    };
    const poller = createRevisionCoordinator({
      intervalMs: 60_000,
      readRevisions: async () => ({ tasks: "1" }),
    });
    poller.subscribe(
      { ...session(), expiresAt: Math.floor(Date.now() / 1000) + 1 },
      {
        evaluate,
        publish: () => {
          published++;
          return true;
        },
        close: (reason) => {
          reasons.push(reason);
        },
      },
    );
    const cycle = poller.poll();
    await started.promise;
    await vi.advanceTimersByTimeAsync(1000);
    expect(reasons).toEqual(["AUTH_EXPIRED"]);
    pending.resolve(result("late"));
    await cycle;
    expect(published).toBe(0);
    await poller.stop();
    const broken = createRevisionCoordinator({
      readRevisions: async () => {
        throw new Error("secret");
      },
    });
    broken.subscribe(session(), {
      evaluate: async () => result("1"),
      publish: () => true,
      close: (reason) => {
        reasons.push(reason);
      },
    });
    await broken.poll();
    await broken.stop();
    expect(reasons).toEqual(["AUTH_EXPIRED", "RESYNC_REQUIRED"]);
  } finally {
    vi.useRealTimers();
  }
});

test("timer polling coalesces a slow evaluation and shutdown discards its result", async () => {
  vi.useFakeTimers();
  try {
    const pending = Promise.withResolvers<Evaluation>();
    let reads = 0;
    let evaluations = 0;
    const updates: string[] = [];
    const reasons: string[] = [];
    const evaluate = async () => {
      evaluations++;
      return evaluations === 1 ? result("1") : pending.promise;
    };
    const poller = createRevisionCoordinator({
      intervalMs: 10,
      readRevisions: async () => {
        reads++;
        return { tasks: String(reads) };
      },
    });
    poller.subscribe(session(), {
      evaluate,
      publish: (update) => {
        updates.push(update);
        return true;
      },
      close: (reason) => {
        reasons.push(reason);
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(updates).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(reads).toBe(2);
    expect(evaluations).toBe(2);
    const joined = poller.poll();
    const stopped = poller.stop();
    pending.resolve(result("late"));
    await Promise.all([joined, stopped]);
    await vi.advanceTimersByTimeAsync(100);
    expect(updates).toHaveLength(1);
    expect(reasons).toEqual(["STOPPED"]);
    expect(reads).toBe(2);
    expect(() => poller.subscribe(session(), { evaluate, publish: () => true, close: () => {} })).toThrow(/stopped/);
  } finally {
    vi.useRealTimers();
  }
});

test("a new loaded-window stream receives its first snapshot without waiting for the polling interval", async () => {
  vi.useFakeTimers();
  const values: string[] = [];
  const poller = createRevisionCoordinator({ intervalMs: 60000, readRevisions: async () => ({ tasks: "1" }) });
  const subscribe = (name: string) =>
    poller.subscribe(session(), {
      evaluate: async () => ({ value: name, revisions: { tasks: "1" } }),
      publish: (value) => {
        values.push(value);
        return true;
      },
      close: () => {},
    });
  try {
    subscribe("first");
    await vi.advanceTimersByTimeAsync(0);
    expect(values).toEqual(["first"]);
    subscribe("replacement");
    await vi.advanceTimersByTimeAsync(0);
    expect(values).toEqual(["first", "replacement"]);
  } finally {
    await poller.stop();
    vi.useRealTimers();
  }
});

test("a subscription arriving during evaluation gets a follow-up snapshot without repeating unchanged readers", async () => {
  vi.useFakeTimers();
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<Evaluation>();
  const values: string[] = [];
  let firstReads = 0;
  const poller = createRevisionCoordinator({ intervalMs: 60000, readRevisions: async () => ({ tasks: "1" }) });
  try {
    poller.subscribe(session(), {
      evaluate: async () => {
        firstReads++;
        started.resolve();
        return finish.promise;
      },
      publish: (value) => {
        values.push(value);
        return true;
      },
      close: () => {},
    });
    const initial = poller.poll();
    await started.promise;
    poller.subscribe(session(), {
      evaluate: async () => ({ value: "replacement", revisions: { tasks: "1" } }),
      publish: (value) => {
        values.push(value);
        return true;
      },
      close: () => {},
    });
    finish.resolve(result("1"));
    await initial;
    await vi.advanceTimersByTimeAsync(10);
    expect(values).toEqual(["1", "replacement"]);
    expect(firstReads).toBe(1);
  } finally {
    finish.resolve(result("1"));
    await poller.stop();
    vi.useRealTimers();
  }
});
