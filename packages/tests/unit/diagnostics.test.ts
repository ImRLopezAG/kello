import { channel } from "node:diagnostics_channel";
import { Schema } from "effect";
import { startDiagnostics } from "../../../apps/loom/src/tooling/diagnostics/index";
import type { DiagnosticsSession } from "../../../apps/loom/src/tooling/diagnostics/types";
import { afterEach, beforeEach, describe, expect, expectTypeOf, test, vi } from "vite-plus/test";
import type { RuntimeMetric } from "../../../apps/loom/src/core/server/observability";
import type { DeploymentMetric } from "../../../apps/loom/src/tooling/deploy/observability";
import { projectDeploymentMetric, projectRuntimeMetric } from "../../../apps/loom/src/tooling/diagnostics/project";
import type {
  DiagnosticsDeploymentEvent,
  DiagnosticsRecord,
  DiagnosticsRuntimeEvent,
  DiagnosticsStats,
} from "../../../apps/loom/src/tooling/diagnostics/types";

const runtime = {
  "rpc.procedure": { type: "rpc.procedure", mode: "finite", status: "success", durationMs: 0.5 },
  "realtime.listener": { type: "realtime.listener", status: "connected" },
  "realtime.coordinator": { type: "realtime.coordinator", subscriptions: 0, evaluating: 1, queued: 2 },
  "transaction.retry": { type: "transaction.retry", kind: "query", attempt: 1 },
  "revision.read": { type: "revision.read", status: "success", durationMs: 0, tableCount: 0 },
  "job.claim": { type: "job.claim", ageMs: 0, dueLagMs: 0.5, attempt: 1, recovered: false },
  "job.lease.reaped": { type: "job.lease.reaped", count: 0 },
  "job.lease.lost": { type: "job.lease.lost", reason: "deadline" },
  "database.acquire": { type: "database.acquire", status: "success", durationMs: 1, total: 0, idle: 0, waiting: 0 },
} satisfies { [Type in RuntimeMetric["type"]]: Extract<RuntimeMetric, { readonly type: Type }> };

const stages = {
  metadata: true,
  quarantine: true,
  migrations: true,
  prepared: true,
  bootstrap: true,
  triggers: true,
  functions: true,
  health: true,
  activated: true,
  complete: true,
} satisfies Record<DeploymentMetric["stage"], true>;

const isNumber = Schema.is(Schema.Number);

