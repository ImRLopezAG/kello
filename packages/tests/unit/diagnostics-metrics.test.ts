import { afterEach, describe, expect, expectTypeOf, test, vi } from "vite-plus/test";
import { Context, Effect, Metric } from "effect";
import type { MetricsData } from "effect/observability/OtlpMetrics";
import { OtlpSerialization, layerJson } from "effect/observability/OtlpSerialization";
import { createDiagnosticsMetrics } from "../../../apps/loom/src/tooling/diagnostics/metrics";
import type {
  DiagnosticsDeploymentEvent,
  DiagnosticsRuntimeEvent,
} from "../../../apps/loom/src/tooling/diagnostics/types";
import packageJson from "../../../apps/loom/package.json" with { type: "json" };

type MetricData = MetricsData["resourceMetrics"][number]["scopeMetrics"][number]["metrics"][number];
function instruments(payload: MetricsData): MetricData[] {
  return payload.resourceMetrics.flatMap((resource) => resource.scopeMetrics.flatMap((scope) => scope.metrics));
}

function fullMappingFixture(durationMs = 7): (DiagnosticsRuntimeEvent | DiagnosticsDeploymentEvent)[] {
  const events: (DiagnosticsRuntimeEvent | DiagnosticsDeploymentEvent)[] = [];
  for (const mode of ["finite", "live", "mutation"] as const) {
    for (const status of ["success", "error"] as const)
      events.push({ type: "rpc.procedure", mode, status, durationMs });
  }
  for (const status of ["success", "error"] as const) {
    events.push({ type: "revision.read", status, durationMs, tableCount: 99 });
    events.push({ type: "database.acquire", status, durationMs, total: 99, idle: 98, waiting: 97 });
  }
  for (const kind of ["query", "mutation"] as const) events.push({ type: "transaction.retry", kind, attempt: 99 });
  for (const recovered of [false, true])
    events.push({ type: "job.claim", recovered, ageMs: durationMs, dueLagMs: durationMs, attempt: 99 });
  events.push({ type: "job.lease.reaped", count: 17 });
  for (const reason of ["deadline", "ownership", "activation", "queue"] as const)
    events.push({ type: "job.lease.lost", reason });
  for (const stage of [
    "metadata",
    "quarantine",
    "migrations",
    "prepared",
    "bootstrap",
    "triggers",
    "functions",
    "health",
    "activated",
    "complete",
  ] as const) {
    for (const status of ["recorded", "replayed", "write-error"] as const)
      events.push({ type: "release.acknowledgement", stage, status });
  }
  return events;
}

const lossReasons = ["invalid", "ingress_queue", "output_queue", "output", "export"] as const;
function seriesKeys(payload: MetricsData): string[] {
  return instruments(payload)
    .flatMap((metric) =>
      (metric.sum?.dataPoints ?? metric.histogram?.dataPoints ?? []).map(
        (point) =>
          `${metric.name}|${(point.attributes ?? [])
            .map(({ key, value }) => `${key}=${value.stringValue}`)
            .sort()
            .join(",")}`,
      ),
    )
    .sort();
}

