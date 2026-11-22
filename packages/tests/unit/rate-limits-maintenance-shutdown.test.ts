import { afterEach, expect, test, vi } from "vite-plus/test";
import type { PoolConfig } from "drizzle-orm/postgres/client/node";

interface ShutdownState {
  events: string[];
  configs: PoolConfig[];
  stage: string;
  controller: AbortController | undefined;
  entered: (() => void) | undefined;
  rejectRun: ((error: Error) => void) | undefined;
  releaseCancellation: (() => void) | undefined;
  releaseClose: (() => void) | undefined;
  failCancellation: boolean;
  failClose: boolean;
  failQuery: string | undefined;
  deferDrain: boolean;
  releaseDrain: (() => void) | undefined;
  hasMore: boolean;
  commits: number;
  lateConnect: boolean;
  releaseConnect: (() => void) | undefined;
  afterCommit: (() => void) | undefined;
  failConstructor: boolean;
  rejectConnect: boolean;
}

const state = vi.hoisted((): ShutdownState => ({
  events: [],
  configs: [],
  stage: "SHOW",
  controller: undefined,
  entered: undefined,
  rejectRun: undefined,
  releaseCancellation: undefined,
  releaseClose: undefined,
  failCancellation: false,
  failClose: false,
  failQuery: undefined,
  deferDrain: false,
  releaseDrain: undefined,
  hasMore: false,
  commits: 0,
  lateConnect: false,
  releaseConnect: undefined,
  afterCommit: undefined,
  failConstructor: false,
  rejectConnect: false,
}));

// The driver's pooled connection: a query given a signal sends a CancelRequest when it fires, and the
// query settles once the server reports the cancel. Ending the connection fails whatever is still running.
vi.mock("drizzle-orm/postgres/client/node", async (importOriginal) => {
  const original = await importOriginal<typeof import("drizzle-orm/postgres/client/node")>();
  class FakeConnection {
    inTransaction = false;
    cancelSettled: Promise<void> | undefined;
    pause(signal: AbortSignal | undefined) {
      return new Promise<never>((_resolve, reject) => {
        state.rejectRun = (error) => {
          state.events.push("run-settled");
          reject(error);
        };
        signal?.addEventListener(
          "abort",
          () => {
            state.events.push("cancel-send");
            const settled = Promise.withResolvers<void>();
            this.cancelSettled = settled.promise;
            state.releaseCancellation = () => {
              if (state.failCancellation) return;
              settled.resolve();
              state.rejectRun?.(Object.assign(new Error("canceling statement due to user request"), { code: "57014" }));
            };
          },
          { once: true },
        );
        state.entered?.();
      });
    }
    async query(text: string, _values: readonly unknown[], options: { signal?: AbortSignal }) {
      state.events.push(text.split(" ")[0]!);
      if (text.startsWith(state.failQuery ?? "\0")) throw new Error("PRIVATE_OPERATION_FAILURE");
      if (text.startsWith(state.stage)) return this.pause(options.signal);
      if (text === "SHOW server_version_num") {
        return {
          rows: [
            {
              get server_version_num() {
                // Read by the operation only after its query finally clears activeQuery.
                if (state.stage === "between") state.controller?.abort();
                return "180000";
              },
            },
          ],
          rowCount: 1,
        };
      }
      if (text.includes("nspowner")) return { rows: [{ owned: true, framework: true, migrations: true }], rowCount: 1 };
      if (text.includes("SELECT version,hash")) {
        const { frameworkMigrations } = await import("../../../apps/kello-cli/src/tooling/migrations/bootstrap");
        const rows = frameworkMigrations("kello_shutdown").map(({ version, hash }) => ({ version, hash }));
        return { rows, rowCount: rows.length };
      }
      if (text.includes(" AS now")) return { rows: [{ now: "1000" }], rowCount: 1 };
      if (text.includes(" AS has_more"))
        return { rows: [{ has_more: state.hasMore, oldest: state.hasMore ? "500" : null }], rowCount: 1 };
      if (text === "COMMIT") {
        state.commits++;
        if (state.hasMore && !state.afterCommit) state.failQuery = "DELETE";
        state.afterCommit?.();
      }
      return { rows: [], rowCount: 1 };
    }
    async end() {
      state.events.push("owner-end");
      const drain = () => state.rejectRun?.(new Error("connection terminated"));
      if (state.deferDrain) state.releaseDrain = drain;
      else drain();
      await new Promise<void>((resolve) => {
        state.releaseClose = resolve;
      });
      state.events.push("closed");
      if (state.failClose) throw new Error("PRIVATE_CLOSE_FAILURE");
    }
  }
  return {
    ...original,
    createPool: (config: PoolConfig) => {
      if (state.failConstructor) throw new Error("PRIVATE_POOL_CONSTRUCTOR_FAILURE");
      state.configs.push(config);
      let connection: FakeConnection | undefined;
      return {
        async connect() {
          state.events.push("connect");
          if (state.lateConnect) {
            await new Promise<void>((resolve) => {
              state.releaseConnect = resolve;
              state.entered?.();
            });
            state.events.push("connect-settled");
            if (state.rejectConnect) throw new Error("PRIVATE_CONNECT_FAILURE");
          } else if (state.stage === "connect") await new FakeConnection().pause(undefined);
          connection = new FakeConnection();
          return { client: connection, release: () => {} };
        },
        async end() {
          state.events.push("pool-end");
          if (state.stage === "connect") state.rejectRun?.(new Error("pool ended"));
        },
      };
    },
  };
});