describe("finite diagnostics projection", () => {
  test("keeps the single unknown-input and finite result contracts", () => {
    expectTypeOf<Parameters<typeof projectRuntimeMetric>>().toEqualTypeOf<[input: unknown]>();
    expectTypeOf<Parameters<typeof projectDeploymentMetric>>().toEqualTypeOf<[input: unknown]>();
    expectTypeOf<ReturnType<typeof projectRuntimeMetric>>().toEqualTypeOf<DiagnosticsRuntimeEvent | null>();
    expectTypeOf<ReturnType<typeof projectDeploymentMetric>>().toEqualTypeOf<DiagnosticsDeploymentEvent | null>();
  });

  test("copies every runtime variant and strips payload canaries", () => {
    for (const event of Object.values(runtime)) {
      const projected = projectRuntimeMetric({ ...event, token: "SECRET", sql: "SECRET", payload: { secret: true } });
      expect(projected).toEqual(event);
      expect(projected).not.toBe(event);
      expect(JSON.stringify(projected)).not.toContain("SECRET");
    }
  });

  test("accepts all runtime enum combinations", () => {
    for (const mode of ["finite", "live", "mutation"])
      for (const status of ["success", "error"])
        expect(projectRuntimeMetric({ ...runtime["rpc.procedure"], mode, status })).toEqual({
          ...runtime["rpc.procedure"],
          mode,
          status,
        });
    for (const status of ["connected", "degraded", "idle"])
      expect(projectRuntimeMetric({ type: "realtime.listener", status })).toEqual({
        type: "realtime.listener",
        status,
      });
    for (const kind of ["query", "mutation"])
      expect(projectRuntimeMetric({ ...runtime["transaction.retry"], kind })).toEqual({
        ...runtime["transaction.retry"],
        kind,
      });
    for (const reason of ["deadline", "ownership", "activation", "queue"])
      expect(projectRuntimeMetric({ type: "job.lease.lost", reason })).toEqual({ type: "job.lease.lost", reason });
    for (const type of ["revision.read", "database.acquire"] as const)
      for (const status of ["success", "error"])
        expect(projectRuntimeMetric({ ...runtime[type], status })).toEqual({ ...runtime[type], status });
    expect(projectRuntimeMetric({ ...runtime["job.claim"], recovered: true })).toEqual({
      ...runtime["job.claim"],
      recovered: true,
    });
  });

  test("copies all deployment stages and statuses with no provider payload", () => {
    for (const stage of Object.keys(stages)) {
      for (const status of ["recorded", "replayed", "write-error"]) {
        const event = { type: "release.acknowledgement", stage, status };
        const input = { ...event, path: "SECRET", providerId: "SECRET", error: new Error("SECRET") };
        const projected = projectDeploymentMetric(input);
        expect(projected).toEqual(event);
        expect(projected).not.toBe(input);
        input.stage = "changed";
        input.status = "changed";
        expect(projected).toEqual(event);
      }
    }
  });

  test("retained input mutation cannot alter approved primitives", () => {
    for (const event of Object.values(runtime)) {
      const input = { ...event };
      const projected = projectRuntimeMetric(input);
      for (const field of Object.keys(input)) Object.defineProperty(input, field, { value: "changed" });
      expect(projected).toEqual(event);
    }
  });

  test("rejects missing, inherited, accessor and malformed fields in every variant", () => {
    let calls = 0;
    for (const event of [
      ...Object.values(runtime),
      { type: "release.acknowledgement", stage: "metadata", status: "recorded" },
    ]) {
      const project = event.type === "release.acknowledgement" ? projectDeploymentMetric : projectRuntimeMetric;
      for (const field of Object.keys(event)) {
        const missing = { ...event };
        Reflect.deleteProperty(missing, field);
        expect(project(missing)).toBeNull();
        expect(project(Object.assign(Object.create(event), missing))).toBeNull();
        const accessor = { ...event };
        Object.defineProperty(accessor, field, {
          get: () => {
            calls++;
            throw new Error("SECRET");
          },
        });
        expect(project(accessor)).toBeNull();
        for (const value of [undefined, null, "SECRET", {}, [], () => {}, Symbol("SECRET"), 1n])
          expect(project({ ...event, [field]: value })).toBeNull();
      }
    }
    expect(calls).toBe(0);
  });

  test("rejects nonfinite or negative numbers and unsafe or fractional counts/attempts", () => {
    for (const event of Object.values(runtime)) {
      for (const [field, original] of Object.entries(event)) {
        if (!isNumber(original)) continue;
        for (const value of [NaN, Infinity, -Infinity, -1, "1", new Number(1)])
          expect(projectRuntimeMetric({ ...event, [field]: value })).toBeNull();
        const duration = ["durationMs", "ageMs", "dueLagMs"].includes(field);
        for (const value of duration ? [0, 0.5, Number.MAX_VALUE] : [Number.MAX_SAFE_INTEGER])
          expect(projectRuntimeMetric({ ...event, [field]: value })).toEqual({ ...event, [field]: value });
        if (!duration) {
          for (const value of [0.5, Number.MAX_SAFE_INTEGER + 1])
            expect(projectRuntimeMetric({ ...event, [field]: value })).toBeNull();
          expect(projectRuntimeMetric({ ...event, [field]: 0 })).toEqual(
            field === "attempt" ? null : { ...event, [field]: 0 },
          );
        }
      }
    }
    for (const recovered of [0, 1, "false", new Boolean(false)])
      expect(projectRuntimeMetric({ ...runtime["job.claim"], recovered })).toBeNull();
  });

  test("ignores extra accessors and proxy read/enumeration traps", () => {
    let calls = 0;
    for (const event of [
      ...Object.values(runtime),
      { type: "release.acknowledgement", stage: "metadata", status: "recorded" },
    ]) {
      const project = event.type === "release.acknowledgement" ? projectDeploymentMetric : projectRuntimeMetric;
      const input = { ...event };
      Object.defineProperty(input, "secret", {
        enumerable: true,
        get: () => {
          calls++;
          throw new Error("SECRET");
        },
      });
      Object.defineProperty(input, "toJSON", {
        get: () => {
          calls++;
          throw new Error("SECRET");
        },
      });
      const proxy = new Proxy(input, {
        get: () => {
          calls++;
          throw new Error("SECRET");
        },
        ownKeys: () => {
          calls++;
          throw new Error("SECRET");
        },
        getPrototypeOf: () => {
          calls++;
          throw new Error("SECRET");
        },
      });
      expect(project(proxy)).toEqual(event);
    }
    expect(calls).toBe(0);
  });

  test("contains hostile descriptor proxies and revoked proxies at every approved field", () => {
    for (const event of [
      ...Object.values(runtime),
      { type: "release.acknowledgement", stage: "metadata", status: "recorded" },
    ]) {
      const project = event.type === "release.acknowledgement" ? projectDeploymentMetric : projectRuntimeMetric;
      for (const field of Object.keys(event)) {
        const proxy = new Proxy(event, {
          getOwnPropertyDescriptor(target, key) {
            if (key === field) throw new Error("SECRET");
            return Object.getOwnPropertyDescriptor(target, key);
          },
        });
        expect(project(proxy)).toBeNull();
      }
      const revoked = Proxy.revocable(event, {});
      revoked.revoke();
      expect(project(revoked.proxy)).toBeNull();
    }
  });

  test("rejects nonprimitive descriptor values without inspecting their hostile traps", () => {
    let calls = 0;
    const trap = () => {
      calls++;
      throw new Error("SECRET");
    };
    const hostile = new Proxy(
      {},
      {
        get: trap,
        ownKeys: trap,
        getPrototypeOf: trap,
        getOwnPropertyDescriptor: trap,
      },
    );
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    for (const event of [
      ...Object.values(runtime),
      { type: "release.acknowledgement", stage: "metadata", status: "recorded" },
    ]) {
      const project = event.type === "release.acknowledgement" ? projectDeploymentMetric : projectRuntimeMetric;
      for (const field of Object.keys(event))
        for (const value of [hostile, revoked.proxy]) expect(project({ ...event, [field]: value })).toBeNull();
    }
    expect(calls).toBe(0);
  });

  test("accepts nonenumerable own data properties and null prototypes", () => {
    for (const event of Object.values(runtime)) {
      const input = Object.create(null);
      for (const [field, value] of Object.entries(event)) Object.defineProperty(input, field, { value });
      expect(projectRuntimeMetric(input)).toEqual(event);
    }
  });

  test("rejects nonobjects, unknown variants, prototype keys and wrong channels", () => {
    for (const input of [undefined, null, true, 1, "SECRET", Symbol("SECRET"), 1n, () => {}, [], {}]) {
      expect(projectRuntimeMetric(input)).toBeNull();
      expect(projectDeploymentMetric(input)).toBeNull();
    }
    for (const type of [
      "unknown",
      "constructor",
      "__proto__",
      "toString",
      "diagnostics.loss",
      "rate_limit.decision",
      "rate_limit.cleanup",
    ]) {
      expect(projectRuntimeMetric({ type })).toBeNull();
      expect(projectDeploymentMetric({ type, stage: "metadata", status: "recorded" })).toBeNull();
    }
    expect(projectRuntimeMetric({ type: "release.acknowledgement", stage: "metadata", status: "recorded" })).toBeNull();
    for (const event of Object.values(runtime)) expect(projectDeploymentMetric(event)).toBeNull();
  });

  test("rejects callable payloads even with every approved own field", () => {
    for (const event of Object.values(runtime)) expect(projectRuntimeMetric(Object.assign(() => {}, event))).toBeNull();
    expect(
      projectDeploymentMetric(
        Object.assign(() => {}, { type: "release.acknowledgement", stage: "metadata", status: "recorded" }),
      ),
    ).toBeNull();
  });

  test("versioned public records include cumulative diagnostics loss counters", () => {
    expectTypeOf<Extract<DiagnosticsRecord, { source: "diagnostics" }>["event"]>().toEqualTypeOf<
      { readonly type: "diagnostics.loss" } & DiagnosticsStats
    >();
    const record: DiagnosticsRecord = {
      schemaVersion: 1,
      scope: "local-process",
      sequence: 1,
      timestamp: "2026-10-07T00:00:00.000Z",
      source: "diagnostics",
      event: { type: "diagnostics.loss", accepted: 1, invalid: 2, dropped: 3, outputFailures: 4, exportFailures: 5 },
    };
    expect(JSON.parse(JSON.stringify(record))).toEqual(record);
  });
});

