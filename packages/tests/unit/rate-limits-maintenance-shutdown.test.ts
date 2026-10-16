import { afterEach, expect, test, vi } from "vite-plus/test";

interface ShutdownState {
  events: string[];
  ssl: boolean | object;
  negotiation: string;
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
  reenterOnDestroy: boolean;
  failConstructor: boolean;
  transportConnectDelay: number;
  throwCancelDestroy: boolean;
  reenterCancelDestroy: boolean;
  throwCancelSend: boolean;
  rejectConnect: boolean;
}

const state = vi.hoisted((): ShutdownState => ({
  events: [],
  ssl: false,
  negotiation: "postgres",
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
  reenterOnDestroy: false,
  failConstructor: false,
  transportConnectDelay: 0,
  throwCancelDestroy: false,
  reenterCancelDestroy: false,
  throwCancelSend: false,
  rejectConnect: false,
}));

vi.mock("pg", async () => {
  const { EventEmitter } = await import("node:events");
  class Connection extends EventEmitter {
    constructor(config: { ssl: unknown; sslNegotiation: string }) {
      super();
      expect(config.ssl).toBe(state.ssl);
      expect(config.sslNegotiation).toBe(state.negotiation);
    }
    stream = {
      destroy: () => {
        state.events.push("cancel-close");
        if (state.reenterCancelDestroy) this.emit("error", new Error("PRIVATE_REENTRANT_CANCEL"));
        if (state.throwCancelDestroy) throw new Error("PRIVATE_CANCEL_DESTROY");
      },
    };
    connect() {
      state.events.push("cancel-connect");
      const establish = () => {
        this.emit("connect");
        if (state.ssl && state.negotiation === "direct") this.emit("sslconnect");
      };
      if (state.transportConnectDelay) setTimeout(establish, state.transportConnectDelay);
      else queueMicrotask(establish);
    }
    requestSsl() {
      state.events.push("ssl-request");
      this.emit("sslconnect");
    }
    cancel(processID: number, secretKey: number) {
      expect([processID, secretKey]).toEqual([123, 456]);
      state.events.push("cancel-send");
      if (state.throwCancelSend) throw new Error("PRIVATE_CANCEL_SEND");
      state.releaseCancellation = () => this.emit(state.failCancellation ? "error" : "end", new Error("private"));
    }
  }
  class Client extends EventEmitter {
    constructor() {
      super();
      if (state.failConstructor) throw new Error("PRIVATE_CLIENT_CONSTRUCTOR_FAILURE");
    }
    host = "unused.invalid";
    port = 5432;
    processID = 123;
    secretKey = 456;
    connection = {
      ssl: state.ssl,
      sslNegotiation: state.negotiation,
      stream: {
        destroy: () => {
          state.events.push("owner-destroy");
          if (state.reenterOnDestroy) this.emit("error", new Error("PRIVATE_IDLE_ERROR"));
          const drain = () => state.rejectRun?.(new Error("connection terminated"));
          if (state.deferDrain) state.releaseDrain = drain;
          else drain();
        },
      },
    };
    async connect() {
      state.events.push("connect");
      if (state.lateConnect) {
        await new Promise<void>((resolve) => {
          state.releaseConnect = resolve;
          state.entered?.();
        });
        state.events.push("connect-settled");
        if (state.rejectConnect) throw new Error("PRIVATE_CONNECT_FAILURE");
        return;
      }
      if (state.stage === "connect") await this.pause();
    }
    pause() {
      return new Promise<never>((_resolve, reject) => {
        state.rejectRun = (error) => {
          state.events.push("run-settled");
          reject(error);
        };
        state.entered?.();
      });
    }
    async query(text: string) {
      state.events.push(text.split(" ")[0]!);
      if (text.startsWith(state.failQuery ?? "\0")) throw new Error("PRIVATE_OPERATION_FAILURE");
      if (text.startsWith(state.stage)) return this.pause();
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
        };
      }
      if (text.includes("nspowner")) return { rows: [{ owned: true, framework: true, migrations: true }] };
      if (text.includes("SELECT version,hash")) {
        const { frameworkMigrations } = await import("../../../apps/kello/src/tooling/migrations/bootstrap");
        return { rows: frameworkMigrations("loom_shutdown").map(({ version, hash }) => ({ version, hash })) };
      }
      if (text.includes(" AS now")) return { rows: [{ now: "1000" }] };
      if (text.includes(" AS has_more"))
        return { rows: [{ has_more: state.hasMore, oldest: state.hasMore ? "500" : null }] };
      if (text === "COMMIT") {
        state.commits++;
        if (state.hasMore && !state.afterCommit) state.failQuery = "DELETE";
        state.afterCommit?.();
      }
      return { rows: [], rowCount: 1 };
    }
    async end() {
      state.events.push("owner-end");
      if (!state.deferDrain) state.rejectRun?.(new Error("connection terminated"));
      await new Promise<void>((resolve) => {
        state.releaseClose = resolve;
      });
      state.events.push("closed");
      if (state.failClose) throw new Error("PRIVATE_CLOSE_FAILURE");
    }
  }
  return { default: { Client, Connection } };
});