import { cleanupRateLimits } from "../../../apps/kello-cli/src/tooling/migrations/rate-limits-cleanup";

const weakMapSet = Object.getOwnPropertyDescriptor(WeakMap.prototype, "set")!;

// Observe the private WeakMap write without vi.spyOn: newer Vitest records mock
// state in its own WeakMaps, so spying on WeakMap.prototype.set recurses forever.
function recordWeakMapWrites(): Array<[WeakKey, any]> {
  const calls: Array<[WeakKey, any]> = [];
  Object.defineProperty(WeakMap.prototype, "set", {
    ...weakMapSet,
    value(this: WeakMap<WeakKey, any>, ...entry: [WeakKey, any]) {
      calls.push(entry);
      const original: (this: WeakMap<WeakKey, any>, ...entry: [WeakKey, any]) => WeakMap<WeakKey, any> =
        weakMapSet.value;
      return original.call(this, ...entry);
    },
  });
  return calls;
}

function reset(stage: string): void {
  state.events = [];
  state.configs = [];
  state.stage = stage;
  state.rejectRun = state.releaseClose = state.releaseCancellation = undefined;
}

afterEach(() => {
  Object.defineProperty(WeakMap.prototype, "set", weakMapSet);
  vi.useRealTimers();
  vi.restoreAllMocks();
  state.failClose = state.deferDrain = state.hasMore = state.failCancellation = false;
  state.failQuery = state.releaseDrain = undefined;
  state.lateConnect = state.failConstructor = state.rejectConnect = false;
  state.releaseConnect = state.afterCommit = undefined;
  state.commits = 0;
});

test.each([
  ["abort", "SHOW"],
  ["abort", "BEGIN"],
  ["abort", "COMMIT"],
  ["deadline", "SHOW"],
  ["abort", "connect"],
] as const)("%s during %s cancels in flight, then awaits the owned close", async (reason, stage) => {
  reset(stage);
  const controller = new AbortController();
  const entered = Promise.withResolvers<void>();
  state.entered = entered.resolve;
  let settled = false;
  let failure: unknown;
  const outcome = cleanupRateLimits({
    connectionString: "postgresql://unused.invalid/db",
    metadataNamespace: "kello_shutdown",
    signal: controller.signal,
    maxDurationMs: 1000,
  }).then(
    () => {
      settled = true;
      return "success";
    },
    (error) => {
      settled = true;
      failure = error;
      return error.message;
    },
  );
  await entered.promise;
  if (reason === "deadline") {
    // Useful work stops early to reserve cancellation inside the run budget.
    await vi.waitFor(() => expect(state.events).toContain("cancel-send"));
    controller.abort(); // A second stop joins the watchdog's existing shutdown.
  } else controller.abort();
  if (stage !== "connect") {
    await vi.waitFor(() => expect(state.events).toContain("cancel-send"));
    // The session stays open until its cancel settles.
    expect(state.events).not.toContain("owner-end");
    state.releaseCancellation!();
    await vi.waitFor(() => expect(state.events).toContain("owner-end"));
    expect(settled).toBe(false);
    state.releaseClose!();
  } else {
    await vi.waitFor(() => expect(state.events).toContain("pool-end"));
    expect(state.events).not.toContain("cancel-send");
  }
  expect(await outcome).toBe("Rate limit cleanup failed");
  expect(failure).toMatchObject({ removed: 0, batches: 0 });
  expect(state.events.filter((event) => event === "cancel-send")).toHaveLength(stage === "connect" ? 0 : 1);
  expect(state.events.filter((event) => event === "pool-end")).toHaveLength(1);
  expect(state.events).toContain("run-settled");
});

