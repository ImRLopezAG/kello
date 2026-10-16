import { randomUUID } from "node:crypto";
import { Context, Metric, Schema } from "effect";
import type { MetricsData } from "effect/observability/OtlpMetrics";
import packageJson from "../../../package.json" with { type: "json" };
import type { DiagnosticsDeploymentEvent, DiagnosticsRuntimeEvent } from "./types";

const boundaries = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 5000, 30000, 60000];
type Event = DiagnosticsRuntimeEvent | DiagnosticsDeploymentEvent;
type EventOf<T extends Event["type"]> = Extract<Event, { type: T }>;
type LossReason = "invalid" | "ingress_queue" | "output_queue" | "output" | "export";
// Records make union additions a compile-time mapping review, including attribute values.
const modes = { finite: true, live: true, mutation: true } satisfies Record<EventOf<"rpc.procedure">["mode"], true>;
const statuses = { success: true, error: true } satisfies Record<
  EventOf<"rpc.procedure" | "revision.read" | "database.acquire">["status"],
  true
>;
const retryKinds = { query: true, mutation: true } satisfies Record<EventOf<"transaction.retry">["kind"], true>;
const lostReasons = { deadline: true, ownership: true, activation: true, queue: true } satisfies Record<
  EventOf<"job.lease.lost">["reason"],
  true
>;
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
} satisfies Record<DiagnosticsDeploymentEvent["stage"], true>;
const acknowledgementStatuses = { recorded: true, replayed: true, "write-error": true } satisfies Record<
  DiagnosticsDeploymentEvent["status"],
  true
>;
const lossReasons = {
  invalid: true,
  ingress_queue: true,
  output_queue: true,
  output: true,
  export: true,
} satisfies Record<LossReason, true>;
type Attributes = Record<string, string>;
const seriesKey = (name: string, attributes: Attributes) => JSON.stringify([name, attributes]);
const counterMetric = (name: string, attributes: Attributes) => Metric.counter(name, { incremental: true, attributes });
const histogramMetric = (name: string, attributes: Attributes) =>
  Metric.histogram(name, {
    boundaries: Metric.boundariesFromIterable(boundaries),
    attributes,
  });
type Series =
  | { readonly type: "counter"; readonly metric: ReturnType<typeof counterMetric> }
  | { readonly type: "histogram"; readonly metric: ReturnType<typeof histogramMetric> };
type Update = { readonly series: Series; readonly value: number };
type MetricData = MetricsData["resourceMetrics"][number]["scopeMetrics"][number]["metrics"][number];
const nanoseconds = () => (BigInt(Date.now()) * 1_000_000n).toString();
const isNumber = Schema.is(Schema.Number);