// Session tests use source imports; packed consumers alone exercise dist.
describe("owned diagnostics session", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  test("copies all channel variants, owns observation metadata and strips secrets", async () => {
    const lines: string[] = [];
    const session = await startDiagnostics({
      output: {
        format: "jsonl",
        write: (line) => {
          lines.push(line);
        },
      },
    });
    try {
      for (const event of Object.values(runtime)) {
        const input = { ...event, secret: "SECRET" };
        runtimeChannel.publish(input);
        Object.assign(input, { type: "mutated", durationMs: 100 });
      }
      for (const stage of Object.keys(stages)) {
        for (const status of ["recorded", "replayed", "write-error"]) {
          deploymentChannel.publish({ type: "release.acknowledgement", stage, status, secret: "SECRET" });
        }
      }
      expect(lines).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(100);
      const records: DiagnosticsRecord[] = lines.map((line) => JSON.parse(line));
      expect(records).toHaveLength(39);
      expect(records.slice(0, 9).map((record) => record.event)).toEqual(Object.values(runtime));
      records.forEach((record, index) => {
        expect(record.schemaVersion).toBe(1);
        expect(record.scope).toBe("local-process");
        expect(record.sequence).toBe(index + 1);
        expect(new Date(record.timestamp).toISOString()).toBe(record.timestamp);
      });
      expect(lines.join("")).not.toContain("SECRET");
      const snapshot = session.snapshot();
      Object.assign(snapshot, { accepted: 0 });
      expect(session.snapshot().accepted).toBe(39);
    } finally {
      await stop(session);
    }
  });

  test("contains malformed, accessor and proxy inputs and reports cumulative loss at most once per second", async () => {
    const lines: string[] = [];
    let getters = 0;
    const session = await startDiagnostics({
      output: {
        format: "jsonl",
        write: (line) => {
          lines.push(line);
        },
      },
    });
    try {
      const accessor = { ...runtime["rpc.procedure"] };
      Object.defineProperty(accessor, "durationMs", {
        get() {
          getters++;
          throw new Error("SECRET");
        },
      });
      const proxy = new Proxy(
        {},
        {
          getOwnPropertyDescriptor() {
            throw new Error("SECRET");
          },
        },
      );
      for (const input of [
        accessor,
        proxy,
        { type: "unknown" },
        { ...runtime["job.claim"], ageMs: NaN },
        { ...runtime["job.claim"], attempt: -1 },
        { ...runtime["rpc.procedure"], status: "bad" },
      ])
        runtimeChannel.publish(input);
      deploymentChannel.publish({ type: "release.acknowledgement", stage: "bad", status: "recorded" });
      expect(getters).toBe(0);
      expect(session.snapshot().invalid).toBe(7);
      await vi.advanceTimersByTimeAsync(999);
      expect(lines).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(10);
      expect(lines).toHaveLength(1);
      const loss = JSON.parse(lines[0] ?? "");
      expect(loss.source).toBe("diagnostics");
      expect(loss.event).toEqual({ type: "diagnostics.loss", ...session.snapshot() });
      expect(session.snapshot().invalid).toBe(7); // Loss was not republished.
      runtimeChannel.publish(null);
      await vi.advanceTimersByTimeAsync(500);
      expect(lines).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(500);
      expect(lines).toHaveLength(2);
    } finally {
      await stop(session);
    }
  });

  test("loss reporting preserves sequence order across a pending ingress drain", async () => {
    const sequences: number[] = [];
    const session = await startDiagnostics({
      output: {
        format: "jsonl",
        write: (line) => {
          sequences.push(JSON.parse(line).sequence);
        },
      },
    });
    try {
      await vi.advanceTimersByTimeAsync(999);
      runtimeChannel.publish(null);
      for (let i = 0; i < 128; i++) runtimeChannel.publish(runtime["rpc.procedure"]);
      await vi.advanceTimersByTimeAsync(500);
      expect(sequences).toHaveLength(129);
      expect(sequences).toEqual([...sequences].sort((left, right) => left - right));
    } finally {
      await stop(session);
    }
  });

  test("drops newest ingress at 1024, yields after 64 and bounds output at 256 independently", async () => {
    const pending = controlled();
    const write = vi.fn(() => pending.promise);
    const session = await startDiagnostics({ output: { format: "jsonl", write } });
    try {
      for (let i = 0; i < 1025; i++) runtimeChannel.publish({ ...runtime["rpc.procedure"], durationMs: i });
      expect(session.snapshot()).toMatchObject({ accepted: 1024, dropped: 1 });
      let acceptedAtYield = 0;
      setTimeout(() => {
        acceptedAtYield = write.mock.calls.length;
      }, 0);
      await vi.advanceTimersToNextTimerAsync();
      expect(acceptedAtYield).toBe(0); // A separate turn runs before the output pump.
      await vi.advanceTimersByTimeAsync(100);
      expect(write).toHaveBeenCalledTimes(1);
      expect(session.snapshot().dropped).toBe(1 + 1024 - 257);
      const firstStop = session.stop();
      expect(session.stop()).toBe(firstStop);
      expect(session.snapshot().dropped).toBe(1024);
      expect(write).toHaveBeenCalledTimes(1);
      await firstStop;
      pending.resolve();
    } finally {
      await stop(session);
    }
  });

  test("fair drain processes at most 64 records before an external timer gets its turn", async () => {
    const pending = controlled();
    const session = await startDiagnostics({ output: { format: "jsonl", write: () => pending.promise } });
    try {
      for (let i = 0; i < 256; i++) runtimeChannel.publish(runtime["rpc.procedure"]);
      await vi.advanceTimersByTimeAsync(100);
      // One record is in flight and 255 are queued: the next drain has one free slot.
      for (let i = 0; i < 128; i++) runtimeChannel.publish(runtime["rpc.procedure"]);
      let dropsAtYield = -1;
      setTimeout(() => {
        dropsAtYield = session.snapshot().dropped;
      }, 0);
      await vi.advanceTimersByTimeAsync(100);
      expect(dropsAtYield).toBe(63);
      expect(session.snapshot().dropped).toBe(127);
      pending.resolve();
    } finally {
      await stop(session);
    }
  });

  test("saturation preserves oldest records in both rings", async () => {
    const pending = controlled();
    const lines: string[] = [];
    const session = await startDiagnostics({
      output: {
        format: "jsonl",
        write: (line) => {
          lines.push(line);
          if (lines.length === 1) return pending.promise;
        },
      },
    });
    try {
      for (let i = 0; i < 1025; i++) runtimeChannel.publish({ ...runtime["rpc.procedure"], durationMs: i });
      await vi.advanceTimersByTimeAsync(100);
      pending.resolve();
      await vi.advanceTimersByTimeAsync(500);
      expect(lines).toHaveLength(257);
      expect(lines.map((line) => JSON.parse(line).event.durationMs)).toEqual(Array.from({ length: 257 }, (_, i) => i));
      expect(session.snapshot()).toMatchObject({ accepted: 1024, dropped: 768 });
    } finally {
      await stop(session);
    }
  });

  test.each(["throw", "reject"] as const)(
    "disables only output on writer %s and continues accepting ingress",
    async (failure) => {
      const write = vi.fn(() => {
        if (failure === "throw") throw new Error("SECRET");
        return Promise.reject(new Error("SECRET"));
      });
      const session = await startDiagnostics({ output: { format: "text", write } });
      try {
        for (let i = 0; i < 100; i++) runtimeChannel.publish(runtime["rpc.procedure"]);
        await vi.advanceTimersByTimeAsync(100);
        expect(session.snapshot()).toMatchObject({ accepted: 100, outputFailures: 1 });
        expect(write).toHaveBeenCalledTimes(1);
        runtimeChannel.publish(runtime["rpc.procedure"]);
        await vi.advanceTimersByTimeAsync(2000);
        expect(session.snapshot().accepted).toBe(101);
        expect(write).toHaveBeenCalledTimes(1);
      } finally {
        await stop(session);
      }
    },
  );

  test.each(["throw", "oversize"] as const)("contains formatter %s before any writer call", async (failure) => {
    const write = vi.fn();
    const session = await startDiagnostics({ output: { format: "jsonl", write } });
    try {
      runtimeChannel.publish(runtime["rpc.procedure"]);
      const stringify = vi.spyOn(JSON, "stringify");
      if (failure === "throw")
        stringify.mockImplementation(() => {
          throw new Error("SECRET");
        });
      else stringify.mockReturnValue("😀".repeat(600));
      await vi.advanceTimersByTimeAsync(100);
      stringify.mockRestore();
      expect(write).not.toHaveBeenCalled();
      expect(session.snapshot().outputFailures).toBe(1);
    } finally {
      await stop(session);
    }
  });

  test.each(["text", "jsonl"] as const)("keeps maximum finite %s records below 2KiB UTF8", async (format) => {
    const lines: string[] = [];
    const session = await startDiagnostics({
      output: {
        format,
        write: (line) => {
          lines.push(line);
        },
      },
    });
    try {
      runtimeChannel.publish({
        ...runtime["database.acquire"],
        durationMs: Number.MAX_VALUE,
        total: Number.MAX_SAFE_INTEGER,
        idle: Number.MAX_SAFE_INTEGER,
        waiting: Number.MAX_SAFE_INTEGER,
      });
      await vi.advanceTimersByTimeAsync(100);
      expect(lines).toHaveLength(1);
      expect(new TextEncoder().encode(lines[0]).byteLength).toBeLessThanOrEqual(2048);
      expect(lines[0]).toContain("database.acquire");
    } finally {
      await stop(session);
    }
  });

  test("first stop cancels synchronously, forbids queued/loss calls and resolves within simulated two seconds with a hung writer", async () => {
    const pending = controlled();
    let signal: AbortSignal | undefined;
    const write = vi.fn((_line: string, cancellation: AbortSignal) => {
      signal = cancellation;
      return pending.promise;
    });
    const session = await startDiagnostics({ output: { format: "jsonl", write } });
    runtimeChannel.publish(runtime["rpc.procedure"]);
    await vi.advanceTimersByTimeAsync(10);
    for (let i = 0; i < 1025; i++) runtimeChannel.publish(runtime["rpc.procedure"]);
    const accepted = session.snapshot().accepted;
    const first = session.stop();
    expect(signal?.aborted).toBe(true);
    expect(session.stop()).toBe(first);
    runtimeChannel.publish(runtime["rpc.procedure"]);
    deploymentChannel.publish({ type: "release.acknowledgement", stage: "complete", status: "recorded" });
    let settled = false;
    void first.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(2000);
    expect(settled).toBe(true);
    expect(session.snapshot().accepted).toBe(accepted);
    expect(write).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    pending.resolve();
  });

  test.each([
    ["resolve", false],
    ["reject", false],
    ["resolve", true],
    ["reject", true],
  ] as const)(
    "late writer %s after replacement cannot resume old pump or change new session (normalization stop=%s)",
    async (outcome, normalizationStop) => {
      const pending = controlled();
      const oldWrite = vi.fn(() => pending.promise);
      const old = await startDiagnostics({ output: { format: "jsonl", write: oldWrite } });
      let normalizationReads = 0;
      if (normalizationStop)
        void Object.defineProperty(pending.promise, "constructor", {
          get() {
            normalizationReads++;
            void old.stop();
            return Promise;
          },
        });
      runtimeChannel.publish(runtime["rpc.procedure"]);
      runtimeChannel.publish(runtime["rpc.procedure"]);
      await vi.advanceTimersByTimeAsync(10);
      if (normalizationStop) expect(normalizationReads).toBeGreaterThan(0);
      await stop(old);
      const oldStats = old.snapshot();
      const newWrite = vi.fn();
      const replacement = await startDiagnostics({ output: { format: "jsonl", write: newWrite } });
      try {
        const before = replacement.snapshot();
        if (outcome === "resolve") pending.resolve();
        else pending.reject(new Error("SECRET"));
        await vi.advanceTimersByTimeAsync(100);
        expect(oldWrite).toHaveBeenCalledTimes(1);
        expect(old.snapshot()).toEqual(oldStats);
        expect(replacement.snapshot()).toEqual(before);
        expect(newWrite).not.toHaveBeenCalled();
        runtimeChannel.publish(runtime["rpc.procedure"]);
        await vi.advanceTimersByTimeAsync(10);
        expect(newWrite).toHaveBeenCalledTimes(1);
      } finally {
        await stop(replacement);
      }
    },
  );

  test.each([
    ["resolve", false],
    ["reject", false],
    ["resolve", true],
    ["reject", true],
  ] as const)(
    "late writer %s after stop is consumed before any replacement (normalization stop=%s)",
    async (outcome, normalizationStop) => {
      const pending = controlled();
      const write = vi.fn(() => pending.promise);
      const session = await startDiagnostics({ output: { format: "jsonl", write } });
      let normalizationReads = 0;
      if (normalizationStop)
        void Object.defineProperty(pending.promise, "constructor", {
          get() {
            normalizationReads++;
            void session.stop();
            return Promise;
          },
        });
      runtimeChannel.publish(runtime["rpc.procedure"]);
      runtimeChannel.publish(runtime["rpc.procedure"]);
      await vi.advanceTimersByTimeAsync(10);
      if (normalizationStop) expect(normalizationReads).toBeGreaterThan(0);
      await stop(session);
      const before = session.snapshot();
      if (outcome === "resolve") pending.resolve();
      else pending.reject(new Error("SECRET"));
      await vi.advanceTimersByTimeAsync(2000);
      expect(write).toHaveBeenCalledTimes(1);
      expect(session.snapshot()).toEqual(before);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  test("retained options cannot replace the formatter or writer", async () => {
    const lines: string[] = [];
    const output = {
      format: "jsonl" as const,
      write: (line: string) => {
        lines.push(line);
      },
    };
    const session = await startDiagnostics({ output });
    try {
      output.write = () => {
        throw new Error("replacement");
      };
      runtimeChannel.publish(runtime["rpc.procedure"]);
      await vi.advanceTimersByTimeAsync(10);
      expect(lines).toHaveLength(1);
      expect(session.snapshot().outputFailures).toBe(0);
    } finally {
      await stop(session);
    }
  });

  test("cooperative writer cancels during backpressure and stop before submission invokes no writer", async () => {
    const backpressure = controlled();
    const submitted: string[] = [];
    const writer = async (line: string, signal: AbortSignal) => {
      if (signal.aborted) return;
      await backpressure.promise;
      if (signal.aborted) return;
      submitted.push(line);
    };
    const first = await startDiagnostics({ output: { format: "jsonl", write: writer } });
    runtimeChannel.publish(runtime["rpc.procedure"]);
    await stop(first);
    expect(submitted).toEqual([]);
    const second = await startDiagnostics({ output: { format: "jsonl", write: writer } });
    runtimeChannel.publish(runtime["rpc.procedure"]);
    await vi.advanceTimersByTimeAsync(10);
    await stop(second);
    backpressure.resolve();
    await vi.advanceTimersByTimeAsync(10);
    expect(submitted).toEqual([]);
  });

  test.each([
    ["runtime", true],
    ["runtime", false],
    ["deployment", true],
    ["deployment", false],
  ] as const)("projection-triggered stop prevents later %s accounting (valid=%s)", async (source, valid) => {
    const write = vi.fn();
    const session = await startDiagnostics({ output: { format: "jsonl", write } });
    const before = session.snapshot();
    const input =
      source === "runtime"
        ? runtime["rpc.procedure"]
        : { type: "release.acknowledgement", stage: "complete", status: "recorded" };
    let stopped: Promise<void> | undefined;
    const proxy = new Proxy(input, {
      getOwnPropertyDescriptor(target, property) {
        stopped = session.stop();
        return valid ? Object.getOwnPropertyDescriptor(target, property) : undefined;
      },
    });
    (source === "runtime" ? runtimeChannel : deploymentChannel).publish(proxy);
    expect(stopped).toBeDefined();
    expect(session.snapshot()).toEqual(before);
    expect(vi.getTimerCount()).toBe(0);
    await stopped;
    expect(write).not.toHaveBeenCalled();
  });

  test("global ownership survives duplicate module instances and repeated lifetimes", async () => {
    const first = await startDiagnostics({ output: { format: "jsonl", write: () => {} } });
    try {
      vi.resetModules();
      const duplicate = await import("../../../apps/loom/src/tooling/diagnostics/index");
      await expect(duplicate.startDiagnostics({ output: { format: "jsonl", write: () => {} } })).rejects.toThrow(
        "DIAGNOSTICS_ALREADY_ACTIVE",
      );
      runtimeChannel.publish(runtime["rpc.procedure"]);
      expect(first.snapshot().accepted).toBe(1);
    } finally {
      await stop(first);
    }
    for (let i = 0; i < 5; i++) {
      const session = await startDiagnostics({ output: { format: "jsonl", write: () => {} } });
      runtimeChannel.publish(runtime["rpc.procedure"]);
      expect(session.snapshot().accepted).toBe(1);
      await stop(session);
      expect(runtimeChannel.hasSubscribers).toBe(false);
      expect(deploymentChannel.hasSubscribers).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    }
  });

  test("abort listeners that reenter stop receive the same cleanup promise", async () => {
    let reentered: Promise<void> | undefined;
    let session: DiagnosticsSession;
    const pending = controlled();
    session = await startDiagnostics({
      output: {
        format: "jsonl",
        write: (_line, signal) => {
          signal.addEventListener(
            "abort",
            () => {
              reentered = session.stop();
            },
            { once: true },
          );
          return pending.promise;
        },
      },
    });
    runtimeChannel.publish(runtime["rpc.procedure"]);
    await vi.advanceTimersByTimeAsync(10);
    const stopping = session.stop();
    expect(reentered).toBe(stopping);
    await stopping;
    pending.resolve();
  });

  test("startup failures unwind ownership and subscriptions; invalid telemetry is explicit", async () => {
    await expect(startDiagnostics({})).rejects.toThrow("DIAGNOSTICS_SINK_REQUIRED");
    await expect(
      startDiagnostics({ telemetry: { protocol: "otlp-http-json", endpoint: "http://localhost" } }),
    ).rejects.toThrow("TELEMETRY_CONFIG_INVALID");
    const subscribe = vi.spyOn(deploymentChannel, "subscribe").mockImplementation(() => {
      throw new Error("startup");
    });
    await expect(startDiagnostics({ output: { format: "jsonl", write: () => {} } })).rejects.toThrow("startup");
    subscribe.mockRestore();
    expect(runtimeChannel.hasSubscribers).toBe(false);
    expect(deploymentChannel.hasSubscribers).toBe(false);
    const session = await startDiagnostics({ output: { format: "jsonl", write: () => {} } });
    await stop(session);
  });
});

const runtimeChannel = channel("kello.runtime.metric");
const deploymentChannel = channel("kello.deployment.metric");
function controlled() {
  return Promise.withResolvers<void>();
}
async function stop(session: DiagnosticsSession) {
  const stopping = session.stop();
  await vi.advanceTimersByTimeAsync(2000);
  await stopping;
}