test("abort between queries issues no next query or cancellation", async () => {
  reset("between");
  state.controller = new AbortController();
  const outcome = cleanupRateLimits({
    connectionString: "postgresql://unused.invalid/db",
    metadataNamespace: "kello_shutdown",
    signal: state.controller.signal,
  }).catch((error) => error.message);
  await vi.waitFor(() => expect(state.events).toContain("owner-end"));
  state.releaseClose!();
  expect(await outcome).toBe("Rate limit cleanup failed");
  expect(state.events).not.toContain("SELECT");
  expect(state.events).not.toContain("cancel-send");
  state.controller = undefined;
});

test("already aborted invocation closes without connecting", async () => {
  reset("SHOW");
  const controller = new AbortController();
  controller.abort();
  const outcome = cleanupRateLimits({
    connectionString: "postgresql://unused.invalid/db",
    metadataNamespace: "kello_shutdown",
    signal: controller.signal,
  }).catch((error) => error.message);
  expect(await outcome).toBe("Rate limit cleanup failed");
  expect(state.events).toEqual(["pool-end"]);
});

test("one dedicated session with fixed timeouts and pg_catalog search path", async () => {
  reset("none");
  const outcome = cleanupRateLimits({
    connectionString: "postgresql://migrator@ep-fixture.eu.neon.tech/db?sslmode=require",
    metadataNamespace: "kello_shutdown",
  });
  await vi.waitFor(() => expect(state.events).toContain("owner-end"));
  state.releaseClose!();
  await outcome;
  expect(state.configs).toHaveLength(1);
  expect(state.configs[0]).toMatchObject({
    max: 1,
    reconnect: false,
    ssl: "verify-full",
    applicationName: "kello-rate-limits-cleanup",
  });
  expect(state.configs[0]?.options).toMatch(/^-c search_path=pg_catalog -c statement_timeout=\d+ -c lock_timeout=\d+$/);
});

test("a Neon URL that disables TLS is refused before any connection work", async () => {
  reset("none");
  const error = await cleanupRateLimits({
    connectionString: "postgresql://migrator@ep-fixture.eu.neon.tech/db?sslmode=disable",
    metadataNamespace: "kello_shutdown",
  }).catch((error) => error);
  expect(error).toMatchObject({ message: "Rate limit cleanup failed", removed: 0, batches: 0 });
  expect(state.configs).toEqual([]);
  expect(state.events).toEqual([]);
});

test("successful result also awaits owned close settlement", async () => {
  reset("none");
  let settled = false;
  const outcome = cleanupRateLimits({
    connectionString: "postgresql://unused.invalid/db",
    metadataNamespace: "kello_shutdown",
  }).then((result) => {
    settled = true;
    return result;
  });
  await vi.waitFor(() => expect(state.events).toContain("owner-end"));
  expect(settled).toBe(false);
  expect(state.events).not.toContain("cancel-send");
  state.releaseClose!();
  expect(await outcome).toMatchObject({ removed: 1, batches: 1, hasMore: false });
  expect(state.events.at(-1)).toBe("pool-end");
});

test("cancellation consumes only the remaining run budget before owned close", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"] });
  reset("SHOW");
  state.failCancellation = true;
  const entered = Promise.withResolvers<void>();
  state.entered = entered.resolve;
  const controller = new AbortController();
  let settled = false;
  const outcome = cleanupRateLimits({
    connectionString: "postgresql://unused.invalid/db",
    metadataNamespace: "kello_shutdown",
    signal: controller.signal,
    maxDurationMs: 1000,
  }).then(
    () => {
      settled = true;
      return "success";
    },
    (error) => {
      settled = true;
      return error.message;
    },
  );
  await entered.promise;
  await vi.advanceTimersByTimeAsync(400);
  controller.abort();
  await vi.advanceTimersByTimeAsync(0);
  expect(state.events).toContain("cancel-send");
  state.releaseCancellation!(); // The server never acknowledges this cancel.
  await vi.advanceTimersByTimeAsync(549);
  expect(state.events).not.toContain("owner-end");
  await vi.advanceTimersByTimeAsync(1);
  expect(state.events).toContain("owner-end");
  expect(settled).toBe(false);
  state.releaseClose!();
  await vi.advanceTimersByTimeAsync(0);
  expect(await outcome).toBe("Rate limit cleanup failed");
  expect(performance.now()).toBe(950);
  expect(state.events.filter((event) => event === "cancel-send")).toHaveLength(1);
  expect(state.events.filter((event) => event === "owner-end")).toHaveLength(1);
});

