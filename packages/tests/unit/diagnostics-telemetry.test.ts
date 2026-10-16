import { channel } from "node:diagnostics_channel";
import { createServer } from "node:http";
import { setTimeout } from "node:timers/promises";
import { Schema } from "effect";
import type { MetricsData } from "effect/observability/OtlpMetrics";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { startDiagnostics } from "../../../apps/loom/src/tooling/diagnostics/session";
import type { DiagnosticsSession } from "../../../apps/loom/src/tooling/diagnostics/types";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).reverse()) {
      const stopping = cleanup();
      if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(3000);
      await stopping;
    }
  } finally {
    vi.restoreAllMocks();
    vi.useRealTimers();
  }
});

async function collector(status: (request: number) => number | "hang" = () => 200) {
  const payloads: MetricsData[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      payloads.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      const code = status(payloads.length);
      if (code === "hang") return;
      response.statusCode = code;
      response.end("{}");
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || Schema.is(Schema.String)(address)) throw new Error("EXPECTED_IP_SOCKET");
  cleanups.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  );
  return {
    payloads,
    telemetry: { protocol: "otlp-http-json" as const, endpoint: `http://127.0.0.1:${address.port}/v1/metrics` },
  };
}

function own(session: DiagnosticsSession) {
  cleanups.push(() => session.stop());
  return session;
}

function hungTransport(firstAbortSettlementDelay = 0) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });
  const payloads: MetricsData[] = [];
  const startedAt: number[] = [];
  const abortedAt: number[] = [];
  const signals: AbortSignal[] = [];
  const pending = { current: 0, maximum: 0 };
  vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
    const signal = init?.signal;
    const body = init?.body;
    if (!signal || !(body instanceof ArrayBuffer)) throw new Error("EXPECTED_ABORTABLE_OTLP_REQUEST");
    payloads.push(JSON.parse(new TextDecoder().decode(body)));
    startedAt.push(performance.now());
    signals.push(signal);
    pending.current++;
    pending.maximum = Math.max(pending.maximum, pending.current);
    const delay = payloads.length === 1 ? firstAbortSettlementDelay : 0;
    return new Promise<Response>((_resolve, reject) => {
      const abort = () => {
        abortedAt.push(performance.now());
        const settle = () => {
          pending.current--;
          reject(signal.reason);
        };
        if (delay) globalThis.setTimeout(settle, delay);
        else settle();
      };
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
  });
  return {
    payloads,
    startedAt,
    abortedAt,
    signals,
    pending,
    telemetry: { protocol: "otlp-http-json" as const, endpoint: "http://127.0.0.1:4318/v1/metrics" },
  };
}

function rpc() {
  channel("kello.runtime.metric").publish({ type: "rpc.procedure", mode: "finite", status: "success", durationMs: 7 });
}

function counter(data: MetricsData, name: string, reason?: string) {
  const points = data.resourceMetrics
    .flatMap((resource) => resource.scopeMetrics.flatMap((scope) => scope.metrics))
    .filter((metric) => metric.name === name)
    .flatMap((metric) => metric.sum?.dataPoints ?? []);
  return points
    .filter(
      (point) =>
        reason === undefined ||
        point.attributes.some((attribute) => attribute.key === "reason" && attribute.value.stringValue === reason),
    )
    .reduce((total, point) => total + (point.asDouble ?? 0), 0);
}

async function until(check: () => boolean) {
  const deadline = performance.now() + 1500;
  while (!check()) {
    expect(performance.now()).toBeLessThan(deadline);
    await setTimeout(5);
  }
}

test("telemetry-only stop drains accepted ingress and exports final cumulative runtime, receipt and loss data", async () => {
  const target = await collector();
  const session = own(await startDiagnostics({ telemetry: target.telemetry }));
  for (let index = 0; index < 100; index++) rpc();
  channel("kello.deployment.metric").publish({
    type: "release.acknowledgement",
    stage: "activated",
    status: "recorded",
  });
  channel("kello.runtime.metric").publish({ type: "SECRET_UNKNOWN_EVENT" });
  const stopping = session.stop();
  expect(session.stop()).toBe(stopping);
  rpc();
  await stopping;
  expect(session.snapshot()).toEqual({ accepted: 101, invalid: 1, dropped: 0, outputFailures: 0, exportFailures: 0 });
  expect(target.payloads).toHaveLength(1);
  expect(counter(target.payloads[0]!, "kello.rpc.procedure.count")).toBe(100);
  expect(counter(target.payloads[0]!, "kello.deployment.acknowledgement.count")).toBe(1);
  expect(counter(target.payloads[0]!, "kello.diagnostics.loss.count", "invalid")).toBe(1);
  expect(JSON.stringify(target.payloads)).not.toContain("SECRET");
});

