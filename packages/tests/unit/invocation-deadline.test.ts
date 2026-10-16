import { afterEach, expect, test, vi } from "vite-plus/test";
import { call, os, Procedure } from "@orpc/server";
import { Context, Effect, Layer } from "effect";
import { defineRelations } from "drizzle-orm";
import { drizzle, NodePgTransaction } from "drizzle-orm/node-postgres";
import { PgDialect } from "drizzle-orm/pg-core";
import type { Pool } from "pg";
import { createRpcHttpApp } from "../../../apps/kello/src/core/adapters/neon/rpc-http";
import { createRpcSocketSession } from "../../../apps/kello/src/core/adapters/neon/rpc-session";
import { createEffectRuntime, Invocation } from "../../../apps/kello/src/core/server/effect/runtime";
import { createProjectProcedures } from "../../../apps/kello/src/core/server/rpc/procedure";
import type { ProcedureContext } from "../../../apps/kello/src/core/server/rpc/procedure";
import { createDatabaseMiddleware } from "../../../apps/kello/src/core/server/rpc/database";
import { bindRuntimeGraph } from "../../../apps/kello/src/core/server/rpc/runtime-graph";
import * as databaseConnection from "../../../apps/kello/src/core/server/database/connection";
import { rememberDatabaseAdapter } from "../../../apps/kello/src/core/server/database/context";
import { createRevisionCoordinator } from "../../../apps/kello/src/core/server/realtime/coordinator";
import { defineSchema } from "../../../apps/kello/src/core/schema/define-schema";
import {
  composeInvocationSignals,
  constrainInvocationDeadline,
  invocationRemainingMs,
  timedInvocationSignal,
} from "../../../apps/kello/src/core/server/invocation-deadline";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

test("unknown external signals have no invented bound or trusted public metadata", () => {
  const external = new AbortController();
  Object.assign(external.signal, { deadline: 0, remainingMs: 0 });
  expect(invocationRemainingMs(external.signal)).toBeUndefined();
  expect(invocationRemainingMs(composeInvocationSignals([external.signal]))).toBeUndefined();
  expect(invocationRemainingMs(composeInvocationSignals([]))).toBeUndefined();
});

test("constraints initialize or tighten, and composition snapshots the known minimum", () => {
  vi.spyOn(performance, "now").mockReturnValue(100);
  const first = new AbortController().signal;
  const second = new AbortController().signal;
  constrainInvocationDeadline(first, 140);
  constrainInvocationDeadline(first, 150);
  constrainInvocationDeadline(second, 130);
  const combined = composeInvocationSignals([first, new AbortController().signal, second]);
  expect(invocationRemainingMs(first)).toBe(40);
  expect(invocationRemainingMs(combined)).toBe(30);
  constrainInvocationDeadline(second, 110);
  expect(invocationRemainingMs(second)).toBe(10);
  expect(invocationRemainingMs(combined)).toBe(30);
  expect(invocationRemainingMs(composeInvocationSignals([combined, second]))).toBe(10);
});

test("expired and sub-millisecond bounds are never rounded into a fresh budget", () => {
  const now = vi.spyOn(performance, "now").mockReturnValue(100);
  const signal = new AbortController().signal;
  constrainInvocationDeadline(signal, 100.5);
  expect(invocationRemainingMs(signal)).toBe(0.5);
  now.mockReturnValue(101);
  expect(invocationRemainingMs(signal)).toBe(-0.5);
  constrainInvocationDeadline(signal, 200);
  expect(invocationRemainingMs(composeInvocationSignals([signal]))).toBe(-0.5);
  expect(signal.aborted).toBe(false);
});

test("native composition preserves pre-aborted ordering and later unknown cancellation reasons", () => {
  const firstReason = new Error("first");
  const secondReason = new Error("second");
  const first = AbortSignal.abort(firstReason);
  constrainInvocationDeadline(first, performance.now() + 1000);
  const combined = composeInvocationSignals([first, AbortSignal.abort(secondReason)]);
  expect(combined.aborted).toBe(true);
  expect(combined.reason).toBe(firstReason);
  expect(invocationRemainingMs(combined)).toBeGreaterThan(0);
  const external = new AbortController();
  const pending = composeInvocationSignals([timedInvocationSignal(1000), external.signal]);
  external.abort(secondReason);
  expect(pending.reason).toBe(secondReason);
  expect(pending.aborted).toBe(true);
});