test.each(["deadline", "abort"] as const)(
  "%s during successful close rejects after owned settlement",
  async (reason) => {
    reset("none");
    const controller = new AbortController();
    let settled = false;
    const outcome = cleanupRateLimits({
      connectionString: "postgresql://unused.invalid/db",
      metadataNamespace: "kello_shutdown",
      signal: controller.signal,
      maxDurationMs: 1000,
    }).then(
      () => {
        settled = true;
        return "success";
      },
      (error) => {
        settled = true;
        return error.message;
      },
    );
    await vi.waitFor(() => expect(state.events).toContain("owner-end"));
    if (reason === "deadline") await new Promise((resolve) => setTimeout(resolve, 1050));
    else controller.abort();
    expect(settled).toBe(false);
    state.releaseClose!();
    expect(await outcome).toBe("Rate limit cleanup failed");
    expect(state.events.filter((event) => event === "owner-end")).toHaveLength(1);
    expect(state.events).not.toContain("cancel-send");
  },
);

test("late close cannot succeed even before the deadline watchdog gets a turn", async () => {
  reset("none");
  const started = performance.now();
  const outcome = cleanupRateLimits({
    connectionString: "postgresql://unused.invalid/db",
    metadataNamespace: "kello_shutdown",
    maxDurationMs: 1000,
  }).then(
    () => "success",
    (error) => error.message,
  );
  await vi.waitFor(() => expect(state.events).toContain("owner-end"));
  // Model time passing while callbacks cannot run; settle close in a microtask
  // before the timeout callback. Success needs its own absolute-clock check.
  vi.spyOn(performance, "now").mockReturnValue(started + 2000);
  state.releaseClose!();
  expect(await outcome).toBe("Rate limit cleanup failed");
});

test.each([false, true])("confirmed batches survive operation failure and close failure (%s)", async (failClose) => {
  reset("none");
  state.hasMore = true;
  state.failClose = failClose;
  const outcome = cleanupRateLimits({
    connectionString: "postgresql://unused.invalid/db",
    metadataNamespace: "kello_shutdown",
  }).then(
    () => undefined,
    (error) => error,
  );
  await vi.waitFor(() => expect(state.events).toContain("owner-end"));
  expect(state.commits).toBe(1);
  state.releaseClose!();
  const error = await outcome;
  expect(error).toMatchObject({ message: "Rate limit cleanup failed", removed: 1, batches: 1 });
  expect(JSON.stringify(error)).not.toMatch(/PRIVATE_|unused|kello_shutdown/);
  expect(error.cause).toBeUndefined();
  expect(state.events.filter((event) => event === "owner-end")).toHaveLength(1);
});

test("close failure rejects a completed run and retains confirmed commits", async () => {
  reset("none");
  state.failClose = true;
  const outcome = cleanupRateLimits({
    connectionString: "postgresql://unused.invalid/db",
    metadataNamespace: "kello_shutdown",
  }).then(
    () => undefined,
    (error) => error,
  );
  await vi.waitFor(() => expect(state.events).toContain("owner-end"));
  state.releaseClose!();
  expect(await outcome).toMatchObject({ message: "Rate limit cleanup failed", removed: 1, batches: 1 });
});

test("one shutdown joins query drain even when cancellation and close fail", async () => {
  reset("SHOW");
  state.failCancellation = state.failClose = state.deferDrain = true;
  const entered = Promise.withResolvers<void>();
  state.entered = entered.resolve;
  const controller = new AbortController();
  let settled = false;
  const outcome = cleanupRateLimits({
    connectionString: "postgresql://unused.invalid/db",
    metadataNamespace: "kello_shutdown",
    signal: controller.signal,
    maxDurationMs: 1000,
  }).then(
    () => {
      settled = true;
      return undefined;
    },
    (error) => {
      settled = true;
      return error;
    },
  );
  await entered.promise;
  controller.abort(new Error("PRIVATE_ABORT_FAILURE"));
  await vi.waitFor(() => expect(state.events).toContain("cancel-send"));
  state.releaseCancellation!();
  await vi.waitFor(() => expect(state.events).toContain("owner-end"));
  state.releaseClose!();
  await vi.waitFor(() => expect(state.events).toContain("closed"));
  expect(settled).toBe(false);
  state.releaseDrain!();
  const error = await outcome;
  expect(error).toMatchObject({ message: "Rate limit cleanup failed", removed: 0, batches: 0 });
  expect(JSON.stringify(error)).not.toMatch(/PRIVATE_/);
  expect(state.events.filter((event) => event === "owner-end")).toHaveLength(1);
  expect(state.events.filter((event) => event === "cancel-send")).toHaveLength(1);
});

