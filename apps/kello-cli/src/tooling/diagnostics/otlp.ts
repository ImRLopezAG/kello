import { Effect, Schema } from "effect";
import type { MetricsData } from "effect/observability/OtlpMetrics";
import { OtlpSerialization, layerJson } from "effect/observability/OtlpSerialization";
import { validateOtlpConfig } from "./config";

export type OtlpFailureCode = "timeout" | "rejected" | "partial" | "oversized" | "network";

export async function serializeMetrics(data: MetricsData): Promise<Uint8Array> {
  const body = await Effect.runPromise(
    Effect.gen(function* () {
      const serialization = yield* OtlpSerialization;
      return serialization.metrics(data);
    }).pipe(Effect.provide(layerJson)),
  );
  if (body._tag !== "Uint8Array") throw new Error("TELEMETRY_REJECTED");
  if (body.body.byteLength > 128 * 1024) throw new Error("TELEMETRY_OVERSIZED");
  return body.body;
}

const isResponse = Schema.is(
  Schema.Struct({
    partialSuccess: Schema.optionalKey(
      Schema.Struct({
        rejectedDataPoints: Schema.optionalKey(Schema.Union([Schema.Number, Schema.String])),
        errorMessage: Schema.optionalKey(Schema.String),
      }),
    ),
  }),
);
const isString = Schema.is(Schema.String);

function responseFailure(text: string): OtlpFailureCode | undefined {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return "rejected";
  }
  if (!isResponse(data)) return "rejected";
  if (Object.keys(data).some((key) => key !== "partialSuccess")) return "rejected";
  const partial = data.partialSuccess;
  if (!partial) return;
  if (Object.keys(partial).some((key) => key !== "rejectedDataPoints" && key !== "errorMessage")) return "rejected";
  const rejected = partial.rejectedDataPoints;
  if (rejected !== undefined) {
    if (isString(rejected)) {
      if (!/^\d+$/.test(rejected) || BigInt(rejected) > 9223372036854775807n) return "rejected";
      if (BigInt(rejected) > 0n) return "partial";
    } else {
      if (!Number.isSafeInteger(rejected) || rejected < 0) return "rejected";
      if (rejected > 0) return "partial";
    }
  }
  if (partial.errorMessage) return "partial";
}

export function createOtlpExporter(options: {
  endpoint: string;
  bearerToken?: string;
  snapshot: () => MetricsData;
  onFailure: (code: OtlpFailureCode) => void;
}) {
  const { endpoint, headers } = validateOtlpConfig(options);

  const { snapshot, onFailure } = options;
  let stopped = false;
  let stopping: Promise<void> | undefined;
  let flight: Promise<void> | undefined;
  let active: AbortController | undefined;
  let stopDeadline = Infinity;

  function failure(code: OtlpFailureCode) {
    try {
      onFailure(code);
    } catch {
      /* Diagnostics cannot fail the application. */
    }
  }

  async function send(): Promise<void> {
    const controller = new AbortController();
    active = controller;
    const requestDeadline = Math.min(performance.now() + 1000, stopDeadline);
    const timeout = setTimeout(() => controller.abort(), Math.max(0, requestDeadline - performance.now()));
    let reader: Pick<ReadableStreamDefaultReader<Uint8Array>, "read" | "cancel" | "releaseLock"> | undefined;
    try {
      const bytes = await serializeMetrics(snapshot());
      if (controller.signal.aborted || performance.now() >= Math.min(requestDeadline, stopDeadline)) {
        controller.abort();
        failure("timeout");
        return;
      }
      const response = await fetch(endpoint, {
        method: "POST",
        headers,
        body: Uint8Array.from(bytes).buffer,
        redirect: "manual",
        signal: controller.signal,
      });
      if (!response.ok) {
        controller.abort();
        failure("rejected");
        return;
      }
      reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      if (reader) {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          length += chunk.value.byteLength;
          if (length > 16 * 1024) {
            controller.abort();
            failure("oversized");
            return;
          }
          chunks.push(chunk.value);
        }
      }
      if (controller.signal.aborted || performance.now() >= Math.min(requestDeadline, stopDeadline)) {
        controller.abort();
        failure("timeout");
        return;
      }
      const responseBytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        responseBytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(responseBytes);
      } catch {
        failure("rejected");
        return;
      }
      const code = responseFailure(text);
      if (code) failure(code);
    } catch (error) {
      failure(
        controller.signal.aborted
          ? "timeout"
          : error instanceof Error && error.message === "TELEMETRY_OVERSIZED"
            ? "oversized"
            : "network",
      );
    } finally {
      clearTimeout(timeout);
      if (reader) {
        try {
          await reader.cancel();
        } catch {
          /* Cancellation may already have aborted the stream. */
        }
        reader.releaseLock();
      }
      if (active === controller) active = undefined;
    }
  }

  function startFlight(): Promise<void> {
    // Defer snapshot until flight is installed, including reentrant callbacks.
    const request = Promise.resolve().then(send);
    flight = request.finally(() => {
      flight = undefined;
    });
    return flight;
  }

  function flush(): Promise<void> {
    if (flight) return flight;
    if (stopped) return Promise.resolve();
    return startFlight();
  }

  const interval = setInterval(() => {
    if (!stopped && !flight) void flush();
  }, 10_000);

  function stop(deadline = performance.now() + 2000): Promise<void> {
    if (stopping) return stopping;
    stopped = true;
    clearInterval(interval);
    stopDeadline = deadline;
    // Install the coalesced promise before cancellation can invoke callbacks.
    stopping = Promise.resolve().then(async () => {
      let expired = performance.now() >= deadline;
      const expire = () => {
        expired = true;
        active?.abort();
      };
      const timeout = setTimeout(expire, Math.max(0, deadline - performance.now()));
      try {
        if (expired) expire();
        if (flight) await flight;
        if (!expired && performance.now() < deadline) await startFlight();
      } finally {
        clearTimeout(timeout);
      }
    });
    return stopping;
  }

  return { flush, stop };
}