test("timed provenance samples before native timer creation and retains native duration validation", () => {
  const now = vi.spyOn(performance, "now").mockReturnValue(100);
  const native = AbortSignal.timeout.bind(AbortSignal);
  vi.spyOn(AbortSignal, "timeout").mockImplementation((duration) => {
    now.mockReturnValue(110);
    return native(duration);
  });
  expect(invocationRemainingMs(timedInvocationSignal(50))).toBe(40);
  for (const value of [NaN, Infinity, -Infinity]) {
    expect(() => timedInvocationSignal(value)).toThrow();
    expect(() => constrainInvocationDeadline(new AbortController().signal, value)).toThrow();
  }
  for (const value of [-1, 1.5]) {
    expect(() => timedInvocationSignal(value)).toThrow();
    expect(() => native(value)).toThrow();
  }
});

test("monotonic expiry is observable before delayed native timer delivery", () => {
  const signal = timedInvocationSignal(1);
  const until = performance.now() + 10;
  while (performance.now() < until) {
    // Block the event loop so the actual native timer cannot deliver its abort.
  }
  expect(signal.aborted).toBe(false);
  expect(invocationRemainingMs(signal)).toBeLessThanOrEqual(0);
  expect(invocationRemainingMs(composeInvocationSignals([signal]))).toBeLessThanOrEqual(0);
});

test("timed signals keep the native TimeoutError reason", async () => {
  const signal = timedInvocationSignal(1);
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(signal.aborted).toBe(true);
  expect(signal.reason).toBeInstanceOf(DOMException);
  expect(signal.reason.name).toBe("TimeoutError");
});

const version = "a".repeat(64);
const identity = { issuer: "test", subject: "alice" };

for (const sessionMs of [10, 10_000]) {
  test(`HTTP preserves the earlier request/session bound (${sessionMs}ms session)`, async () => {
    const now = vi.spyOn(performance, "now").mockReturnValue(100);
    vi.spyOn(Date, "now").mockReturnValue(100_000);
    let observed: number | undefined;
    const app = createRpcHttpApp({
      router: {
        read: os.$context<ProcedureContext>().handler(({ context }) => {
          observed = invocationRemainingMs(context.signal);
          return null;
        }),
      },
      version,
      origins: [],
      requestTimeoutMs: 1000,
      verify: async () => {
        now.mockReturnValue(120);
        return { identity, expiresAt: (100_000 + sessionMs) / 1000 };
      },
    });
    const response = await app.fetch(
      new Request("https://service.test/api/kello/rpc/read", {
        method: "POST",
        headers: {
          authorization: "Bearer token",
          "content-type": "application/json",
          "x-loom-protocol": "loom-orpc-2",
          "x-loom-version": version,
        },
        body: JSON.stringify({ json: null }),
      }),
    );
    expect(response.status).toBe(200);
    expect(observed).toBe(Math.min(sessionMs, 980));
  });
}

function socketFixture(expiresAt: number) {
  const observed: AbortSignal[] = [];
  const closed: [number, string][] = [];
  let received = Promise.withResolvers<AbortSignal>();
  const connection = createRpcSocketSession({
    router: {
      read: os.$context<ProcedureContext>().handler(({ context }) => {
        observed.push(context.signal);
        received.resolve(context.signal);
        return null;
      }),
    },
    session: { identity, expiresAt },
    socket: {
      readyState: 1,
      bufferedAmount: 0,
      send: () => {},
      close: (code, reason) => closed.push([code, reason]),
    },
  });
  return {
    connection,
    closed,
    observed,
    call: async (id: string) => {
      received = Promise.withResolvers<AbortSignal>();
      connection.message(
        JSON.stringify({
          kind: "request",
          id,
          json: { url: "/read", method: "POST", body: { json: null } },
        }),
      );
      return received.promise;
    },
  };
}

test("WS backward wall time leaves native session live while original limiter bound expires", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  const now = vi.spyOn(performance, "now").mockReturnValue(100);
  const wall = vi.spyOn(Date, "now").mockReturnValue(100_000);
  const fixture = socketFixture(110);
  try {
    const first = await fixture.call("first");
    expect(invocationRemainingMs(first)).toBe(10_000);
    wall.mockReturnValue(90_000);
    now.mockReturnValue(10_101);
    await vi.advanceTimersByTimeAsync(10_000);
    const expired = await fixture.call("expired");
    expect(fixture.closed).toEqual([]);
    expect(expired.aborted).toBe(false);
    expect(invocationRemainingMs(expired)).toBe(-1);
    expect(invocationRemainingMs(first)).toBe(-1);
  } finally {
    await fixture.connection.dispose();
  }
});