/** Internal fixed cumulative mapping; session opt-in and serialization are separate. */
export function createDiagnosticsMetrics() {
  const context = Context.make(Metric.MetricRegistry, new Map());
  const startTimeUnixNano = nanoseconds();
  const instanceId = randomUUID();
  const series = new Map<string, Series>();
  const addCounter = (name: string, attributes: Attributes) =>
    series.set(seriesKey(name, attributes), {
      type: "counter",
      metric: counterMetric(name, attributes),
    });
  const addHistogram = (name: string, attributes: Attributes) =>
    series.set(seriesKey(name, attributes), {
      type: "histogram",
      metric: histogramMetric(name, attributes),
    });
  const addDuration = (name: string, attributes: Attributes) => {
    addCounter(`${name}.count`, attributes);
    addHistogram(`${name}.duration`, attributes);
  };
  for (const mode of Object.keys(modes))
    for (const status of Object.keys(statuses)) addDuration("kello.rpc.procedure", { mode, status });
  for (const status of Object.keys(statuses)) {
    addDuration("kello.revision.read", { status });
    addDuration("kello.database.acquire", { status });
  }
  for (const kind of Object.keys(retryKinds)) addCounter("kello.transaction.retry.count", { kind });
  for (const recovered of ["false", "true"]) {
    addCounter("kello.job.claim.count", { recovered });
    addHistogram("kello.job.claim.age", { recovered });
    addHistogram("kello.job.claim.due_lag", { recovered });
  }
  addCounter("kello.job.lease.reaped.count", {});
  for (const reason of Object.keys(lostReasons)) addCounter("kello.job.lease.lost.count", { reason });
  for (const stage of Object.keys(stages))
    for (const status of Object.keys(acknowledgementStatuses)) {
      addCounter("kello.deployment.acknowledgement.count", { stage, status });
    }
  for (const reason of Object.keys(lossReasons)) addCounter("kello.diagnostics.loss.count", { reason });
  if (series.size > 128) throw new Error("DIAGNOSTICS_METRIC_SERIES_LIMIT");

  // Lookups can only select pre-enumerated tuples; event labels never create a metric.
  const update = (name: string, attributes: Attributes, value: number): Update | undefined => {
    const tuple = series.get(seriesKey(name, attributes));
    return tuple ? { series: tuple, value } : undefined;
  };
  const admit = (updates: readonly (Update | undefined)[]): boolean => {
    for (const item of updates) {
      if (!item || !Number.isFinite(item.value) || item.value < 0) return false;
      if (item.series.type === "counter" && !Number.isSafeInteger(item.value)) return false;
    }
    // Check every accumulator before changing any instrument in this observation.
    for (const item of updates) {
      if (!item) return false;
      if (item.series.type === "counter") {
        if (!Number.isSafeInteger(item.series.metric.valueUnsafe(context).count + item.value)) return false;
        continue;
      }
      const histogram = item.series.metric.valueUnsafe(context);
      if (!Number.isSafeInteger(histogram.count + 1) || !Number.isFinite(histogram.sum + item.value)) return false;
      // Effect stores individual buckets in Uint32Array; prevent the target bucket wrapping.
      let previous = 0;
      for (const [boundary, cumulative] of histogram.buckets) {
        if (item.value <= boundary) {
          if (cumulative - previous >= 0xffff_ffff) return false;
          break;
        }
        previous = cumulative;
      }
    }
    for (const item of updates) if (item) item.series.metric.updateUnsafe(item.value, context);
    return true;
  };
  const duration = (name: string, attributes: Attributes, value: number) =>
    admit([update(`${name}.count`, attributes, 1), update(`${name}.duration`, attributes, value)]);
  return {
    observe(event: Event): boolean {
      switch (event.type) {
        case "rpc.procedure":
          return duration("kello.rpc.procedure", { mode: event.mode, status: event.status }, event.durationMs);
        case "revision.read":
          return duration("kello.revision.read", { status: event.status }, event.durationMs);
        case "database.acquire":
          return duration("kello.database.acquire", { status: event.status }, event.durationMs);
        case "transaction.retry":
          return admit([update("kello.transaction.retry.count", { kind: event.kind }, 1)]);
        case "job.claim": {
          if (event.recovered !== true && event.recovered !== false) return false;
          const attributes = { recovered: String(event.recovered) };
          return admit([
            update("kello.job.claim.count", attributes, 1),
            update("kello.job.claim.age", attributes, event.ageMs),
            update("kello.job.claim.due_lag", attributes, event.dueLagMs),
          ]);
        }
        case "job.lease.reaped":
          return admit([update("kello.job.lease.reaped.count", {}, event.count)]);
        case "job.lease.lost":
          return admit([update("kello.job.lease.lost.count", { reason: event.reason }, 1)]);
        case "release.acknowledgement":
          return admit([
            update("kello.deployment.acknowledgement.count", { stage: event.stage, status: event.status }, 1),
          ]);
        case "realtime.listener":
        case "realtime.coordinator":
          return true;
        default:
          event satisfies never;
          return false;
      }
    },
    loss(reason: LossReason, count: number): boolean {
      return admit([update("kello.diagnostics.loss.count", { reason }, count)]);
    },
    snapshot(): MetricsData {
      const timeUnixNano = nanoseconds();
      const metrics: MetricData[] = [];
      for (const metric of Metric.snapshotUnsafe(context)) {
        const attributes = Object.entries(metric.attributes ?? {}).map(([key, value]) => ({
          key,
          value: { stringValue: String(value) },
        }));
        const timestamp = { startTimeUnixNano, timeUnixNano, attributes };
        let instrument = metrics.find(({ name }) => name === metric.id);
        if (metric.type === "Counter") {
          if (!isNumber(metric.state.count)) throw new Error("DIAGNOSTICS_METRIC_UNSUPPORTED");
          if (!instrument) {
            instrument = {
              name: metric.id,
              unit: metric.id === "kello.job.lease.reaped.count" ? "{job}" : "{event}",
              sum: {
                aggregationTemporality: 2,
                isMonotonic: true,
                dataPoints: [],
              },
            };
            metrics.push(instrument);
          }
          instrument.sum!.dataPoints.push({ ...timestamp, asDouble: metric.state.count });
        } else if (metric.type === "Histogram") {
          if (!instrument) {
            instrument = { name: metric.id, unit: "ms", histogram: { aggregationTemporality: 2, dataPoints: [] } };
            metrics.push(instrument);
          }
          let previous = 0;
          const bucketCounts = metric.state.buckets.map(([, cumulative]) => {
            const count = cumulative - previous;
            previous = cumulative;
            return count;
          });
          instrument.histogram!.dataPoints.push({
            ...timestamp,
            count: metric.state.count,
            sum: metric.state.sum,
            explicitBounds: metric.state.buckets.slice(0, -1).map(([boundary]) => boundary),
            bucketCounts,
          });
        } else {
          throw new Error("DIAGNOSTICS_METRIC_UNSUPPORTED");
        }
      }
      return {
        resourceMetrics: [
          {
            resource: {
              droppedAttributesCount: 0,
              attributes: [
                { key: "service.name", value: { stringValue: "kello-dev" } },
                { key: "service.version", value: { stringValue: packageJson.version } },
                { key: "deployment.environment.name", value: { stringValue: "development" } },
                { key: "service.instance.id", value: { stringValue: instanceId } },
              ],
            },
            scopeMetrics: [{ scope: { name: "kello.diagnostics" }, metrics }],
          },
        ],
      };
    },
  };
}