describe("private diagnostics metrics", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });
  test("one finite successful RPC produces a monotonic count and explicit millisecond histogram", () => {
    const metrics = createDiagnosticsMetrics();
    expect(metrics.observe({ type: "rpc.procedure", mode: "finite", status: "success", durationMs: 7 })).toBe(true);
    const payload: MetricsData = metrics.snapshot();
    expect(payload.resourceMetrics[0]?.resource.droppedAttributesCount).toBe(0);
    const data = instruments(payload);
    expect(data).toHaveLength(2);
    expect(data.find((metric) => metric.name === "kello.rpc.procedure.count")).toMatchObject({
      unit: "{event}",
      sum: {
        aggregationTemporality: 2,
        isMonotonic: true,
        dataPoints: [
          {
            asDouble: 1,
            attributes: [
              { key: "mode", value: { stringValue: "finite" } },
              { key: "status", value: { stringValue: "success" } },
            ],
          },
        ],
      },
    });
    expect(data.find((metric) => metric.name === "kello.rpc.procedure.duration")).toMatchObject({
      unit: "ms",
      histogram: {
        aggregationTemporality: 2,
        dataPoints: [
          {
            count: 1,
            sum: 7,
            explicitBounds: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 5000, 30000, 60000],
            bucketCounts: [0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
          },
        ],
      },
    });
  });

  test("invalid durations and an overflowing finite sum reject the whole RPC observation", () => {
    const metrics = createDiagnosticsMetrics();
    const event = { type: "rpc.procedure", mode: "finite", status: "success", durationMs: 0 } as const;
    for (const durationMs of [-1, NaN, Infinity, -Infinity]) {
      expect(metrics.observe({ ...event, durationMs })).toBe(false);
      expect(instruments(metrics.snapshot())).toEqual([]);
    }
    expect(metrics.observe({ ...event, durationMs: Number.MAX_VALUE })).toBe(true);
    const before = instruments(metrics.snapshot());
    expect(metrics.observe({ ...event, durationMs: Number.MAX_VALUE })).toBe(false);
    const after = instruments(metrics.snapshot());
    expect(after[0]?.sum?.dataPoints[0]?.asDouble).toBe(1);
    expect(after[1]?.histogram?.dataPoints[0]).toMatchObject({
      count: 1,
      sum: Number.MAX_VALUE,
      bucketCounts: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
    });
    expect(after[1]?.histogram?.dataPoints[0]?.sum).toBe(before[1]?.histogram?.dataPoints[0]?.sum);
    expect(metrics.observe({ ...event, mode: "mutation", durationMs: 5 })).toBe(true);
    expect(instruments(metrics.snapshot())[0]?.sum?.dataPoints.map((point) => point.asDouble)).toEqual([1, 1]);
  });

  test("all six RPC tuples produce exactly twelve series and ignore event payload labels", () => {
    const metrics = createDiagnosticsMetrics();
    for (const mode of ["finite", "live", "mutation"] as const) {
      for (const status of ["success", "error"] as const) {
        const event = {
          type: "rpc.procedure" as const,
          mode,
          status,
          durationMs: 5,
          procedure: "PAYLOAD_CANARY",
          token: "PAYLOAD_CANARY",
        };
        expect(metrics.observe(event)).toBe(true);
        expect(metrics.observe(event)).toBe(true);
      }
    }
    const payload = metrics.snapshot();
    expectTypeOf(payload).toEqualTypeOf<MetricsData>();
    const data = instruments(payload);
    expect(data.map((metric) => metric.name)).toEqual(["kello.rpc.procedure.count", "kello.rpc.procedure.duration"]);
    const expectedAttributes = [
      ["finite", "success"],
      ["finite", "error"],
      ["live", "success"],
      ["live", "error"],
      ["mutation", "success"],
      ["mutation", "error"],
    ].map(([mode, status]) => [
      { key: "mode", value: { stringValue: mode } },
      { key: "status", value: { stringValue: status } },
    ]);
    expect(data[0]?.sum?.dataPoints).toHaveLength(6);
    expect(data[1]?.histogram?.dataPoints).toHaveLength(6);
    expect(data[0]?.sum?.dataPoints.map((point) => point.attributes)).toEqual(expectedAttributes);
    expect(data[1]?.histogram?.dataPoints.map((point) => point.attributes)).toEqual(expectedAttributes);
    expect(data[0]?.sum?.dataPoints.map((point) => point.asDouble)).toEqual([2, 2, 2, 2, 2, 2]);
    for (const point of data[1]!.histogram!.dataPoints) {
      expect(point).toMatchObject({ count: 2, sum: 10, bucketCounts: [0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] });
      expect(Object.keys(point).sort()).toEqual([
        "attributes",
        "bucketCounts",
        "count",
        "explicitBounds",
        "startTimeUnixNano",
        "sum",
        "timeUnixNano",
      ]);
    }
    expect(JSON.stringify(payload)).not.toContain("PAYLOAD_CANARY");
    expect(data.every((metric) => !metric.gauge && !metric.summary && !metric.exponentialHistogram)).toBe(true);
  });

  test("exact boundaries and values above 60000ms become per-bucket counts, retaining zero-duration samples", () => {
    const metrics = createDiagnosticsMetrics();
    for (const durationMs of [0, 1, 2, 5, 7, 10, 25, 50, 100, 250, 500, 1000, 5000, 30000, 60000, 60001]) {
      expect(metrics.observe({ type: "rpc.procedure", mode: "live", status: "error", durationMs })).toBe(true);
    }
    const data = instruments(metrics.snapshot());
    expect(data[0]?.sum?.dataPoints[0]?.asDouble).toBe(16);
    expect(data[1]?.histogram?.dataPoints[0]).toMatchObject({
      count: 16,
      sum: 156951,
      explicitBounds: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 5000, 30000, 60000],
      bucketCounts: [2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    });
  });

  test("snapshots retain cumulative counts and a fixed decimal-nanosecond session start", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-07T00:00:00.000Z"));
    const metrics = createDiagnosticsMetrics();
    const event = { type: "rpc.procedure", mode: "mutation", status: "success", durationMs: 1 } as const;
    metrics.observe(event);
    vi.advanceTimersByTime(10);
    const first = instruments(metrics.snapshot());
    metrics.observe({ ...event, durationMs: 5 });
    vi.advanceTimersByTime(20);
    const second = instruments(metrics.snapshot());
    expect(first[0]?.sum?.dataPoints[0]?.asDouble).toBe(1);
    expect(first[1]?.histogram?.dataPoints[0]).toMatchObject({ count: 1, sum: 1 });
    expect(second[0]?.sum?.dataPoints[0]?.asDouble).toBe(2);
    expect(second[1]?.histogram?.dataPoints[0]).toMatchObject({ count: 2, sum: 6 });
    for (const point of [first[0]!.sum!.dataPoints[0], first[1]!.histogram!.dataPoints[0]]) {
      expect(point).toMatchObject({ startTimeUnixNano: "1791331200000000000", timeUnixNano: "1791331200010000000" });
    }
    for (const point of [second[0]!.sum!.dataPoints[0], second[1]!.histogram!.dataPoints[0]]) {
      expect(point).toMatchObject({ startTimeUnixNano: "1791331200000000000", timeUnixNano: "1791331200030000000" });
    }
    expect(instruments(metrics.snapshot())).toEqual(second);
  });

  test("fresh sessions exclude real global metrics and ambient OTEL resources, with exactly four resource attributes", () => {
    for (const name of [
      "OTEL_RESOURCE_ATTRIBUTES",
      "OTEL_SERVICE_NAME",
      "OTEL_EXPORTER_OTLP_ENDPOINT",
      "OTEL_EXPORTER_OTLP_HEADERS",
    ]) {
      vi.stubEnv(name, "AMBIENT_OTEL_CANARY");
    }
    const canary = Metric.counter("GLOBAL_DIAGNOSTICS_CANARY");
    const globalContext = Context.empty();
    canary.updateUnsafe(123, globalContext);
    expect(Metric.snapshotUnsafe(globalContext).some((metric) => metric.id === canary.id)).toBe(true);
    const first = createDiagnosticsMetrics();
    const second = createDiagnosticsMetrics();
    const event = { type: "rpc.procedure", mode: "finite", status: "success", durationMs: 1 } as const;
    first.observe(event);
    first.observe(event);
    second.observe(event);
    const firstSnapshot = first.snapshot();
    const secondSnapshot = second.snapshot();
    const resource = firstSnapshot.resourceMetrics[0]!.resource.attributes;
    expect(resource).toEqual([
      { key: "service.name", value: { stringValue: "kello-dev" } },
      { key: "service.version", value: { stringValue: packageJson.version } },
      { key: "deployment.environment.name", value: { stringValue: "development" } },
      {
        key: "service.instance.id",
        value: {
          stringValue: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
        },
      },
    ]);
    expect(secondSnapshot.resourceMetrics[0]!.resource.attributes[3]).not.toEqual(resource[3]);
    expect(first.snapshot().resourceMetrics[0]!.resource.attributes).toEqual(resource);
    expect(instruments(firstSnapshot)[0]?.sum?.dataPoints[0]?.asDouble).toBe(2);
    expect(instruments(secondSnapshot)[0]?.sum?.dataPoints[0]?.asDouble).toBe(1);
    expect(JSON.stringify(firstSnapshot)).not.toContain("CANARY");
    expect(JSON.stringify(secondSnapshot)).not.toContain("CANARY");
    expect(Effect.runSync(Metric.value(canary)).count).toBe(123);
  });

  test("excluded variants register nothing and malformed RPC tuples cannot create arbitrary series", () => {
    const metrics = createDiagnosticsMetrics();
    expect(metrics.observe({ type: "realtime.coordinator", subscriptions: 10, evaluating: 2, queued: 3 })).toBe(true);
    expect(metrics.observe({ type: "realtime.listener", status: "connected" })).toBe(true);
    for (const event of [
      { type: "rpc.procedure", mode: "arbitrary", status: "success", durationMs: 1 },
      { type: "rpc.procedure", mode: "finite", status: "arbitrary", durationMs: 1 },
    ]) {
      // SAFETY: Deliberately invalid tuples exercise rejection at the internal event boundary.
      expect(metrics.observe(event as DiagnosticsRuntimeEvent)).toBe(false);
    }
    expect(instruments(metrics.snapshot())).toEqual([]);
  });

  test("full mapping is exactly 68 fixed tuples, 54 counters and 14 histograms", () => {
    const metrics = createDiagnosticsMetrics();
    for (const event of fullMappingFixture()) {
      const labeledEvent = { ...event, secret: "PAYLOAD_CANARY", sequence: 99 };
      expect(metrics.observe(labeledEvent)).toBe(true);
    }
    for (const reason of lossReasons) expect(metrics.loss(reason, 3)).toBe(true);
    const expected: string[] = [];
    for (const mode of ["finite", "live", "mutation"])
      for (const status of ["success", "error"]) {
        for (const suffix of ["count", "duration"])
          expected.push(`kello.rpc.procedure.${suffix}|mode=${mode},status=${status}`);
      }
    for (const prefix of ["revision.read", "database.acquire"])
      for (const status of ["success", "error"]) {
        for (const suffix of ["count", "duration"]) expected.push(`kello.${prefix}.${suffix}|status=${status}`);
      }
    for (const kind of ["query", "mutation"]) expected.push(`kello.transaction.retry.count|kind=${kind}`);
    for (const recovered of ["false", "true"])
      for (const suffix of ["count", "age", "due_lag"])
        expected.push(`kello.job.claim.${suffix}|recovered=${recovered}`);
    expected.push("kello.job.lease.reaped.count|");
    for (const reason of ["deadline", "ownership", "activation", "queue"])
      expected.push(`kello.job.lease.lost.count|reason=${reason}`);
    for (const stage of [
      "metadata",
      "quarantine",
      "migrations",
      "prepared",
      "bootstrap",
      "triggers",
      "functions",
      "health",
      "activated",
      "complete",
    ]) {
      for (const status of ["recorded", "replayed", "write-error"])
        expected.push(`kello.deployment.acknowledgement.count|stage=${stage},status=${status}`);
    }
    for (const reason of lossReasons) expected.push(`kello.diagnostics.loss.count|reason=${reason}`);
    const payload = metrics.snapshot();
    expect(seriesKeys(payload)).toEqual(expected.sort());
    expect(expected).toHaveLength(68);
    const data = instruments(payload);
    expect(data.reduce((sum, metric) => sum + (metric.sum?.dataPoints.length ?? 0), 0)).toBe(54);
    expect(data.reduce((sum, metric) => sum + (metric.histogram?.dataPoints.length ?? 0), 0)).toBe(14);
    for (const metric of data) {
      expect(metric.unit).toBe(
        metric.histogram ? "ms" : metric.name === "kello.job.lease.reaped.count" ? "{job}" : "{event}",
      );
      expect(metric.gauge ?? metric.summary ?? metric.exponentialHistogram).toBeUndefined();
      if (metric.sum) expect(metric.sum).toMatchObject({ aggregationTemporality: 2, isMonotonic: true });
      if (metric.histogram) expect(metric.histogram).toMatchObject({ aggregationTemporality: 2 });
      for (const point of metric.sum?.dataPoints ?? []) {
        expect(point.asDouble).toBe(
          metric.name === "kello.job.lease.reaped.count" ? 17 : metric.name === "kello.diagnostics.loss.count" ? 3 : 1,
        );
      }
      for (const point of metric.histogram?.dataPoints ?? []) {
        expect(point).toMatchObject({ count: 1, sum: 7, bucketCounts: [0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] });
      }
    }
    expect(JSON.stringify(payload)).not.toContain("PAYLOAD_CANARY");
    expect(JSON.stringify(payload)).not.toContain("attempt");
    expect(JSON.stringify(payload)).not.toContain("tableCount");
    expect(seriesKeys(payload).length).toBeLessThanOrEqual(128);
  });

  test("full snapshots remain cumulative and detached, and a second session has independent resources and state", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-07T00:00:00.000Z"));
    const first = createDiagnosticsMetrics();
    const second = createDiagnosticsMetrics();
    const events = fullMappingFixture();
    for (const metrics of [first, second]) {
      for (const event of events) metrics.observe(event);
      for (const reason of lossReasons) metrics.loss(reason, 3);
    }
    const baseline = first.snapshot();
    const secondBaseline = second.snapshot();
    for (const event of events) first.observe(event);
    for (const reason of lossReasons) first.loss(reason, 3);
    vi.advanceTimersByTime(10);
    const cumulative = first.snapshot();
    for (const metric of instruments(cumulative)) {
      for (const point of metric.sum?.dataPoints ?? []) {
        expect(point.asDouble).toBe(
          metric.name === "kello.job.lease.reaped.count" ? 34 : metric.name === "kello.diagnostics.loss.count" ? 6 : 2,
        );
        expect(point.startTimeUnixNano).toBe("1791331200000000000");
        expect(point.timeUnixNano).toBe("1791331200010000000");
      }
      for (const point of metric.histogram?.dataPoints ?? []) expect(point).toMatchObject({ count: 2, sum: 14 });
    }
    expect(first.snapshot()).toEqual(cumulative);
    expect(
      instruments(second.snapshot()).map(
        (metric) =>
          metric.sum?.dataPoints.map((point) => point.asDouble) ??
          metric.histogram?.dataPoints.map((point) => point.sum),
      ),
    ).toEqual(
      instruments(secondBaseline).map(
        (metric) =>
          metric.sum?.dataPoints.map((point) => point.asDouble) ??
          metric.histogram?.dataPoints.map((point) => point.sum),
      ),
    );
    expect(baseline.resourceMetrics[0]!.resource.attributes).toHaveLength(4);
    expect(secondBaseline.resourceMetrics[0]!.resource.attributes).toHaveLength(4);
    expect(baseline.resourceMetrics[0]!.resource.attributes[3]).not.toEqual(
      secondBaseline.resourceMetrics[0]!.resource.attributes[3],
    );
    expect(
      instruments(baseline).find((metric) => metric.name === "kello.job.claim.age")?.histogram?.dataPoints[0],
    ).toMatchObject({ count: 1, sum: 7 });
    instruments(cumulative)[0]!.sum!.dataPoints[0]!.asDouble = 123;
    expect(first.snapshot()).not.toEqual(cumulative);
    expect(Object.keys(first).sort()).toEqual(["loss", "observe", "snapshot"]);
  });

  test("reaped adds jobs, retry adds one regardless of attempt, and nested durations remain independent", () => {
    const metrics = createDiagnosticsMetrics();
    metrics.observe({ type: "job.lease.reaped", count: 17 });
    metrics.observe({ type: "job.lease.reaped", count: 3 });
    for (const attempt of [1, 99]) metrics.observe({ type: "transaction.retry", kind: "query", attempt });
    metrics.observe({ type: "rpc.procedure", mode: "mutation", status: "success", durationMs: 100 });
    metrics.observe({ type: "revision.read", status: "success", tableCount: 10, durationMs: 25 });
    metrics.observe({ type: "database.acquire", status: "success", total: 3, idle: 2, waiting: 1, durationMs: 7 });
    metrics.observe({ type: "job.claim", recovered: true, attempt: 99, ageMs: 500, dueLagMs: 10 });
    const data = instruments(metrics.snapshot());
    expect(data.find((metric) => metric.name === "kello.job.lease.reaped.count")?.sum?.dataPoints[0]?.asDouble).toBe(
      20,
    );
    expect(data.find((metric) => metric.name === "kello.transaction.retry.count")?.sum?.dataPoints[0]?.asDouble).toBe(
      2,
    );
    for (const [name, sum] of [
      ["rpc.procedure.duration", 100],
      ["revision.read.duration", 25],
      ["database.acquire.duration", 7],
      ["job.claim.age", 500],
      ["job.claim.due_lag", 10],
    ] as const) {
      expect(data.find((metric) => metric.name === `kello.${name}`)?.histogram?.dataPoints[0]).toMatchObject({
        count: 1,
        sum,
      });
    }
  });

  test("loss reasons and reaped counters reject invalid and overflowing additions without mutation", () => {
    const metrics = createDiagnosticsMetrics();
    for (const count of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(metrics.loss("invalid", count)).toBe(false);
      expect(metrics.observe({ type: "job.lease.reaped", count })).toBe(false);
    }
    expect(instruments(metrics.snapshot())).toEqual([]);
    // SAFETY: Deliberately violate the private typed boundary to prove no arbitrary tuple is admitted.
    expect(metrics.loss("arbitrary" as "invalid", 1)).toBe(false);
    for (const reason of lossReasons) {
      expect(metrics.loss(reason, Number.MAX_SAFE_INTEGER)).toBe(true);
      expect(metrics.loss(reason, 1)).toBe(false);
      expect(metrics.loss(reason, 0)).toBe(true);
    }
    expect(metrics.observe({ type: "job.lease.reaped", count: Number.MAX_SAFE_INTEGER })).toBe(true);
    expect(metrics.observe({ type: "job.lease.reaped", count: 1 })).toBe(false);
    for (const metric of instruments(metrics.snapshot()))
      for (const point of metric.sum!.dataPoints) expect(point.asDouble).toBe(Number.MAX_SAFE_INTEGER);
  });

  test("claim admission rejects all instruments if either duration is invalid or either sum overflows", () => {
    for (const field of ["ageMs", "dueLagMs"] as const) {
      const metrics = createDiagnosticsMetrics();
      const event = { type: "job.claim", recovered: false, attempt: 1, ageMs: 1, dueLagMs: 5 } as const;
      for (const value of [-1, NaN, Infinity]) {
        expect(metrics.observe({ ...event, [field]: value })).toBe(false);
        expect(instruments(metrics.snapshot())).toEqual([]);
      }
      expect(metrics.observe({ ...event, [field]: Number.MAX_VALUE })).toBe(true);
      vi.useFakeTimers();
      const before = metrics.snapshot();
      expect(metrics.observe({ ...event, [field]: Number.MAX_VALUE })).toBe(false);
      expect(metrics.snapshot()).toEqual(before);
      vi.useRealTimers();
    }
  });

  test("the full maximum-numeric-value OTLP fixture stays below 128 KiB", async () => {
    const metrics = createDiagnosticsMetrics();
    for (const event of fullMappingFixture(Number.MAX_VALUE)) expect(metrics.observe(event)).toBe(true);
    for (const reason of lossReasons) expect(metrics.loss(reason, Number.MAX_SAFE_INTEGER)).toBe(true);
    const payload: MetricsData = metrics.snapshot();
    expect(seriesKeys(payload)).toHaveLength(68);
    // Typed wire fixture at the numeric limits: every bucket can hold Uint32.MAX_VALUE.
    // Counters reach MAX_SAFE_INTEGER through count-based observations; no private registry seam.
    for (const metric of instruments(payload)) {
      for (const point of metric.sum?.dataPoints ?? metric.histogram?.dataPoints ?? []) {
        point.startTimeUnixNano = "18446744073709551615";
        point.timeUnixNano = "18446744073709551615";
      }
      for (const point of metric.sum?.dataPoints ?? []) point.asDouble = Number.MAX_SAFE_INTEGER;
      for (const point of metric.histogram?.dataPoints ?? []) {
        point.count = 13 * 0xffff_ffff;
        point.bucketCounts = Array.from({ length: 13 }, () => 0xffff_ffff);
        point.sum = Number.MAX_VALUE;
      }
    }
    const body = await Effect.runPromise(
      Effect.gen(function* () {
        const serialization = yield* OtlpSerialization;
        return serialization.metrics(payload);
      }).pipe(Effect.provide(layerJson)),
    );
    expect(body._tag).toBe("Uint8Array");
    if (body._tag !== "Uint8Array") throw new Error("Expected OTLP JSON bytes");
    const bytes = body.body;
    expect(bytes.byteLength).toBeLessThanOrEqual(128 * 1024);
    // SAFETY: The upstream serializer receives the typed payload; exact equality below verifies the round trip.
    const decoded = JSON.parse(new TextDecoder().decode(bytes)) as MetricsData;
    expect(decoded).toEqual(payload);
    expect(seriesKeys(decoded)).toEqual(seriesKeys(payload));
    expect(instruments(decoded).flatMap((metric) => metric.histogram?.dataPoints ?? [])).toHaveLength(14);
  });
});