test("WS forward conversion tightens later dispatch without retroactively changing active snapshots", async () => {
  const now = vi.spyOn(performance, "now").mockReturnValue(100);
  const wall = vi.spyOn(Date, "now").mockReturnValue(100_000);
  const fixture = socketFixture(110);
  try {
    const first = await fixture.call("first");
    now.mockReturnValue(200);
    wall.mockReturnValue(109_000);
    expect(invocationRemainingMs(await fixture.call("forward"))).toBe(1000);
    expect(invocationRemainingMs(first)).toBe(9900);
    now.mockReturnValue(300);
    wall.mockReturnValue(90_000);
    expect(invocationRemainingMs(await fixture.call("backward"))).toBe(900);
  } finally {
    await fixture.connection.dispose();
  }
});

test("WS calls beyond the handshake's 5000ms use session expiry without a per-call timer", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  const now = vi.spyOn(performance, "now").mockReturnValue(100);
  const wall = vi.spyOn(Date, "now").mockReturnValue(100_000);
  const fixture = socketFixture(160);
  try {
    await fixture.call("first");
    now.mockReturnValue(6100);
    wall.mockReturnValue(106_000);
    await vi.advanceTimersByTimeAsync(6000);
    const later = await fixture.call("later");
    expect(invocationRemainingMs(later)).toBe(54_000);
    expect(later.aborted).toBe(false);
    expect(fixture.closed).toEqual([]);
    expect(vi.getTimerCount()).toBe(2); // Existing expiry and heartbeat only.
  } finally {
    await fixture.connection.dispose();
  }
});

test("Effect shutdown composition preserves known bounds and still drains owned Promise work", async () => {
  vi.spyOn(performance, "now").mockReturnValue(100);
  const input = new AbortController().signal;
  constrainInvocationDeadline(input, 150);
  const runtime = createEffectRuntime(Layer.empty);
  const started = Promise.withResolvers<AbortSignal>();
  const finish = Promise.withResolvers<void>();
  const work = runtime.promise(
    { identity, requestId: "test" },
    async (context) => {
      started.resolve(context.signal);
      await finish.promise;
      return 1;
    },
    input,
  );
  const result = work.then(
    () => "success",
    () => "interrupted",
  );
  try {
    const signal = await started.promise;
    expect(invocationRemainingMs(signal)).toBe(50);
    const stopping = runtime.stop();
    expect(signal.aborted).toBe(true);
    expect(input.aborted).toBe(false);
    expect(invocationRemainingMs(signal)).toBe(50);
    finish.resolve();
    await stopping;
    expect(await result).toBe("interrupted");
  } finally {
    finish.resolve();
    await runtime.stop();
  }
});

test("Effect run preserves expired provenance and unknown external cancellation", async () => {
  vi.spyOn(performance, "now").mockReturnValue(100);
  const runtime = createEffectRuntime(Layer.empty);
  const external = new AbortController();
  const known = new AbortController().signal;
  constrainInvocationDeadline(known, 99);
  try {
    const expired = await runtime.run(
      { identity, requestId: "expired" },
      Effect.gen(function* () {
        return (yield* Invocation).signal;
      }),
      known,
    );
    expect(invocationRemainingMs(expired)).toBe(-1);
    expect(expired.aborted).toBe(false);
    const started = Promise.withResolvers<AbortSignal>();
    const work = runtime.run(
      { identity, requestId: "unknown" },
      Effect.gen(function* () {
        started.resolve((yield* Invocation).signal);
        yield* Effect.never;
      }),
      external.signal,
    );
    const result = work.then(
      () => "success",
      () => "interrupted",
    );
    const signal = await started.promise;
    expect(invocationRemainingMs(signal)).toBeUndefined();
    const reason = new Error("external abort");
    external.abort(reason);
    expect(signal.reason).toBe(reason);
    expect(await result).toBe("interrupted");
  } finally {
    await runtime.stop();
  }
});

const middlewareKinds = ["promise", "effect", "database-promise", "database-effect"] as const;
type MiddlewareKind = (typeof middlewareKinds)[number];
interface MiddlewareObservation {
  readonly signal: AbortSignal;
  readonly effectSignal: AbortSignal;
  readonly databaseBound: boolean;
}