test("late successful connect is closed without issuing SQL", async () => {
  reset("none");
  state.lateConnect = true;
  const entered = Promise.withResolvers<void>();
  state.entered = entered.resolve;
  const controller = new AbortController();
  let settled = false;
  const outcome = cleanupRateLimits({
    connectionString: "postgresql://unused.invalid/db",
    metadataNamespace: "kello_shutdown",
    signal: controller.signal,
  }).then(
    () => {
      settled = true;
      return undefined;
    },
    (error) => {
      settled = true;
      return error;
    },
  );
  await entered.promise;
  controller.abort();
  await vi.waitFor(() => expect(state.events).toContain("pool-end"));
  expect(settled).toBe(false);
  state.releaseConnect!();
  await vi.waitFor(() => expect(state.events).toContain("owner-end"));
  expect(state.events).not.toContain("SHOW");
  expect(settled).toBe(false);
  state.releaseClose!();
  expect(await outcome).toMatchObject({ message: "Rate limit cleanup failed", removed: 0, batches: 0 });
  expect(state.events.filter((event) => event === "owner-end")).toHaveLength(1);
});

test("a fulfilled late COMMIT is counted but cannot produce success or another batch", async () => {
  reset("none");
  const started = performance.now();
  state.hasMore = true;
  state.afterCommit = () => {
    vi.spyOn(performance, "now").mockReturnValue(started + 2000);
  };
  const outcome = cleanupRateLimits({
    connectionString: "postgresql://unused.invalid/db",
    metadataNamespace: "kello_shutdown",
    maxDurationMs: 1000,
  }).then(
    () => undefined,
    (error) => error,
  );
  await vi.waitFor(() => expect(state.events).toContain("owner-end"));
  state.releaseClose!();
  expect(await outcome).toMatchObject({ message: "Rate limit cleanup failed", removed: 1, batches: 1 });
  expect(state.events.filter((event) => event === "BEGIN")).toHaveLength(1);
  expect(state.events).not.toContain("cancel-send");
});

test("voluntary time-budget stop succeeds only after close within the deadline", async () => {
  reset("none");
  const started = performance.now();
  state.hasMore = true;
  state.afterCommit = () => {
    vi.spyOn(performance, "now").mockReturnValue(started + 420);
  };
  let settled = false;
  const outcome = cleanupRateLimits({
    connectionString: "postgresql://unused.invalid/db",
    metadataNamespace: "kello_shutdown",
    maxDurationMs: 1000,
  }).then((result) => {
    settled = true;
    return result;
  });
  await vi.waitFor(() => expect(state.events).toContain("owner-end"));
  expect(settled).toBe(false);
  state.releaseClose!();
  expect(await outcome).toMatchObject({ removed: 1, batches: 1, hasMore: true, stoppedBy: "time-budget" });
  expect(state.events.filter((event) => event === "BEGIN")).toHaveLength(1);
});

test("pool construction failure is redacted before any connection work", async () => {
  reset("none");
  state.failConstructor = true;
  const error = await cleanupRateLimits({
    connectionString: "postgresql://unused.invalid/db",
    metadataNamespace: "kello_shutdown",
  }).then(
    () => undefined,
    (error) => error,
  );
  expect(error).toMatchObject({ message: "Rate limit cleanup failed", removed: 0, batches: 0 });
  expect(JSON.stringify(error)).not.toMatch(/PRIVATE_/);
  expect(error.cause).toBeUndefined();
  expect(state.events).toEqual([]);
});