test("concurrent cold starts admit one owner before lazy telemetry imports settle", async () => {
  const target = await collector();
  const first = startDiagnostics({ telemetry: target.telemetry });
  await expect(startDiagnostics({ telemetry: target.telemetry })).rejects.toThrow(/^DIAGNOSTICS_ALREADY_ACTIVE$/);
  const session = own(await first);
  rpc();
  await session.stop();
  expect(target.payloads).toHaveLength(1);
  expect(counter(target.payloads[0]!, "kello.rpc.procedure.count")).toBe(1);
});

test("periodic outage recovery sends the next cumulative snapshot and export loss without replay", async () => {
  const target = await collector((request) => (request === 1 ? 500 : 200));
  const session = own(await startDiagnostics({ telemetry: target.telemetry }));
  rpc();
  await setTimeout(10_100);
  await until(() => session.snapshot().exportFailures === 1);
  expect(target.payloads).toHaveLength(1);
  rpc();
  await setTimeout(10_000);
  await until(() => target.payloads.length === 2);
  expect(counter(target.payloads[0]!, "kello.rpc.procedure.count")).toBe(1);
  expect(counter(target.payloads[1]!, "kello.rpc.procedure.count")).toBe(2);
  expect(counter(target.payloads[1]!, "kello.diagnostics.loss.count", "export")).toBe(1);
  await session.stop();
  expect(target.payloads).toHaveLength(3);
  expect(session.snapshot().exportFailures).toBe(1);
}, 30_000);