function middlewareFixture(kind: MiddlewareKind, observe: (value: MiddlewareObservation) => Promise<void>) {
  const schema = defineSchema((s) => ({ tasks: { title: s.text().notNull() } }));
  const relations = defineRelations(schema.tables);
  const { procedure } = createProjectProcedures(schema, relations);
  const effects = createEffectRuntime(Layer.empty);
  const coordinator = createRevisionCoordinator({ readRevisions: async () => ({}) });
  // Offline SQL/transaction boundary only. No native database lifetime proof.
  const db = drizzle.mock({ relations });
  const tx = new NodePgTransaction(new PgDialect(), db._.session, relations, undefined, false);
  vi.spyOn(tx, "execute").mockResolvedValue({ rows: [], rowCount: 0, command: "SELECT", oid: 0, fields: [] });
  rememberDatabaseAdapter(tx, relations, () => {
    throw new Error("Fixture must use its original relations");
  });
  const transaction = vi.fn(() => {});
  // SAFETY: these read-only fixture procedures use connection.transaction, never pool operations.
  const pool = {} as Pool;
  const connection: databaseConnection.DatabaseConnection<typeof relations> = {
    db,
    pool,
    transaction: async (operation) => {
      transaction();
      return operation(tx);
    },
    close: async () => {},
  };
  const databaseBound = kind.startsWith("database-");
  if (databaseBound) {
    // Native connectDatabase owns this guard; this fixture replaces that boundary alone.
    vi.spyOn(databaseConnection, "captureInvocationGuard").mockReturnValue(() => {});
  }
  const databaseProcedure = procedure.use(createDatabaseMiddleware(relations, "read", schema));
  const capture = (context: ProcedureContext, effectSignal: AbortSignal) =>
    observe({ signal: context.signal, effectSignal, databaseBound: "db" in context });
  function* effectHandler({ context }: { readonly context: ProcedureContext }) {
    const invocation = yield* Invocation;
    yield* Effect.promise(() => capture(context, invocation.signal));
    return null;
  }
  const promiseHandler = async ({ context }: { readonly context: ProcedureContext }) => {
    await capture(context, Context.get(context["effect/context"], Invocation).signal);
    return null;
  };
  const leaf =
    kind === "effect"
      ? procedure.effect(effectHandler)
      : kind === "promise"
        ? procedure.handler(promiseHandler)
        : kind === "database-effect"
          ? databaseProcedure.effect(effectHandler)
          : databaseProcedure.handler(promiseHandler);
  const graph = bindRuntimeGraph({
    entries: [{ path: ["read"], visibility: "public", procedure: leaf }],
    database: {
      connection,
      replay: { deployment: version, metadataNamespace: "loom_deadline" },
      authorize: async () => {},
    },
    effects,
    coordinator,
    activate: async () => {},
    authorize: async () => {},
  });
  const read = graph.router.read;
  if (!(read instanceof Procedure)) throw new Error("Expected the bound native procedure");
  return {
    graph,
    read,
    effects,
    transaction,
    async dispose() {
      await graph.stop();
      await coordinator.stop();
      await effects.stop();
    },
  };
}