test.each([new Error("PRIVATE_ABORT_INITIATOR"), null, false, 0, ""])(
  "initiating abort %s stays primary across cancellation, close and query-drain failures",
  async (reason) => {
    // Observe the existing private WeakMap write, without exporting raw diagnostics.
    const records = recordWeakMapWrites();
    reset("SHOW");
    state.failCancellation = state.failClose = true;
    const entered = Promise.withResolvers<void>();
    state.entered = entered.resolve;
    const controller = new AbortController();
    const outcome = cleanupRateLimits({
      connectionString: "postgresql://unused.invalid/db",
      metadataNamespace: "kello_shutdown",
      signal: controller.signal,
      maxDurationMs: 1000,
    }).catch((error) => error);
    await entered.promise;
    controller.abort(reason);
    await vi.waitFor(() => expect(state.events).toContain("cancel-send"));
    state.releaseCancellation!();
    await vi.waitFor(() => expect(state.events).toContain("owner-end"), { timeout: 2000 });
    state.releaseClose!();
    const error = await outcome;
    const details = records.find(([key]) => key === error)?.[1];
    expect(details).toMatchObject({ primary: { error: reason } });
    expect(details.cleanup).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ phase: "cancel" }),
        expect.objectContaining({
          phase: "query-drain",
          error: expect.objectContaining({ message: "connection terminated" }),
        }),
        expect.objectContaining({
          phase: "close",
          error: expect.objectContaining({ message: "PRIVATE_CLOSE_FAILURE" }),
        }),
      ]),
    );
    expect(error.cause).toBeUndefined();
    expect(JSON.stringify(error)).toBe('{"removed":0,"batches":0}');
  },
);

test.each(["work-cutoff", "absolute-deadline", "late-connect"] as const)(
  "%s keeps its initiating failure before shutdown consequences",
  async (path) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"] });
    const records = recordWeakMapWrites();
    reset(path === "late-connect" ? "none" : "SHOW");
    state.lateConnect = state.rejectConnect = path === "late-connect";
    state.failClose = true;
    const entered = Promise.withResolvers<void>();
    state.entered = entered.resolve;
    const controller = new AbortController();
    const reason = new Error("PRIVATE_CONNECT_ABORT");
    const outcome = cleanupRateLimits({
      connectionString: "postgresql://unused.invalid/db",
      metadataNamespace: "kello_shutdown",
      signal: controller.signal,
      maxDurationMs: 1000,
    }).catch((error) => error);
    await entered.promise;
    if (path === "late-connect") controller.abort(reason);
    else if (path === "absolute-deadline") {
      // Both watchdogs are overdue: clock expiry must win over callback order.
      vi.spyOn(performance, "now").mockReturnValue(1100);
      await vi.advanceTimersByTimeAsync(450);
    } else await vi.advanceTimersByTimeAsync(450);
    await vi.advanceTimersByTimeAsync(0);
    if (path === "late-connect") state.releaseConnect!();
    else state.releaseCancellation?.();
    await vi.advanceTimersByTimeAsync(0);
    state.releaseClose?.();
    await vi.advanceTimersByTimeAsync(0);
    const error = await outcome;
    const details = records.find(([key]) => key === error)?.[1];
    expect(details.primary.error).toEqual(path === "late-connect" ? reason : new Error("Rate limit cleanup failed"));
    if (path === "late-connect") {
      expect(details.cleanup).toEqual([
        expect.objectContaining({
          phase: "connect-drain",
          error: expect.objectContaining({ message: "PRIVATE_CONNECT_FAILURE" }),
        }),
      ]);
      expect(state.events).not.toContain("SHOW");
    } else
      expect(details.cleanup).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            phase: "close",
            error: expect.objectContaining({ message: "PRIVATE_CLOSE_FAILURE" }),
          }),
        ]),
      );
  },
);

test("an earlier SQL failure remains primary when abort and close fail later", async () => {
  const records = recordWeakMapWrites();
  reset("none");
  state.failQuery = "SHOW";
  state.failClose = true;
  const controller = new AbortController();
  const outcome = cleanupRateLimits({
    connectionString: "postgresql://unused.invalid/db",
    metadataNamespace: "kello_shutdown",
    signal: controller.signal,
  }).catch((error) => error);
  await vi.waitFor(() => expect(state.events).toContain("owner-end"));
  controller.abort(new Error("PRIVATE_LATER_ABORT"));
  state.releaseClose!();
  const error = await outcome;
  const details = records.find(([key]) => key === error)?.[1];
  expect(details.primary.error.message).toBe("PRIVATE_OPERATION_FAILURE");
  expect(details.cleanup).toEqual([
    expect.objectContaining({ phase: "close", error: expect.objectContaining({ message: "PRIVATE_CLOSE_FAILURE" }) }),
  ]);
});