test("a hung final request respects the shared stop budget and releases the next owner", async () => {
  const target = hungTransport();
  const session = own(await startDiagnostics({ telemetry: target.telemetry }));
  rpc();
  const started = performance.now();
  let stoppedAt: number | undefined;
  const stopping = session.stop();
  expect(session.stop()).toBe(stopping);
  void stopping.then(() => {
    stoppedAt = performance.now();
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(target.startedAt).toEqual([started]);
  await vi.advanceTimersByTimeAsync(999);
  expect(stoppedAt).toBeUndefined();
  expect(target.signals[0]!.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(stoppedAt).toBe(started + 1000);
  await stopping;
  expect(performance.now() - started).toBeLessThan(2000);
  expect(session.snapshot().exportFailures).toBe(1);
  expect(counter(target.payloads[0]!, "kello.rpc.procedure.count")).toBe(1);
  expect(target.abortedAt).toEqual([started + 1000]);
  expect(target.pending).toEqual({ current: 0, maximum: 1 });
  const final = session.snapshot();
  const next = own(await startDiagnostics({ output: { format: "text", write() {} } }));
  rpc();
  const nextStopping = next.stop();
  await vi.advanceTimersByTimeAsync(0);
  await nextStopping;
  expect(next.snapshot().accepted).toBe(1);
  await vi.advanceTimersByTimeAsync(30);
  expect(session.snapshot()).toEqual(final);
  expect(target.payloads).toHaveLength(1);
});

test("stop during a hung periodic request shares one deadline with its final attempt", async () => {
  const target = hungTransport();
  const session = own(await startDiagnostics({ telemetry: target.telemetry }));
  rpc();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(target.payloads).toHaveLength(1);
  // Synchronize request age explicitly: 900 ms remain on the periodic request.
  await vi.advanceTimersByTimeAsync(100);
  const started = performance.now();
  expect(started - target.startedAt[0]!).toBe(100);
  let stoppedAt: number | undefined;
  const stopping = session.stop();
  expect(session.stop()).toBe(stopping);
  void stopping.then(() => {
    stoppedAt = performance.now();
  });
  await vi.advanceTimersByTimeAsync(899);
  expect(target.payloads).toHaveLength(1);
  expect(session.snapshot().exportFailures).toBe(0);
  expect(stoppedAt).toBeUndefined();
  await vi.advanceTimersByTimeAsync(1);
  expect(target.payloads).toHaveLength(2);
  expect(session.snapshot().exportFailures).toBe(1);
  await vi.advanceTimersByTimeAsync(999);
  expect(stoppedAt).toBeUndefined();
  await vi.advanceTimersByTimeAsync(1);
  expect(stoppedAt).toBe(started + 1900);
  await stopping;
  expect(performance.now() - started).toBeLessThan(2000);
  expect(target.payloads).toHaveLength(2);
  expect(session.snapshot().exportFailures).toBe(2);
  expect(target.startedAt).toEqual([started - 100, started + 900]);
  expect(target.abortedAt).toEqual([started + 900, started + 1900]);
  expect(target.pending).toEqual({ current: 0, maximum: 1 });
  for (const payload of target.payloads) expect(counter(payload, "kello.rpc.procedure.count")).toBe(1);
  expect(counter(target.payloads[1]!, "kello.diagnostics.loss.count", "export")).toBe(1);
  const final = session.snapshot();
  const next = own(await startDiagnostics({ output: { format: "text", write() {} } }));
  rpc();
  const nextStopping = next.stop();
  await vi.advanceTimersByTimeAsync(0);
  await nextStopping;
  expect(next.snapshot().accepted).toBe(1);
  await vi.advanceTimersByTimeAsync(30);
  expect(session.snapshot()).toEqual(final);
}, 15_000);

test("queued ingress and delayed abort settlement share the exact 2000 ms stop deadline", async () => {
  const target = hungTransport(500);
  const session = own(await startDiagnostics({ telemetry: target.telemetry }));
  rpc();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(target.payloads).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(100);
  // Multiple drain batches delay exporter.stop(), so a fresh exporter budget is observable.
  for (let index = 0; index < 1024; index++) rpc();
  const started = performance.now();
  expect(started - target.startedAt[0]!).toBe(100);
  let stoppedAt: number | undefined;
  const stopping = session.stop();
  expect(session.stop()).toBe(stopping);
  void stopping.then(() => {
    stoppedAt = performance.now();
  });
  await vi.advanceTimersByTimeAsync(1399);
  expect(target.abortedAt).toEqual([started + 900]);
  expect(target.payloads).toHaveLength(1);
  expect(session.snapshot().exportFailures).toBe(0);
  expect(stoppedAt).toBeUndefined();
  await vi.advanceTimersByTimeAsync(1);
  expect(target.startedAt).toEqual([started - 100, started + 1400]);
  expect(target.payloads).toHaveLength(2);
  expect(session.snapshot().exportFailures).toBe(1);
  expect(counter(target.payloads[0]!, "kello.rpc.procedure.count")).toBe(1);
  expect(counter(target.payloads[1]!, "kello.rpc.procedure.count")).toBe(1025);
  expect(counter(target.payloads[1]!, "kello.diagnostics.loss.count", "export")).toBe(1);
  await vi.advanceTimersByTimeAsync(599);
  expect(performance.now() - started).toBe(1999);
  expect(stoppedAt).toBeUndefined();
  expect(target.signals[1]!.aborted).toBe(false);
  await expect(startDiagnostics({ output: { format: "text", write() {} } }).then(own)).rejects.toThrow(
    /^DIAGNOSTICS_ALREADY_ACTIVE$/,
  );
  await vi.advanceTimersByTimeAsync(1);
  expect(stoppedAt).toBe(started + 2000);
  expect(target.abortedAt).toEqual([started + 900, started + 2000]);
  expect(target.signals.every((signal) => signal.aborted)).toBe(true);
  expect(target.pending).toEqual({ current: 0, maximum: 1 });
  await stopping;
  expect(session.snapshot()).toEqual({ accepted: 1025, invalid: 0, dropped: 0, outputFailures: 0, exportFailures: 2 });
  const final = session.snapshot();
  const next = own(await startDiagnostics({ output: { format: "text", write() {} } }));
  rpc();
  const nextStopping = next.stop();
  await vi.advanceTimersByTimeAsync(0);
  await nextStopping;
  expect(next.snapshot().accepted).toBe(1);
  await vi.advanceTimersByTimeAsync(30);
  expect(session.snapshot()).toEqual(final);
  expect(target.payloads).toHaveLength(2);
  expect(vi.getTimerCount()).toBe(0);
});

test("a stalled writer and output-ring saturation do not discard metric observations", async () => {
  const target = await collector();
  const release = Promise.withResolvers<void>();
  let calls = 0;
  const session = own(
    await startDiagnostics({
      telemetry: target.telemetry,
      output: {
        format: "jsonl",
        write() {
          calls++;
          return release.promise;
        },
      },
    }),
  );
  rpc();
  await until(() => calls === 1);
  for (let index = 0; index < 600; index++) rpc();
  // 600 drained records leave 256 queued and 344 dropped behind the active writer.
  await until(() => session.snapshot().dropped === 344);
  await session.stop();
  expect(session.snapshot().accepted).toBe(601);
  expect(session.snapshot().dropped).toBe(600);
  expect(calls).toBe(1);
  expect(target.payloads).toHaveLength(1);
  expect(counter(target.payloads[0]!, "kello.rpc.procedure.count")).toBe(601);
  expect(counter(target.payloads[0]!, "kello.diagnostics.loss.count", "output_queue")).toBe(600);
  release.resolve();
  await setTimeout(0);
  expect(calls).toBe(1);
});

test("output failure disables only that sink and final metrics retain later events", async () => {
  const target = await collector();
  let calls = 0;
  const session = own(
    await startDiagnostics({
      telemetry: target.telemetry,
      output: {
        format: "text",
        write() {
          calls++;
          throw new Error("PRIVATE_WRITER_ERROR");
        },
      },
    }),
  );
  rpc();
  await until(() => session.snapshot().outputFailures === 1);
  for (let index = 0; index < 10; index++) rpc();
  await session.stop();
  expect(calls).toBe(1);
  expect(session.snapshot().accepted).toBe(11);
  expect(session.snapshot().outputFailures).toBe(1);
  expect(target.payloads).toHaveLength(1);
  expect(counter(target.payloads[0]!, "kello.rpc.procedure.count")).toBe(11);
  expect(counter(target.payloads[0]!, "kello.diagnostics.loss.count", "output")).toBe(1);
  expect(JSON.stringify(target.payloads)).not.toContain("PRIVATE_WRITER_ERROR");
});

test("invalid telemetry startup releases ownership and competing startup cannot disturb the valid session", async () => {
  const target = await collector();
  await expect(
    startDiagnostics({ telemetry: { ...target.telemetry, endpoint: "http://SECRET.invalid/metrics" } }),
  ).rejects.toThrow(/^TELEMETRY_CONFIG_INVALID$/);
  const session = own(await startDiagnostics({ telemetry: target.telemetry }));
  await expect(startDiagnostics({ telemetry: target.telemetry })).rejects.toThrow(/^DIAGNOSTICS_ALREADY_ACTIVE$/);
  rpc();
  await session.stop();
  expect(counter(target.payloads[0]!, "kello.rpc.procedure.count")).toBe(1);
  expect(target.payloads).toHaveLength(1);
});

test("ingress saturation exports only accepted observations and the exact ingress loss", async () => {
  const target = await collector();
  const session = own(await startDiagnostics({ telemetry: target.telemetry }));
  for (let index = 0; index < 1100; index++) rpc();
  expect(session.snapshot().accepted).toBe(1024);
  expect(session.snapshot().dropped).toBe(76);
  await session.stop();
  expect(target.payloads).toHaveLength(1);
  expect(counter(target.payloads[0]!, "kello.rpc.procedure.count")).toBe(1024);
  expect(counter(target.payloads[0]!, "kello.diagnostics.loss.count", "ingress_queue")).toBe(76);
});

test("unsafe metric accumulation is refused atomically and counted as a dropped observation", async () => {
  const target = await collector();
  const session = own(await startDiagnostics({ telemetry: target.telemetry }));
  const runtime = channel("kello.runtime.metric");
  runtime.publish({ type: "job.lease.reaped", count: Number.MAX_SAFE_INTEGER });
  runtime.publish({ type: "job.lease.reaped", count: 1 });
  for (let index = 0; index < 2; index++) {
    runtime.publish({ type: "rpc.procedure", mode: "finite", status: "success", durationMs: Number.MAX_VALUE });
    runtime.publish({ type: "job.claim", ageMs: Number.MAX_VALUE, dueLagMs: 1, attempt: 1, recovered: false });
  }
  await session.stop();
  expect(session.snapshot()).toEqual({ accepted: 6, invalid: 0, dropped: 3, outputFailures: 0, exportFailures: 0 });
  const payload = target.payloads[0]!;
  expect(counter(payload, "kello.job.lease.reaped.count")).toBe(Number.MAX_SAFE_INTEGER);
  expect(counter(payload, "kello.rpc.procedure.count")).toBe(1);
  expect(counter(payload, "kello.job.claim.count")).toBe(1);
  expect(counter(payload, "kello.diagnostics.loss.count", "ingress_queue")).toBe(3);
  const dueLag = payload.resourceMetrics
    .flatMap((resource) => resource.scopeMetrics.flatMap((scope) => scope.metrics))
    .find((metric) => metric.name === "kello.job.claim.due_lag")?.histogram?.dataPoints[0];
  expect(dueLag).toMatchObject({ count: 1, sum: 1 });
});