for (const kind of middlewareKinds) {
  for (const sessionMs of [10, 10_000]) {
    test(`HTTP native runtime middleware preserves request/session minima in ${kind} (${sessionMs}ms)`, async () => {
      const now = vi.spyOn(performance, "now").mockReturnValue(100);
      vi.spyOn(Date, "now").mockReturnValue(100_000);
      let observed: MiddlewareObservation | undefined;
      const fixture = middlewareFixture(kind, async (value) => {
        observed = value;
      });
      try {
        const app = createRpcHttpApp({
          router: fixture.graph.router,
          version,
          origins: [],
          requestTimeoutMs: 1000,
          verify: async () => {
            now.mockReturnValue(120);
            return { identity, expiresAt: (100_000 + sessionMs) / 1000 };
          },
        });
        const response = await app.fetch(
          new Request("https://service.test/api/kello/rpc/read", {
            method: "POST",
            headers: {
              authorization: "Bearer token",
              "content-type": "application/json",
              "x-loom-protocol": "loom-orpc-2",
              "x-loom-version": version,
            },
            body: JSON.stringify({ json: null }),
          }),
        );
        expect(response.status).toBe(200);
        expect(observed).toBeDefined();
        expect(invocationRemainingMs(observed!.signal)).toBe(Math.min(sessionMs, 980));
        expect(invocationRemainingMs(observed!.effectSignal)).toBe(Math.min(sessionMs, 980));
        expect(observed!.databaseBound).toBe(kind.startsWith("database-"));
        expect(fixture.transaction).toHaveBeenCalledTimes(kind.startsWith("database-") ? 1 : 0);
      } finally {
        await fixture.dispose();
      }
    });
  }

  test(`WS rollback keeps native session live but expires limiter authority after ${kind} middleware`, async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const now = vi.spyOn(performance, "now").mockReturnValue(100);
    const wall = vi.spyOn(Date, "now").mockReturnValue(100_000);
    const received = Promise.withResolvers<MiddlewareObservation>();
    const fixture = middlewareFixture(kind, async (value) => {
      received.resolve(value);
    });
    const closed: [number, string][] = [];
    const connection = createRpcSocketSession({
      router: fixture.graph.router,
      session: { identity, expiresAt: 110 },
      socket: {
        readyState: 1,
        bufferedAmount: 0,
        send: () => {},
        close: (code, reason) => closed.push([code, reason]),
      },
    });
    try {
      wall.mockReturnValue(90_000);
      now.mockReturnValue(10_101);
      await vi.advanceTimersByTimeAsync(10_000);
      connection.message(
        JSON.stringify({
          kind: "request",
          id: "expired",
          json: { url: "/read", method: "POST", body: { json: null } },
        }),
      );
      const observed = await received.promise;
      expect(closed).toEqual([]);
      expect(observed.signal.aborted).toBe(false);
      expect(invocationRemainingMs(observed.signal)).toBe(-1);
      expect(invocationRemainingMs(observed.effectSignal)).toBe(-1);
      expect(observed.databaseBound).toBe(kind.startsWith("database-"));
      expect(fixture.transaction).toHaveBeenCalledTimes(kind.startsWith("database-") ? 1 : 0);
    } finally {
      await connection.dispose();
      await fixture.dispose();
    }
  });
}

for (const cancellation of ["caller", "generation"] as const) {
  test(`database-bound native middleware retains caller minimum and ${cancellation} cancellation while draining`, async () => {
    vi.spyOn(performance, "now").mockReturnValue(100);
    const caller = new AbortController();
    constrainInvocationDeadline(caller.signal, 140);
    const contextSignal = new AbortController().signal;
    constrainInvocationDeadline(contextSignal, 150);
    const received = Promise.withResolvers<MiddlewareObservation>();
    const finish = Promise.withResolvers<void>();
    const fixture = middlewareFixture("database-promise", async (value) => {
      received.resolve(value);
      await finish.promise;
    });
    const context = { identity, requestId: "native", signal: contextSignal };
    const work = call(fixture.read, null, {
      context: { ...context, "effect/context": Context.make(Invocation, context) },
      signal: caller.signal,
    });
    const result = work.then(
      () => "success",
      () => "interrupted",
    );
    let stopping: Promise<void> | undefined;
    try {
      const observed = await received.promise;
      expect(invocationRemainingMs(observed.signal)).toBe(40);
      expect(observed.databaseBound).toBe(true);
      const reason = new Error("native caller cancellation");
      if (cancellation === "caller") caller.abort(reason);
      else stopping = fixture.effects.stop();
      expect(observed.signal.aborted).toBe(true);
      if (cancellation === "caller") expect(observed.signal.reason).toBe(reason);
      else expect(caller.signal.aborted).toBe(false);
      expect(contextSignal.aborted).toBe(false);
      let settled = false;
      void result.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      finish.resolve();
      await stopping;
      expect(await result).toBe("interrupted");
      expect(invocationRemainingMs(observed.signal)).toBe(40);
    } finally {
      finish.resolve();
      await result;
      await fixture.dispose();
    }
  });
}

test("native runtime and database middleware leave unknown caller bounds unknown", async () => {
  let observed: MiddlewareObservation | undefined;
  const fixture = middlewareFixture("database-effect", async (value) => {
    observed = value;
  });
  const context = { identity, requestId: "unknown", signal: new AbortController().signal };
  try {
    expect(
      await call(fixture.read, null, {
        context: { ...context, "effect/context": Context.make(Invocation, context) },
        signal: new AbortController().signal,
      }),
    ).toBeNull();
    expect(observed!.databaseBound).toBe(true);
    expect(invocationRemainingMs(observed!.signal)).toBeUndefined();
    expect(invocationRemainingMs(observed!.effectSignal)).toBeUndefined();
  } finally {
    await fixture.dispose();
  }
});
