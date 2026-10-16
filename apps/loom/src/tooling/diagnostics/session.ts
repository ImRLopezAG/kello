import { channel, type ChannelListener } from "node:diagnostics_channel";
import { Predicate } from "effect";
import { createOutput, Ring } from "./output";
import { projectDeploymentMetric, projectRuntimeMetric } from "./project";
import type { DiagnosticsOptions, DiagnosticsRecord, DiagnosticsSession } from "./types";

const guard = Symbol.for("kello.diagnostics.session.v1");
const increment = (value: number, count = 1): number => value + Math.min(count, Number.MAX_SAFE_INTEGER - value);

export async function startDiagnostics(options: DiagnosticsOptions): Promise<DiagnosticsSession> {
  if (Object.getOwnPropertyDescriptor(globalThis, guard)?.value !== undefined)
    throw new Error("DIAGNOSTICS_ALREADY_ACTIVE");
  const token = {};
  Object.defineProperty(globalThis, guard, { value: token, configurable: true });
  function release() {
    if (Object.getOwnPropertyDescriptor(globalThis, guard)?.value === token) Reflect.deleteProperty(globalThis, guard);
  }
  const runtime = channel("kello.runtime.metric");
  const deployment = channel("kello.deployment.metric");
  const ingress = new Ring<DiagnosticsRecord>(1024);
  let state: "starting" | "running" | "stopping" | "stopped" = "starting";
  let accepted = 0;
  let invalid = 0;
  let ingressDrops = 0;
  let outputDrops = 0;
  let outputFailures = 0;
  let exportFailures = 0;
  let sequence = 0;
  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  let lossTimer: ReturnType<typeof setInterval> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let stopping: Promise<void> | undefined;
  let finishStop: (() => void) | undefined;
  let output: ReturnType<typeof createOutput> | undefined;
  let metrics: ReturnType<typeof import("./metrics").createDiagnosticsMetrics> | undefined;
  let exporter: ReturnType<typeof import("./otlp").createOtlpExporter> | undefined;
  let stopDeadline = 0;
  let exportingFinal = false;
  const reportedLoss = { invalid: 0, ingress_queue: 0, output_queue: 0, output: 0, export: 0 };
  function flushLoss() {
    if (!metrics) return;
    const current = {
      invalid,
      ingress_queue: ingressDrops,
      output_queue: outputDrops,
      output: outputFailures,
      export: exportFailures,
    };
    for (const reason of ["invalid", "ingress_queue", "output_queue", "output", "export"] as const) {
      const delta = current[reason] - reportedLoss[reason];
      if (delta && metrics.loss(reason, delta)) reportedLoss[reason] = current[reason];
    }
  }
  const snapshot = () => ({
    accepted,
    invalid,
    dropped: increment(ingressDrops, outputDrops),
    outputFailures,
    exportFailures,
  });
  function finish() {
    state = "stopped";
    if (drainTimer !== undefined) {
      clearTimeout(drainTimer);
      drainTimer = undefined;
    }
    if (deadline !== undefined) {
      clearTimeout(deadline);
      deadline = undefined;
    }
    ingressDrops = increment(ingressDrops, ingress.clear());
    release();
    finishStop?.();
    finishStop = undefined;
  }
  function scheduleDrain() {
    if (drainTimer === undefined) drainTimer = setTimeout(drain, 0);
  }
  function finishExport() {
    if (exportingFinal) return;
    exportingFinal = true;
    if (exporter) void exporter.stop(stopDeadline).then(finish);
    else finish();
  }
  function drain() {
    drainTimer = undefined;
    for (let count = 0; count < 64; count++) {
      const record = ingress.pop();
      if (!record) break;
      if (record.source !== "diagnostics" && metrics && !metrics.observe(record.event))
        ingressDrops = increment(ingressDrops);
      if (state === "running") output?.enqueue(record);
    }
    flushLoss();
    if (ingress.size) scheduleDrain();
    else if (state === "stopping") finishExport();
  }
  function observe(
    record:
      | Pick<Extract<DiagnosticsRecord, { source: "runtime" }>, "source" | "event">
      | Pick<Extract<DiagnosticsRecord, { source: "deployment" }>, "source" | "event">,
  ) {
    if (ingress.size === 1024 || sequence === Number.MAX_SAFE_INTEGER || accepted === Number.MAX_SAFE_INTEGER) {
      ingressDrops = increment(ingressDrops);
      return;
    }
    const fresh = {
      schemaVersion: 1 as const,
      scope: "local-process" as const,
      sequence: ++sequence,
      timestamp: new Date().toISOString(),
      ...record,
    };
    ingress.push(fresh);
    accepted = increment(accepted);
    scheduleDrain();
  }
  // SAFETY: channel inputs are untrusted; only the U1 descriptor projectors inspect them.
  const onRuntime: ChannelListener = (input) => {
    if (state !== "running") return;
    const event = projectRuntimeMetric(input);
    if (state !== "running") return;
    if (event) observe({ source: "runtime", event });
    else invalid = increment(invalid);
  };
  // SAFETY: channel inputs are untrusted; only the U1 descriptor projectors inspect them.
  const onDeployment: ChannelListener = (input) => {
    if (state !== "running") return;
    const event = projectDeploymentMetric(input);
    if (state !== "running") return;
    if (event) observe({ source: "deployment", event });
    else invalid = increment(invalid);
  };
  function unsubscribe() {
    runtime.unsubscribe(onRuntime);
    deployment.unsubscribe(onDeployment);
  }
  try {
    if (!options.output && !options.telemetry) throw new Error("DIAGNOSTICS_SINK_REQUIRED");
    const sink = options.output;
    if (sink) {
      // SAFETY: JavaScript callers can violate the declared writer type at this public boundary.
      if ((sink.format !== "text" && sink.format !== "jsonl") || !Predicate.isFunction(sink.write))
        throw new Error("DIAGNOSTICS_INVALID_OUTPUT");
      // Copy the writer/format so retained option mutations cannot replace the sink.
      output = createOutput(
        { format: sink.format, write: sink.write },
        (count) => {
          outputDrops = increment(outputDrops, count);
        },
        () => {
          outputFailures = increment(outputFailures);
        },
      );
    }
    if (options.telemetry) {
      const telemetry = options.telemetry;
      if (telemetry.protocol !== "otlp-http-json") throw new Error("TELEMETRY_CONFIG_INVALID");
      const [{ createDiagnosticsMetrics }, { createOtlpExporter }] = await Promise.all([
        import("./metrics"),
        import("./otlp"),
      ]);
      const privateMetrics = createDiagnosticsMetrics();
      metrics = privateMetrics;
      exporter = createOtlpExporter({
        ...telemetry,
        snapshot: () => {
          flushLoss();
          return privateMetrics.snapshot();
        },
        onFailure: () => {
          exportFailures = increment(exportFailures);
        },
      });
    }
    runtime.subscribe(onRuntime);
    deployment.subscribe(onDeployment);
    state = "running";
    let lastLoss = "";
    lossTimer = setInterval(() => {
      const stats = snapshot();
      const loss = `${stats.invalid}:${stats.dropped}:${stats.outputFailures}:${stats.exportFailures}`;
      if (
        state !== "running" ||
        loss === lastLoss ||
        !(stats.invalid || stats.dropped || stats.outputFailures || stats.exportFailures)
      )
        return;
      lastLoss = loss;
      if (ingress.size === 1024 || sequence === Number.MAX_SAFE_INTEGER) {
        ingressDrops = increment(ingressDrops);
        return;
      }
      ingress.push({
        schemaVersion: 1,
        scope: "local-process",
        sequence: ++sequence,
        timestamp: new Date().toISOString(),
        source: "diagnostics",
        event: { type: "diagnostics.loss", ...stats },
      });
      scheduleDrain();
    }, 1000);
    return {
      snapshot,
      stop() {
        if (stopping) return stopping;
        state = "stopping";
        stopDeadline = performance.now() + 2000;
        stopping = new Promise<void>((resolve) => {
          finishStop = resolve;
        });
        unsubscribe();
        if (lossTimer !== undefined) {
          clearInterval(lossTimer);
          lossTimer = undefined;
        }
        output?.stop();
        deadline = setTimeout(
          () => {
            ingressDrops = increment(ingressDrops, ingress.clear());
            // The exporter owns cancellation/cleanup at this same absolute deadline.
            // Retain session ownership until its bounded stop has settled.
            finishExport();
          },
          Math.max(0, stopDeadline - performance.now()),
        );
        if (ingress.size) {
          scheduleDrain();
        } else finishExport();
        return stopping;
      },
    };
  } catch (error) {
    unsubscribe();
    if (lossTimer !== undefined) clearInterval(lossTimer);
    output?.stop();
    if (exporter) await exporter.stop(performance.now());
    finish();
    throw error;
  }
}