import { cleanupRateLimits } from "../../../apps/kello/src/tooling/migrations/rate-limits-cleanup";
import { cancelDatabaseStatement } from "../../../apps/kello/src/core/server/database/cancel";
import pg from "pg";

function repeatCancellationEvent(): void {
  state.releaseCancellation?.();
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  state.failClose = state.deferDrain = state.hasMore = false;
  state.failQuery = state.releaseDrain = undefined;
  state.lateConnect = state.reenterOnDestroy = false;
  state.failConstructor = false;
  state.transportConnectDelay = 0;
  state.throwCancelDestroy = state.reenterCancelDestroy = state.throwCancelSend = state.rejectConnect = false;
  state.releaseConnect = state.afterCommit = undefined;
  state.commits = 0;
});

test.each([
  ["abort", "SHOW", false, "postgres", false],
  ["abort", "BEGIN", true, "postgres", false],
  ["abort", "COMMIT", true, "direct", false],
  ["deadline", "SHOW", true, "postgres", false],
  ["abort", "SHOW", true, "postgres", true],
  ["abort", "connect", false, "postgres", false],
] as const)(
  "%s during %s uses owned cancellation then awaits close (%s/%s/failure=%s)",
  async (reason, stage, ssl, negotiation, failCancellation) => {
    state.events = [];
    state.stage = stage;
    state.ssl = ssl ? { rejectUnauthorized: true } : false;
    state.negotiation = negotiation;
    state.failCancellation = failCancellation;
    state.releaseCancellation = state.releaseClose = state.rejectRun = undefined;
    const controller = new AbortController();
    const entered = Promise.withResolvers<void>();
    state.entered = entered.resolve;
    const pending = cleanupRateLimits({
      connectionString: "postgresql://unused.invalid/db",
      metadataNamespace: "loom_shutdown",
      signal: controller.signal,
      maxDurationMs: 1000,
    });
    let settled = false;
    let failure: unknown;
    const outcome = pending.then(
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
    await vi.waitFor(() => expect(state.events).toContain(stage === "connect" ? "owner-end" : "cancel-send"));
    if (stage !== "connect") {
      expect(state.events).not.toContain("owner-end");
      expect(state.events).not.toContain("owner-destroy");
      expect(state.events.includes("ssl-request")).toBe(ssl && negotiation === "postgres");
      state.releaseCancellation!();
      await vi.waitFor(() => expect(state.events).toContain("owner-end"));
    } else expect(state.events).not.toContain("cancel-connect");
    expect(settled).toBe(false);
    state.releaseClose!();
    expect(await outcome).toBe("Rate limit cleanup failed");
    expect(failure).toMatchObject({ removed: 0, batches: 0 });
    expect(state.events.filter((event) => event === "owner-end")).toHaveLength(1);
    expect(state.events.filter((event) => event === "cancel-send")).toHaveLength(stage === "connect" ? 0 : 1);
    expect(state.events).toContain("run-settled");
    expect(state.events.at(-1)).toBe("closed");
  },
);

test("abort between queries issues no next query or cancellation", async () => {
  state.events = [];
  state.stage = "between";
  state.rejectRun = state.releaseClose = state.releaseCancellation = undefined;
  state.controller = new AbortController();
  const outcome = cleanupRateLimits({
    connectionString: "postgresql://unused.invalid/db",
    metadataNamespace: "loom_shutdown",
    signal: state.controller.signal,
  }).catch((error) => error.message);
  await vi.waitFor(() => expect(state.events).toContain("owner-end"));
  state.releaseClose!();
  expect(await outcome).toBe("Rate limit cleanup failed");
  expect(state.events).not.toContain("SELECT");
  expect(state.events).not.toContain("cancel-connect");
  state.controller = undefined;
});

test("already aborted invocation closes without connecting", async () => {
  state.events = [];
  state.rejectRun = state.releaseClose = state.releaseCancellation = undefined;
  const controller = new AbortController();
  controller.abort();
  const outcome = cleanupRateLimits({
    connectionString: "postgresql://unused.invalid/db",
    metadataNamespace: "loom_shutdown",
    signal: controller.signal,
  }).catch((error) => error.message);
  await vi.waitFor(() => expect(state.events).toContain("owner-end"));
  state.releaseClose!();
  expect(await outcome).toBe("Rate limit cleanup failed");
  expect(state.events).toEqual(["owner-end", "owner-destroy", "closed"]);
});

test("successful result also awaits owned close settlement", async () => {
  state.events = [];
  state.stage = "none";
  state.rejectRun = state.releaseClose = state.releaseCancellation = undefined;
  let settled = false;
  const pending = cleanupRateLimits({
    connectionString: "postgresql://unused.invalid/db",
    metadataNamespace: "loom_shutdown",
  });
  const outcome = pending.then((result) => {
    settled = true;
    return result;
  });
  await vi.waitFor(() => expect(state.events).toContain("owner-end"));
  expect(settled).toBe(false);
  expect(state.events).not.toContain("cancel-connect");
  state.releaseClose!();
  expect(await outcome).toMatchObject({ removed: 1, batches: 1, hasMore: false });
  expect(state.events.at(-1)).toBe("closed");
});

test("cancellation consumes only the remaining run budget before owned close", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  state.events = [];
  state.stage = "SHOW";
  state.ssl = false;
  state.negotiation = "postgres";
  state.failCancellation = false;
  state.rejectRun = state.releaseClose = state.releaseCancellation = undefined;
  const entered = Promise.withResolvers<void>();
  state.entered = entered.resolve;
  const controller = new AbortController();
  let settled = false;
  const outcome = cleanupRateLimits({
    connectionString: "postgresql://unused.invalid/db",
    metadataNamespace: "loom_shutdown",
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
  await vi.advanceTimersByTimeAsync(549);
  expect(state.events).not.toContain("owner-end");
  expect(state.events).not.toContain("owner-destroy");
  await vi.advanceTimersByTimeAsync(1);
  expect(state.events).toContain("cancel-close");
  expect(state.events).toContain("owner-end");
  expect(state.events.indexOf("cancel-close")).toBeLessThan(state.events.indexOf("owner-destroy"));
  expect(settled).toBe(false);
  state.releaseClose!();
  expect(await outcome).toBe("Rate limit cleanup failed");
  expect(performance.now()).toBe(950);
  expect(state.events.filter((event) => event === "cancel-connect")).toHaveLength(1);
  expect(state.events.filter((event) => event === "owner-end")).toHaveLength(1);
  expect(state.events.at(-1)).toBe("closed");
});

test.each([undefined, 100, 5000])(
  "shared cancellation preserves/caps its transport budget (%s)",
  async (maxDurationMs) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    state.events = [];
    state.ssl = false;
    state.negotiation = "postgres";
    state.failCancellation = false;
    const expected = Math.min(maxDurationMs ?? 2000, 2000);
    let settled = false;
    const outcome = cancelDatabaseStatement(new pg.Client(), maxDurationMs).then(
      () => {
        settled = true;
        return "success";
      },
      (error) => {
        settled = true;
        return error.message;
      },
    );
    await vi.advanceTimersByTimeAsync(expected - 1);
    expect(state.events).toContain("cancel-send");
    expect(state.events).not.toContain("cancel-close");
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toBe("PostgreSQL cancellation transport failed");
    expect(state.events.at(-1)).toBe("cancel-close");
  },
);

test.each(["deadline", "abort"] as const)(
  "%s during successful close rejects after owned settlement",
  async (reason) => {
    state.events = [];
    state.stage = "none";
    state.rejectRun = state.releaseClose = state.releaseCancellation = undefined;
    const controller = new AbortController();
    let settled = false;
    const outcome = cleanupRateLimits({
      connectionString: "postgresql://unused.invalid/db",
      metadataNamespace: "loom_shutdown",
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
    expect(state.events).not.toContain("cancel-connect");
    expect(state.events.at(-1)).toBe("closed");
  },
);

test("late close cannot succeed even before the deadline watchdog gets a turn", async () => {
  state.events = [];
  state.stage = "none";
  state.rejectRun = state.releaseClose = state.releaseCancellation = undefined;
  const started = performance.now();
  const outcome = cleanupRateLimits({
    connectionString: "postgresql://unused.invalid/db",
    metadataNamespace: "loom_shutdown",
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
  expect(state.events.at(-1)).toBe("closed");
});

test.each([false, true])("confirmed batches survive operation failure and close failure (%s)", async (failClose) => {
  state.events = [];
  state.stage = "none";
  state.rejectRun = state.releaseClose = state.releaseCancellation = undefined;
  state.hasMore = true;
  state.failClose = failClose;
  const outcome = cleanupRateLimits({
    connectionString: "postgresql://unused.invalid/db",
    metadataNamespace: "loom_shutdown",
  }).then(
    () => undefined,
    (error) => error,
  );
  await vi.waitFor(() => expect(state.events).toContain("owner-end"));
  expect(state.commits).toBe(1);
  state.releaseClose!();
  const error = await outcome;
  expect(error).toMatchObject({ message: "Rate limit cleanup failed", removed: 1, batches: 1 });
  expect(JSON.stringify(error)).not.toMatch(/PRIVATE_|unused|loom_shutdown/);
  expect(error.cause).toBeUndefined();
  expect(state.events.filter((event) => event === "owner-end")).toHaveLength(1);
});

test("close failure rejects a completed run and retains confirmed commits", async () => {
  state.events = [];
  state.stage = "none";
  state.rejectRun = state.releaseClose = state.releaseCancellation = undefined;
  state.failClose = true;
  const outcome = cleanupRateLimits({
    connectionString: "postgresql://unused.invalid/db",
    metadataNamespace: "loom_shutdown",
  }).then(
    () => undefined,
    (error) => error,
  );
  await vi.waitFor(() => expect(state.events).toContain("owner-end"));
  state.releaseClose!();
  expect(await outcome).toMatchObject({ message: "Rate limit cleanup failed", removed: 1, batches: 1 });
});

test("one shutdown joins query drain even when cancellation and close fail", async () => {
  state.events = [];
  state.stage = "SHOW";
  state.ssl = false;
  state.negotiation = "postgres";
  state.failCancellation = state.failClose = state.deferDrain = true;
  state.rejectRun = state.releaseClose = state.releaseCancellation = undefined;
  const entered = Promise.withResolvers<void>();
  state.entered = entered.resolve;
  const controller = new AbortController();
  let settled = false;
  const outcome = cleanupRateLimits({
    connectionString: "postgresql://unused.invalid/db",
    metadataNamespace: "loom_shutdown",
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
  controller.abort(new Error("PRIVATE_ABORT_FAILURE"));
  await vi.waitFor(() => expect(state.events).toContain("cancel-send"));
  expect(state.events).not.toContain("owner-destroy");
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

test("late successful connect is drained and closed without issuing SQL", async () => {
  state.events = [];
  state.stage = "none";
  state.rejectRun = state.releaseClose = state.releaseCancellation = undefined;
  state.lateConnect = true;
  const entered = Promise.withResolvers<void>();
  state.entered = entered.resolve;
  const controller = new AbortController();
  let settled = false;
  const outcome = cleanupRateLimits({
    connectionString: "postgresql://unused.invalid/db",
    metadataNamespace: "loom_shutdown",
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
  await vi.waitFor(() => expect(state.events).toContain("owner-destroy"));
  expect(state.events).not.toContain("owner-end");
  expect(settled).toBe(false);
  state.releaseConnect!();
  await vi.waitFor(() => expect(state.events).toContain("owner-end"));
  expect(state.events).not.toContain("SHOW");
  expect(state.events).not.toContain("cancel-connect");
  expect(settled).toBe(false);
  state.releaseClose!();
  expect(await outcome).toMatchObject({ message: "Rate limit cleanup failed", removed: 0, batches: 0 });
  expect(state.events.filter((event) => event === "owner-end")).toHaveLength(1);
});

test("reentrant driver failure during close joins one shutdown", async () => {
  state.events = [];
  state.stage = "none";
  state.rejectRun = state.releaseClose = state.releaseCancellation = undefined;
  state.reenterOnDestroy = true;
  const outcome = cleanupRateLimits({
    connectionString: "postgresql://unused.invalid/db",
    metadataNamespace: "loom_shutdown",
  }).then(
    () => undefined,
    (error) => error,
  );
  await vi.waitFor(() => expect(state.events).toContain("owner-end"));
  state.releaseClose!();
  expect(await outcome).toMatchObject({ message: "Rate limit cleanup failed", removed: 1, batches: 1 });
  expect(state.events.filter((event) => event === "owner-end")).toHaveLength(1);
});

test("a fulfilled late COMMIT is counted but cannot produce success or another batch", async () => {
  state.events = [];
  state.stage = "none";
  state.rejectRun = state.releaseClose = state.releaseCancellation = undefined;
  const started = performance.now();
  state.hasMore = true;
  state.afterCommit = () => {
    vi.spyOn(performance, "now").mockReturnValue(started + 2000);
  };
  const outcome = cleanupRateLimits({
    connectionString: "postgresql://unused.invalid/db",
    metadataNamespace: "loom_shutdown",
    maxDurationMs: 1000,
  }).then(
    () => undefined,
    (error) => error,
  );
  await vi.waitFor(() => expect(state.events).toContain("owner-end"));
  state.releaseClose!();
  expect(await outcome).toMatchObject({ message: "Rate limit cleanup failed", removed: 1, batches: 1 });
  expect(state.events.filter((event) => event === "BEGIN")).toHaveLength(1);
  expect(state.events).not.toContain("cancel-connect");
});

test("voluntary time-budget stop succeeds only after close within the deadline", async () => {
  state.events = [];
  state.stage = "none";
  state.rejectRun = state.releaseClose = state.releaseCancellation = undefined;
  const started = performance.now();
  state.hasMore = true;
  state.afterCommit = () => {
    vi.spyOn(performance, "now").mockReturnValue(started + 420);
  };
  let settled = false;
  const outcome = cleanupRateLimits({
    connectionString: "postgresql://unused.invalid/db",
    metadataNamespace: "loom_shutdown",
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
  expect(state.events.at(-1)).toBe("closed");
});

test("client construction failure is redacted before any connection work", async () => {
  state.events = [];
  state.failConstructor = true;
  const error = await cleanupRateLimits({
    connectionString: "postgresql://unused.invalid/db",
    metadataNamespace: "loom_shutdown",
  }).then(
    () => undefined,
    (error) => error,
  );
  expect(error).toMatchObject({ message: "Rate limit cleanup failed", removed: 0, batches: 0 });
  expect(JSON.stringify(error)).not.toMatch(/PRIVATE_/);
  expect(error.cause).toBeUndefined();
  expect(state.events).toEqual([]);
});

test.each([0, -1, NaN, Infinity, -Infinity])(
  "cancellation rejects nonpositive/nonfinite budget before transport (%s)",
  async (budget) => {
    state.events = [];
    await expect(cancelDatabaseStatement(new pg.Client(), budget)).rejects.toThrow(
      "PostgreSQL cancellation transport failed",
    );
    expect(state.events).toEqual([]);
  },
);

test("TLS connect events do not refresh the cancellation deadline", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  state.events = [];
  state.ssl = { rejectUnauthorized: true };
  state.negotiation = "postgres";
  state.failCancellation = false;
  state.transportConnectDelay = 90;
  const outcome = cancelDatabaseStatement(new pg.Client(), 100).catch((error) => error.message);
  await vi.advanceTimersByTimeAsync(90);
  expect(state.events).toContain("ssl-request");
  expect(state.events).toContain("cancel-send");
  await vi.advanceTimersByTimeAsync(10);
  state.releaseCancellation!(); // A late transport event cannot change failure.
  expect(await outcome).toBe("PostgreSQL cancellation transport failed");
  expect(state.events.filter((event) => event === "cancel-close")).toHaveLength(1);
});

test.each(["timer", "event", "send"] as const)(
  "throwing cancel destroy settles a fixed rejection on %s and ignores reentry/second events",
  async (path) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    state.events = [];
    state.ssl = false;
    state.negotiation = "postgres";
    state.failCancellation = false;
    state.throwCancelDestroy = state.reenterCancelDestroy = true;
    state.throwCancelSend = path === "send";
    state.releaseCancellation = undefined;
    let result: "pending" | "success" | Error = "pending";
    const outcome = cancelDatabaseStatement(new pg.Client(), 100).then(
      () => {
        result = "success";
      },
      (error) => {
        if (!(error instanceof Error)) throw new Error("Unexpected non-Error cancellation rejection");
        result = error;
      },
    );
    let escaped: unknown;
    try {
      await vi.advanceTimersByTimeAsync(0);
      if (path === "event") state.releaseCancellation!();
      if (path === "timer") await vi.advanceTimersByTimeAsync(100);
    } catch (error) {
      escaped = error;
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(escaped).toBeUndefined();
    expect(result).toMatchObject({ message: "PostgreSQL cancellation transport failed" });
    repeatCancellationEvent();
    await outcome;
    expect(state.events.filter((event) => event === "cancel-close")).toHaveLength(1);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_/);
  },
);

test("throwing cancel destroy still joins the owner's query drain and close", async () => {
  state.events = [];
  state.stage = "SHOW";
  state.ssl = false;
  state.negotiation = "postgres";
  state.throwCancelDestroy = state.reenterCancelDestroy = true;
  state.deferDrain = true;
  state.rejectRun = state.releaseClose = state.releaseCancellation = undefined;
  const entered = Promise.withResolvers<void>();
  state.entered = entered.resolve;
  const controller = new AbortController();
  let settled = false;
  const outcome = cleanupRateLimits({
    connectionString: "postgresql://unused.invalid/db",
    metadataNamespace: "loom_shutdown",
    signal: controller.signal,
  }).catch((error) => {
    settled = true;
    return error;
  });
  await entered.promise;
  controller.abort();
  await vi.waitFor(() => expect(state.events).toContain("cancel-send"));
  let escaped: unknown;
  try {
    state.releaseCancellation!();
  } catch (error) {
    escaped = error;
  }
  expect(escaped).toBeUndefined();
  await vi.waitFor(() => expect(state.events).toContain("owner-end"));
  expect(settled).toBe(false);
  state.releaseClose!();
  await vi.waitFor(() => expect(state.events).toContain("closed"));
  expect(settled).toBe(false);
  state.releaseDrain!();
  expect(await outcome).toMatchObject({ message: "Rate limit cleanup failed", removed: 0, batches: 0 });
});

test.each([new Error("PRIVATE_ABORT_INITIATOR"), null, false, 0, ""])(
  "initiating abort %s stays primary across cancellation, reentrant close and query-drain failures",
  async (reason) => {
    // Observe the existing private WeakMap write, without exporting raw diagnostics.
    const records = vi.spyOn(WeakMap.prototype, "set");
    state.events = [];
    state.stage = "SHOW";
    state.ssl = false;
    state.negotiation = "postgres";
    state.failCancellation = state.failClose = state.deferDrain = state.reenterOnDestroy = true;
    state.rejectRun = state.releaseClose = state.releaseCancellation = undefined;
    const entered = Promise.withResolvers<void>();
    state.entered = entered.resolve;
    const controller = new AbortController();
    const outcome = cleanupRateLimits({
      connectionString: "postgresql://unused.invalid/db",
      metadataNamespace: "loom_shutdown",
      signal: controller.signal,
    }).catch((error) => error);
    await entered.promise;
    controller.abort(reason);
    await vi.waitFor(() => expect(state.events).toContain("cancel-send"));
    state.releaseCancellation!();
    await vi.waitFor(() => expect(state.events).toContain("owner-end"));
    state.releaseClose!();
    state.releaseDrain!();
    const error = await outcome;
    const details = records.mock.calls.find(([key]) => key === error)?.[1];
    expect(details).toMatchObject({ primary: { error: reason } });
    expect(details.cleanup).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ phase: "cancel" }),
        expect.objectContaining({
          phase: "query-drain",
          error: expect.objectContaining({ message: "connection terminated" }),
        }),
        expect.objectContaining({ phase: "close", error: expect.objectContaining({ message: "PRIVATE_IDLE_ERROR" }) }),
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
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const records = vi.spyOn(WeakMap.prototype, "set");
    state.events = [];
    state.stage = path === "late-connect" ? "none" : "SHOW";
    state.ssl = false;
    state.negotiation = "postgres";
    state.lateConnect = state.rejectConnect = path === "late-connect";
    state.failCancellation = state.failClose = state.reenterOnDestroy = true;
    state.rejectRun = state.releaseClose = state.releaseCancellation = undefined;
    const entered = Promise.withResolvers<void>();
    state.entered = entered.resolve;
    const controller = new AbortController();
    const reason = new Error("PRIVATE_CONNECT_ABORT");
    const outcome = cleanupRateLimits({
      connectionString: "postgresql://unused.invalid/db",
      metadataNamespace: "loom_shutdown",
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
    else repeatCancellationEvent();
    await vi.advanceTimersByTimeAsync(0);
    state.releaseClose!();
    const error = await outcome;
    const details = records.mock.calls.find(([key]) => key === error)?.[1];
    expect(details.primary.error).toEqual(path === "late-connect" ? reason : new Error("Rate limit cleanup failed"));
    expect(details.cleanup).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ phase: "close", error: expect.objectContaining({ message: "PRIVATE_IDLE_ERROR" }) }),
        expect.objectContaining({
          phase: "close",
          error: expect.objectContaining({ message: "PRIVATE_CLOSE_FAILURE" }),
        }),
        ...(path === "late-connect"
          ? [
              expect.objectContaining({
                phase: "connect-drain",
                error: expect.objectContaining({ message: "PRIVATE_CONNECT_FAILURE" }),
              }),
            ]
          : []),
      ]),
    );
    expect(state.events.filter((event) => event === "owner-end")).toHaveLength(1);
    if (path === "late-connect") expect(state.events).not.toContain("SHOW");
  },
);

test("an earlier SQL failure remains primary when abort and reentrant close fail later", async () => {
  const records = vi.spyOn(WeakMap.prototype, "set");
  state.events = [];
  state.stage = "none";
  state.failQuery = "SHOW";
  state.reenterOnDestroy = state.failClose = true;
  state.rejectRun = state.releaseClose = state.releaseCancellation = undefined;
  const controller = new AbortController();
  const outcome = cleanupRateLimits({
    connectionString: "postgresql://unused.invalid/db",
    metadataNamespace: "loom_shutdown",
    signal: controller.signal,
  }).catch((error) => error);
  await vi.waitFor(() => expect(state.events).toContain("owner-end"));
  controller.abort(new Error("PRIVATE_LATER_ABORT"));
  state.releaseClose!();
  const error = await outcome;
  const details = records.mock.calls.find(([key]) => key === error)?.[1];
  expect(details.primary.error.message).toBe("PRIVATE_OPERATION_FAILURE");
  expect(details.cleanup).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ phase: "close", error: expect.objectContaining({ message: "PRIVATE_IDLE_ERROR" }) }),
      expect.objectContaining({ phase: "close", error: expect.objectContaining({ message: "PRIVATE_CLOSE_FAILURE" }) }),
    ]),
  );
});
