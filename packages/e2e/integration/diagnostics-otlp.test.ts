import assert from "node:assert/strict";
import { test } from "bun:test";
import { mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout } from "node:timers/promises";
import { createDiagnosticsMetrics } from "../../../apps/kello-cli/src/tooling/diagnostics/metrics";
import { createOtlpExporter, serializeMetrics } from "../../../apps/kello-cli/src/tooling/diagnostics/otlp";

import { RPCLink } from "@orpc/client/fetch";
import { createProjectProcedures } from "../../../apps/kello/src/core/server/rpc/procedure";
import { defineSchema } from "../../../apps/kello/src/core/schema/define-schema";
import { createRpcHttpApp } from "../../../apps/kello/src/core/adapters/neon/rpc-http";
import { startDiagnostics } from "../../../apps/kello-cli/src/tooling/diagnostics/session";
import { Schema } from "effect";
import type { MetricsData } from "effect/observability/OtlpMetrics";
import packageJson from "../../../apps/kello/package.json" with { type: "json" };

const collectorImage =
  "otel/opentelemetry-collector@sha256:0beba82d63792511591522a8d582904b9a8ae81710357bfcab731607b8b0ffe2";

function docker(args: string[], structured: true): Promise<{ stdout: string; stderr: string }>;
function docker(args: string[]): Promise<string>;
async function docker(args: string[], structured = false) {
  const commandMs = 2000;
  const graceMs = 250;
  const reapMs = 750;
  const maxStreamBytes = 8 * 1024 * 1024;
  const child = Bun.spawn(["docker", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  // Exactly one exit promise; every wait, including escalation, observes this waiter.
  let reaped = false;
  const exited = child.exited.then((code) => {
    reaped = true;
    return code;
  });
  const readers = [child.stdout.getReader(), child.stderr.getReader()];
  let cancelled = false;
  const read = async (reader: ReadableStreamDefaultReader<Uint8Array>) => {
    const decoder = new TextDecoder();
    let text = "";
    let bytes = 0;
    while (!cancelled) {
      const chunk = await reader.read();
      if (chunk.done) return text + decoder.decode();
      bytes += chunk.value.byteLength;
      assert.ok(bytes <= maxStreamBytes, "Docker output exceeds bounded stream capacity");
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text;
  };
  const within = async <T>(pending: Promise<T>, ms: number): Promise<T> => {
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
    try {
      return await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          timer = globalThis.setTimeout(() => reject(new Error("Docker command deadline")), ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const cleanup: unknown[] = [];
  try {
    const [stdout, stderr, code] = await within(Promise.all([read(readers[0]!), read(readers[1]!), exited]), commandMs);
    assert.equal(code, 0, `Disposable collector command failed: ${stderr}`);
    return structured ? { stdout, stderr } : stdout + stderr;
  } catch (primary) {
    if (!reaped) {
      try {
        child.kill("SIGTERM");
      } catch (error) {
        cleanup.push(error);
      }
      try {
        await within(exited, graceMs);
      } catch {
        /* Escalate only the exact child handle. */
      }
      if (!reaped) {
        try {
          child.kill("SIGKILL");
        } catch (error) {
          cleanup.push(error);
        }
        try {
          await within(exited, reapMs);
        } catch (error) {
          cleanup.push(error);
        }
      }
    }
    if (!reaped) cleanup.push(new Error("Docker CLI exit unconfirmed; container outcome unknown"));
    throw Object.assign(
      new AggregateError([primary, ...cleanup], "Docker command failed; primary first, cleanup follows"),
      { reaped },
    );
  } finally {
    cancelled = true;
    // Cancellation itself can hang; do not add an unbounded await after the command deadline.
    for (const reader of readers) void reader.cancel().catch(() => {});
  }
}

type CollectorOwner = {
  name: string;
  token: string;
  receipt: string;
  attempted: boolean;
  cliUnreaped: boolean;
  id?: string;
};

async function persistCollectorOwner(owner: CollectorOwner) {
  // Complete a private sibling before replacing the last valid process-visible record.
  const pending = `${owner.receipt}.next`;
  await writeFile(pending, JSON.stringify(owner) + "\n", { mode: 0o600 });
  await rename(pending, owner.receipt);
}

async function authenticateCollector(owner: CollectorOwner) {
  assert.ok(!owner.cliUnreaped, "Unreaped create CLI: container outcome unknown; refuse deletion");
  const records: unknown = JSON.parse((await docker(["container", "inspect", owner.name], true)).stdout);
  assert.ok(Array.isArray(records) && records.length === 1, "Exact collector lookup required");
  const record = records[0];
  assert.equal(record.Name, `/${owner.name}`, "Exact collector name required");
  assert.equal(
    record.Config?.Labels?.["dev.kello.collector-owner"],
    owner.token,
    "Exact collector owner token required",
  );
  assert.match(record.Id, /^[0-9a-f]{64}$/, "Full collector ID required");
  if (owner.id !== undefined) assert.equal(record.Id, owner.id, "Collector ID changed; refuse deletion");
  owner.id = record.Id;
  await persistCollectorOwner(owner);
  // SAFETY: assert.match above rejects non-string IDs and requires the full 64-hex container identity.
  return record.Id as string;
}

async function cleanupCollector(owner: CollectorOwner) {
  if (!owner.attempted) return;
  const id = await authenticateCollector(owner);
  await docker(["rm", "--force", id]);
}

async function finishCollector(
  primary: unknown[],
  stop: () => Promise<void>,
  owner: CollectorOwner,
  removeRoot: () => Promise<void>,
) {
  const cleanup: unknown[] = [];
  try {
    await stop();
  } catch (error) {
    cleanup.push(error);
  }
  let collectorReleased = false;
  try {
    await cleanupCollector(owner);
    collectorReleased = true;
  } catch (error) {
    cleanup.push(error);
  }
  // Retain exact intent/config/ID on uncertain container cleanup for independent reconciliation.
  if (collectorReleased) {
    try {
      await removeRoot();
    } catch (error) {
      cleanup.push(error);
    }
  }
  if (cleanup.length)
    throw new AggregateError(
      [...primary, ...cleanup],
      `Collector fixture failure; primary first, cleanup follows; receipt ${owner.receipt}`,
    );
  if (primary.length) throw primary[0];
}

async function until(description: string, check: () => Promise<boolean>) {
  const deadline = performance.now() + 10000;
  while (!(await check())) {
    assert.ok(performance.now() < deadline, `Timed out waiting for ${description}`);
    await setTimeout(25);
  }
}

// v0.156.0 debugexporter emits one marshaled resource batch per logger message.
// JSON log framing keeps a partial Docker log read from looking like a completed export.
// Source: exporter/debugexporter/{exporter.go,internal/otlptext/databuffer.go}.
function collectorMessages(logs: string): string[] {
  return logs
    .split("\n")
    .slice(0, -1)
    .map((line) => {
      const record: unknown = JSON.parse(line);
      assert.ok(Schema.is(Schema.Struct({ msg: Schema.String }))(record), "Collector JSON log message");
      return record.msg;
    });
}

const histogramBounds = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 5000, 30000, 60000];
type DecodedSeries = {
  key: string;
  type: string;
  unit: string;
  temporality: string;
  monotonic: string | undefined;
  start: string;
  timestamp: string;
  value: number | undefined;
  count: number | undefined;
  sum: number | undefined;
  bounds: number[];
  buckets: number[];
};
const tupleKey = (name: string, attributes: Record<string, string>) =>
  `${name}|${Object.entries(attributes)
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join(",")}`;

function collectorResource(message: string) {
  const resource = message.split(/^ScopeMetrics #/m)[0]!;
  const attributes = [...resource.matchAll(/^     -> ([^:]+): Str\(([^)]*)\)$/gm)].map(
    (match) => [match[1]!, match[2]!] as const,
  );
  assert.equal((resource.match(/^     -> /gm) ?? []).length, attributes.length, "Only string resource attributes");
  assert.equal(new Set(attributes.map(([key]) => key)).size, attributes.length, "Unique resource keys");
  return Object.fromEntries(attributes);
}

function decodeCollectorExport(message: string): DecodedSeries[] {
  assert.equal((message.match(/^ResourceMetrics #/gm) ?? []).length, 1);
  assert.equal((message.match(/^ScopeMetrics #/gm) ?? []).length, 1);
  assert.match(message, /^InstrumentationScope kello\.diagnostics /m);
  const field = (text: string, name: string): string => {
    const values = [...text.matchAll(new RegExp(`^(?:     -> )?${name}: (.+)$`, "gm"))];
    assert.equal(values.length, 1, `Exactly one ${name}`);
    return values[0]![1]!;
  };
  const indexed = (text: string, expression: RegExp): number[] =>
    [...text.matchAll(expression)].map((match, index) => {
      assert.equal(Number(match[1]), index, "Contiguous histogram indexes");
      return Number(match[2]);
    });
  return message
    .split(/^Metric #\d+\n/m)
    .slice(1)
    .flatMap((metric) => {
      const name = field(metric, "Name");
      const type = field(metric, "DataType");
      assert.ok(type === "Sum" || type === "Histogram", type);
      const unit = field(metric, "Unit");
      const temporality = field(metric, "AggregationTemporality");
      const monotonic = type === "Sum" ? field(metric, "IsMonotonic") : undefined;
      const points = metric.split(/^(?:Number|Histogram)DataPoints #\d+\n/m).slice(1);
      assert.ok(points.length > 0, name);
      return points.map((point) => {
        const attributes: Record<string, string> = {};
        for (const match of point.matchAll(/^     -> ([^:]+): Str\(([^)]*)\)$/gm)) {
          assert.ok(!(match[1]! in attributes), "Unique attribute keys");
          attributes[match[1]!] = match[2]!;
        }
        assert.equal(
          (point.match(/^     -> /gm) ?? []).length,
          Object.keys(attributes).length,
          "Only string tuple attributes",
        );
        return {
          key: tupleKey(name, attributes),
          type,
          unit,
          temporality,
          monotonic,
          start: field(point, "StartTimestamp"),
          timestamp: field(point, "Timestamp"),
          value: type === "Sum" ? Number(field(point, "Value")) : undefined,
          count: type === "Histogram" ? Number(field(point, "Count")) : undefined,
          sum: type === "Histogram" ? Number(field(point, "Sum")) : undefined,
          bounds: indexed(point, /^ExplicitBounds #(\d+): (.+)$/gm),
          buckets: indexed(point, /^Buckets #(\d+), Count: (\d+)$/gm),
        };
      });
    });
}

// Independent plan U5 mapping and fixture arithmetic; never derived from snapshot().
function expectedBaseline(): Omit<DecodedSeries, "start" | "timestamp">[] {
  const expected: Omit<DecodedSeries, "start" | "timestamp">[] = [];
  const counter = (name: string, attributes: Record<string, string>, value = 1, unit = "{event}") => {
    expected.push({
      key: tupleKey(name, attributes),
      type: "Sum",
      unit,
      temporality: "Cumulative",
      monotonic: "true",
      value,
      count: undefined,
      sum: undefined,
      bounds: [],
      buckets: [],
    });
  };
  const histogram = (
    name: string,
    attributes: Record<string, string>,
    count: number,
    sum: number,
    buckets: number[],
  ) => {
    expected.push({
      key: tupleKey(name, attributes),
      type: "Histogram",
      unit: "ms",
      temporality: "Cumulative",
      monotonic: undefined,
      value: undefined,
      count,
      sum,
      bounds: histogramBounds,
      buckets,
    });
  };
  const duration = (name: string, attributes: Record<string, string>, bucket: number, sum: number) => {
    counter(`${name}.count`, attributes);
    histogram(
      `${name}.duration`,
      attributes,
      1,
      sum,
      Array.from({ length: 13 }, (_, index) => Number(index === bucket)),
    );
  };
  for (const mode of ["finite", "live", "mutation"])
    for (const status of ["success", "error"]) {
      if (mode === "finite" && status === "success") {
        counter("kello.rpc.procedure.count", { mode, status }, 5);
        histogram(
          "kello.rpc.procedure.duration",
          { mode, status },
          5,
          70016.5,
          [1, 1, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
        );
      } else duration("kello.rpc.procedure", { mode, status }, 2, 7);
    }
  for (const status of ["success", "error"]) {
    duration("kello.database.acquire", { status }, 3, 13);
  }
  for (const kind of ["query", "mutation"]) counter("kello.transaction.retry.count", { kind });
  for (const recovered of ["false", "true"]) {
    counter("kello.job.claim.count", { recovered });
    histogram("kello.job.claim.age", { recovered }, 1, 17, [0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    histogram("kello.job.claim.due_lag", { recovered }, 1, 19, [0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  }
  counter("kello.job.lease.reaped.count", {}, 23, "{job}");
  for (const reason of ["deadline", "ownership", "activation", "queue"])
    counter("kello.job.lease.lost.count", { reason });
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
  ])
    for (const status of ["recorded", "replayed", "write-error"])
      counter("kello.deployment.acknowledgement.count", { stage, status });
  for (const reason of ["invalid", "ingress_queue", "output_queue", "output", "export"])
    counter("kello.diagnostics.loss.count", { reason }, 29);
  return expected.sort((a, b) => a.key.localeCompare(b.key));
}

// Source-format characterization only: this is not a captured collector receipt.
test("collector debug parser characterizes complete JSON framing and associated points", () => {
  const message = `ResourceMetrics #0
Resource SchemaURL:
Resource attributes:
     -> service.name: Str(kello-dev)
     -> service.version: Str(0.0.0)
     -> deployment.environment.name: Str(development)
     -> service.instance.id: Str(fixture-instance)
ScopeMetrics #0
ScopeMetrics SchemaURL:
InstrumentationScope kello.diagnostics ${" "}
Metric #0
Descriptor:
     -> Name: kello.transaction.retry.count
     -> Unit: {event}
     -> DataType: Sum
     -> IsMonotonic: true
     -> AggregationTemporality: Cumulative
NumberDataPoints #0
Data point attributes:
     -> kind: Str(query)
StartTimestamp: 2026-10-07 12:00:00 +0000 UTC
Timestamp: 2026-10-07 12:00:01 +0000 UTC
Value: 1.000000
Metric #1
Descriptor:
     -> Name: kello.job.claim.age
     -> Unit: ms
     -> DataType: Histogram
     -> AggregationTemporality: Cumulative
HistogramDataPoints #0
Data point attributes:
     -> recovered: Str(true)
StartTimestamp: 2026-10-07 12:00:00 +0000 UTC
Timestamp: 2026-10-07 12:00:01 +0000 UTC
Count: 1
Sum: 17.000000
ExplicitBounds #0: 1.000000
ExplicitBounds #1: 5.000000
ExplicitBounds #2: 10.000000
ExplicitBounds #3: 25.000000
ExplicitBounds #4: 50.000000
ExplicitBounds #5: 100.000000
ExplicitBounds #6: 250.000000
ExplicitBounds #7: 500.000000
ExplicitBounds #8: 1000.000000
ExplicitBounds #9: 5000.000000
ExplicitBounds #10: 30000.000000
ExplicitBounds #11: 60000.000000
Buckets #0, Count: 0
Buckets #1, Count: 0
Buckets #2, Count: 0
Buckets #3, Count: 1
Buckets #4, Count: 0
Buckets #5, Count: 0
Buckets #6, Count: 0
Buckets #7, Count: 0
Buckets #8, Count: 0
Buckets #9, Count: 0
Buckets #10, Count: 0
Buckets #11, Count: 0
Buckets #12, Count: 0
`;
  const first = JSON.stringify({ msg: message.replace("Value: 1.000000", "Value: 0.000000") });
  const latest = JSON.stringify({ msg: message });
  assert.deepEqual(collectorMessages(`${first}\n${latest.slice(0, -2)}`), [
    message.replace("Value: 1.000000", "Value: 0.000000"),
  ]);
  const exports = collectorMessages(`${first}\n${latest}\n`);
  assert.equal(exports.length, 2);
  assert.deepEqual(collectorResource(exports[1]!), {
    "service.name": "kello-dev",
    "service.version": "0.0.0",
    "deployment.environment.name": "development",
    "service.instance.id": "fixture-instance",
  });
  assert.throws(
    () => collectorResource(message.replace("Str(kello-dev)", "Int(3)")),
    /Only string resource attributes/,
  );
  const points = decodeCollectorExport(exports[1]!);
  assert.equal(points[0]!.key, "kello.transaction.retry.count|kind=query");
  assert.equal(points[0]!.value, 1);
  assert.equal(decodeCollectorExport(exports[0]!)[0]!.value, 0);
  assert.equal(points[1]!.key, "kello.job.claim.age|recovered=true");
  assert.equal(points[1]!.count, 1);
  assert.equal(points[1]!.sum, 17);
  assert.deepEqual(points[1]!.bounds, histogramBounds);
  assert.deepEqual(points[1]!.buckets, [0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.throws(
    () => decodeCollectorExport(message.replace("ExplicitBounds #5: 100.000000\n", "")),
    /Contiguous histogram indexes/,
  );
  assert.throws(
    () => decodeCollectorExport(message.replace("StartTimestamp:", "MissingStart:")),
    /Exactly one StartTimestamp/,
  );
  const expected = expectedBaseline();
  assert.equal(expected.length, 64);
  assert.equal(expected.filter((point) => point.type === "Sum").length, 52);
  assert.equal(expected.filter((point) => point.type === "Histogram").length, 12);
  assert.equal(new Set(expected.map((point) => point.key)).size, 64);
});

// This acceptance owns a unique disposable collector; unavailable Docker is a failure, never a skip.
test("pinned collector decodes private cumulative RPC metrics and histogram buckets", async () => {
  const root = await mkdtemp(join(tmpdir(), "kello-001-otlp-"));
  const token = crypto.randomUUID();
  const name = `kello-001-otlp-${token}`;
  const owner: CollectorOwner = {
    name,
    token,
    receipt: join(root, "owner.json"),
    attempted: false,
    cliUnreaped: false,
  };
  const primary: unknown[] = [];
  let exporter: Awaited<ReturnType<typeof createOtlpExporter>> | undefined;
  try {
    const config = join(root, "collector.yaml");
    await writeFile(
      config,
      `receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318
exporters:
  debug:
    verbosity: detailed
service:
  telemetry:
    logs:
      encoding: json
  pipelines:
    metrics:
      receivers: [otlp]
      exporters: [debug]
`,
    );
    owner.attempted = true;
    await writeFile(owner.receipt, JSON.stringify(owner) + "\n", { mode: 0o600 });
    const response = await docker(
      [
        "run",
        "--pull=never",
        "--detach",
        "--label",
        `dev.kello.collector-owner=${token}`,
        "--cidfile",
        join(root, "container.cid"),
        "--name",
        name,
        "--publish",
        "127.0.0.1::4318",
        "--volume",
        `${config}:/etc/otelcol/config.yaml:ro`,
        collectorImage,
        "--config=/etc/otelcol/config.yaml",
      ],
      true,
    );
    assert.match(response.stdout.trim(), /^[0-9a-f]{64}$/, "Full created collector ID required");
    owner.id = response.stdout.trim();
    await persistCollectorOwner(owner);
    await authenticateCollector(owner);
    assert.match(await docker(["exec", owner.id!, "/otelcol", "--version"]), /otelcol version 0\.156\.0/);
    const port = (await docker(["port", owner.id!, "4318/tcp"])).trim();
    assert.match(port, /^127\.0\.0\.1:\d+$/);
    await until("collector receiver", async () => (await docker(["logs", owner.id!])).includes("Everything is ready"));

    const metrics = createDiagnosticsMetrics();
    for (const durationMs of [0.5, 7, 70000])
      assert.equal(metrics.observe({ type: "rpc.procedure", mode: "finite", status: "success", durationMs }), true);
    const first = metrics.snapshot();
    const resource = first.resourceMetrics[0]!;
    assert.deepEqual(resource.resource.attributes.map(({ key }) => key).sort(), [
      "deployment.environment.name",
      "service.instance.id",
      "service.name",
      "service.version",
    ]);
    const instance = resource.resource.attributes.find((attribute) => attribute.key === "service.instance.id")!.value
      .stringValue!;
    assert.match(instance, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const expectedResource = {
      "deployment.environment.name": "development",
      "service.instance.id": instance,
      "service.name": "kello-dev",
      "service.version": packageJson.version,
    };
    const instruments = resource.scopeMetrics.flatMap((scope) => scope.metrics);
    const counter = instruments.find((metric) => metric.name === "kello.rpc.procedure.count")!;
    const histogram = instruments.find((metric) => metric.name === "kello.rpc.procedure.duration")!;
    const point = histogram.histogram!.dataPoints.find((point) => point.count === 3)!;
    assert.ok(point);
    assert.equal(point.sum, 70007.5);
    assert.deepEqual(point.bucketCounts, [1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    assert.deepEqual(point.explicitBounds, [1, 5, 10, 25, 50, 100, 250, 500, 1000, 5000, 30000, 60000]);
    assert.equal(counter.sum!.aggregationTemporality, 2);
    assert.equal(histogram.histogram!.aggregationTemporality, 2);
    assert.match(JSON.stringify(point.startTimeUnixNano), /^"\d{19}"$/);
    assert.match(JSON.stringify(point.timeUnixNano), /^"\d{19}"$/);
    const bytes = await serializeMetrics(first);
    assert.ok(bytes.byteLength <= 128 * 1024);
    assert.deepEqual(JSON.parse(new TextDecoder().decode(bytes)), first);

    const failures: string[] = [];
    exporter = createOtlpExporter({
      endpoint: `http://${port}/v1/metrics`,
      snapshot: () => metrics.snapshot(),
      onFailure: (code) => {
        failures.push(code);
      },
    });
    await exporter.flush();
    await until("first decoded cumulative histogram", async () =>
      collectorMessages(await docker(["logs", owner.id!])).some((message) => message.includes("Sum: 70007.500000")),
    );
    assert.equal(metrics.observe({ type: "rpc.procedure", mode: "finite", status: "success", durationMs: 2 }), true);
    await exporter.flush();
    await until("second decoded cumulative histogram", async () =>
      collectorMessages(await docker(["logs", owner.id!])).some((message) => message.includes("Sum: 70009.500000")),
    );
    const logs = collectorMessages(await docker(["logs", owner.id!])).join("\n");
    assert.deepEqual(failures, []);
    assert.match(logs, /service\.name: Str\(kello-dev\)/);
    assert.match(logs, /deployment\.environment\.name: Str\(development\)/);
    assert.match(logs, /Name: kello\.rpc\.procedure\.count/);
    assert.match(logs, /AggregationTemporality: Cumulative/);
    assert.match(logs, /Value: 3(?:\.0+)?\n/);
    assert.match(logs, /Value: 4(?:\.0+)?\n/);
    assert.match(logs, /Count: 3\nSum: 70007\.500000/);
    assert.match(logs, /Count: 4\nSum: 70009\.500000/);
    assert.match(logs, /Buckets #12, Count: 1/);
    const starts = [...logs.matchAll(/^StartTimestamp: (.+)$/gm)].map((match) => match[1]);
    assert.ok(starts.length >= 4);
    assert.equal(new Set(starts).size, 1, "Cumulative exports retain one session start timestamp");

    // The same real collector must decode every baseline tuple, not only the RPC spike.
    for (const mode of ["finite", "live", "mutation"] as const)
      for (const status of ["success", "error"] as const)
        assert.equal(metrics.observe({ type: "rpc.procedure", mode, status, durationMs: 7 }), true);
    for (const status of ["success", "error"] as const) {
      assert.equal(
        metrics.observe({ type: "database.acquire", status, durationMs: 13, total: 99, idle: 98, waiting: 97 }),
        true,
      );
    }
    for (const kind of ["query", "mutation"] as const)
      assert.equal(metrics.observe({ type: "transaction.retry", kind, attempt: 99 }), true);
    for (const recovered of [false, true])
      assert.equal(metrics.observe({ type: "job.claim", recovered, ageMs: 17, dueLagMs: 19, attempt: 99 }), true);
    assert.equal(metrics.observe({ type: "job.lease.reaped", count: 23 }), true);
    for (const reason of ["deadline", "ownership", "activation", "queue"] as const)
      assert.equal(metrics.observe({ type: "job.lease.lost", reason }), true);
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
    ] as const)
      for (const status of ["recorded", "replayed", "write-error"] as const)
        assert.equal(metrics.observe({ type: "release.acknowledgement", stage, status }), true);
    for (const reason of ["invalid", "ingress_queue", "output_queue", "output", "export"] as const)
      assert.equal(metrics.loss(reason, 29), true);
    const full = metrics.snapshot().resourceMetrics[0]!.scopeMetrics[0]!.metrics;
    assert.equal(
      full.reduce((count, metric) => count + (metric.sum?.dataPoints.length ?? 0), 0),
      52,
    );
    assert.equal(
      full.reduce((count, metric) => count + (metric.histogram?.dataPoints.length ?? 0), 0),
      12,
    );
    const priorExports = collectorMessages(await docker(["logs", owner.id!])).filter((message) =>
      message.startsWith("ResourceMetrics #0\n"),
    );
    assert.ok(priorExports.length >= 2, "Both earlier cumulative exports completed");
    for (const message of priorExports) assert.deepEqual(collectorResource(message), expectedResource);
    const previousStart = decodeCollectorExport(priorExports.at(-1)!)[0]!.start;
    const stopStarted = performance.now();
    await exporter.stop();
    assert.ok(performance.now() - stopStarted < 2000, "Final request completes within the shared stop bound");
    let completed: DecodedSeries[] = [];
    await until("complete latest decoded baseline mapping", async () => {
      const exports = collectorMessages(await docker(["logs", owner.id!])).filter((message) =>
        message.startsWith("ResourceMetrics #0\n"),
      );
      if (exports.length <= priorExports.length) return false;
      assert.equal(exports.length, priorExports.length + 1, "Stop emits exactly one final export");
      assert.deepEqual(
        collectorResource(exports.at(-1)!),
        expectedResource,
        "Final export belongs to this fixture session",
      );
      const latest = decodeCollectorExport(exports.at(-1)!);
      // Initialized loss series occur in earlier exports with zero values. Require the
      // final fixture's value on its exact tuple, in a complete new logger message.
      if (!latest.some((point) => point.key === "kello.diagnostics.loss.count|reason=export" && point.value === 29))
        return false;
      completed = latest;
      return true;
    });
    assert.equal(completed.length, 64);
    assert.equal(completed.filter((point) => point.type === "Sum").length, 52);
    assert.equal(completed.filter((point) => point.type === "Histogram").length, 12);
    assert.equal(new Set(completed.map((point) => point.key)).size, 64, "No duplicate tuples");
    for (const point of completed) {
      assert.equal(point.start, previousStart, "Every tuple retains the earlier cumulative session start");
      assert.ok(Date.parse(point.start) > 0);
      assert.ok(Date.parse(point.timestamp) >= Date.parse(point.start));
    }
    assert.equal(new Set(completed.map((point) => point.timestamp)).size, 1, "One snapshot end timestamp");
    assert.deepEqual(
      completed
        .map(({ start: _start, timestamp: _timestamp, ...point }) => point)
        .sort((a, b) => a.key.localeCompare(b.key)),
      expectedBaseline(),
    );
    assert.deepEqual(failures, []);
  } catch (error) {
    primary.push(error);
    // Preserve the object-only internal CLI error marker, including inherited properties and strict false.
    // eslint-disable-next-line anti-slop/no-runtime-typeof
    if (error !== null && typeof error === "object" && "reaped" in error && error.reaped === false)
      owner.cliUnreaped = true;
  } finally {
    await finishCollector(
      primary,
      async () => exporter?.stop(),
      owner,
      async () => rm(root, { recursive: true, force: true }),
    );
  }
}, 60000);

// All internal helpers and native RPC composition use source imports in this spike.
test("an unavailable collector does not delay native RPC and exporter stop stays bounded", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let inFlight = 0;
  let maximumInFlight = 0;
  const collector = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      inFlight++;
      maximumInFlight = Math.max(maximumInFlight, inFlight);
      entered.resolve();
      const cancelled = Promise.withResolvers<void>();
      const abort = () => cancelled.resolve();
      request.signal.addEventListener("abort", abort, { once: true });
      try {
        await Promise.race([release.promise, cancelled.promise]);
        return Response.json({});
      } finally {
        request.signal.removeEventListener("abort", abort);
        inFlight--;
      }
    },
  });
  const version = "e".repeat(64);
  const { procedure } = createProjectProcedures(defineSchema(() => ({})));
  let calls = 0;
  const app = createRpcHttpApp({
    router: { ping: procedure.handler(() => ++calls) },
    version,
    origins: [],
    allowAnonymous: true,
    verify: async () => {
      throw new Error("unused verifier");
    },
  });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => app.fetch(request) });
  const metrics = createDiagnosticsMetrics();
  const failures: string[] = [];
  let observations = 0;
  const diagnostics = await startDiagnostics({
    output: {
      format: "jsonl",
      write(chunk) {
        const record = JSON.parse(chunk);
        if (record.source === "runtime" && record.event.type === "rpc.procedure") {
          assert.equal(metrics.observe(record.event), true);
          observations++;
        }
      },
    },
  });
  const exporter = createOtlpExporter({
    endpoint: new URL("/v1/metrics", collector.url).href,
    snapshot: () => metrics.snapshot(),
    onFailure: (code) => {
      failures.push(code);
    },
  });
  try {
    const link = new RPCLink({
      origin: server.url.origin,
      url: "/api/kello/rpc",
      headers: { "x-loom-protocol": "loom-orpc-2", "x-loom-version": version },
    });
    assert.equal(await link.call(["ping"], undefined, { context: {} }), 1);
    await until("first RPC observation", async () => observations === 1);
    const pending = exporter.flush();
    await entered.promise;
    // The transport is awaiting collector I/O while a second real HTTP RPC completes.
    assert.equal(await link.call(["ping"], undefined, { context: {} }), 2);
    await until("second RPC observation", async () => observations === 2);
    const started = performance.now();
    await exporter.stop();
    assert.ok(performance.now() - started <= 2000, "Exporter stop must share the two-second deadline");
    await pending;
    assert.equal(maximumInFlight, 1);
    assert.ok(failures.includes("timeout"));
    assert.equal(calls, 2);
    assert.equal(diagnostics.snapshot().outputFailures, 0);
  } finally {
    release.resolve();
    try {
      await exporter.stop();
    } finally {
      try {
        await diagnostics.stop();
      } finally {
        await server.stop(true);
        await collector.stop(true);
      }
    }
  }
}, 10000);

test("integrated telemetry leaves native RPC available during collector failure and retains cumulative data", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const payloads: MetricsData[] = [];
  const collector = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      payloads.push(await request.json());
      if (payloads.length === 1) {
        entered.resolve();
        await release.promise;
        return new Response("REMOTE_CANARY", { status: 500 });
      }
      return Response.json({});
    },
  });
  let server: Bun.Server<undefined> | undefined;
  let diagnostics: Awaited<ReturnType<typeof startDiagnostics>> | undefined;
  try {
    const version = "f".repeat(64);
    const { procedure } = createProjectProcedures(defineSchema(() => ({})));
    let calls = 0;
    const app = createRpcHttpApp({
      router: { ping: procedure.handler(() => ++calls) },
      version,
      origins: [],
      allowAnonymous: true,
      verify: async () => {
        throw new Error("unused verifier");
      },
    });
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => app.fetch(request) });
    const session = await startDiagnostics({
      telemetry: {
        protocol: "otlp-http-json",
        endpoint: new URL("/v1/metrics", collector.url).href,
      },
    });
    diagnostics = session;
    const link = new RPCLink({
      origin: server.url.origin,
      url: "/api/kello/rpc",
      headers: { "x-loom-protocol": "loom-orpc-2", "x-loom-version": version },
    });
    assert.equal(await link.call(["ping"], undefined, { context: {} }), 1);
    await entered.promise;
    assert.equal(await link.call(["ping"], undefined, { context: {} }), 2);
    release.resolve();
    await until("integrated collector failure", async () => session.snapshot().exportFailures === 1);
    await session.stop();
    assert.equal(calls, 2);
    assert.equal(payloads.length, 2);
    const metrics = payloads[1]!.resourceMetrics.flatMap((resource) =>
      resource.scopeMetrics.flatMap((scope) => scope.metrics),
    );
    assert.equal(
      metrics.find((metric) => metric.name === "kello.rpc.procedure.count")?.sum?.dataPoints[0]?.asDouble,
      2,
    );
    const loss = metrics
      .find((metric) => metric.name === "kello.diagnostics.loss.count")
      ?.sum?.dataPoints.find((point) =>
        point.attributes?.some((attribute) => attribute.key === "reason" && attribute.value.stringValue === "export"),
      );
    assert.equal(loss?.asDouble, 1);
    assert.equal(session.snapshot().outputFailures, 0);
    assert.ok(!JSON.stringify(payloads).includes("REMOTE_CANARY"));
  } finally {
    release.resolve();
    try {
      await diagnostics?.stop();
    } finally {
      try {
        await server?.stop(true);
      } finally {
        await collector.stop(true);
      }
    }
  }
}, 15000);

test("the private Effect JSON bridge loads under native Bun and Node 24", async () => {
  const root = await mkdtemp(join(tmpdir(), "kello-001-otlp-native-"));
  try {
    await symlink(fileURLToPath(new URL("../node_modules", import.meta.url)), join(root, "node_modules"), "dir");
    const entry = join(root, "native.ts");
    const metricsPath = fileURLToPath(
      new URL("../../../apps/kello-cli/src/tooling/diagnostics/metrics.ts", import.meta.url),
    );
    const otlpPath = fileURLToPath(new URL("../../../apps/kello-cli/src/tooling/diagnostics/otlp.ts", import.meta.url));
    await writeFile(
      entry,
      `
      import assert from "node:assert/strict";
      import { createDiagnosticsMetrics } from ${JSON.stringify(metricsPath)};
      import { serializeMetrics } from ${JSON.stringify(otlpPath)};
      if (!process.versions.bun) assert.equal(Number(process.versions.node.split(".")[0]), 24);
      const metrics = createDiagnosticsMetrics();
      assert.equal(metrics.observe({type:"rpc.procedure",mode:"finite",status:"success",durationMs:7}), true);
      const bytes = await serializeMetrics(metrics.snapshot());
      const text = new TextDecoder().decode(bytes);
      assert.ok(!text.includes("ambient-canary"));
      const data = JSON.parse(text);
      assert.equal(data.resourceMetrics[0].resource.attributes.length, 4);
      assert.equal(data.resourceMetrics[0].scopeMetrics[0].metrics.length, 2);
      process.stdout.write(JSON.stringify({runtime:process.versions.bun ? "bun" : "node24",bytes:bytes.byteLength}));
    `,
    );
    const built = await Bun.build({
      entrypoints: [entry],
      outdir: root,
      target: "node",
      format: "esm",
      packages: "external",
    });
    assert.equal(built.success, true, built.logs.map(String).join("\n"));
    assert.equal(built.outputs.length, 1);
    for (const executable of [process.execPath, "node"]) {
      const child = Bun.spawn([executable, built.outputs[0]!.path], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          OTEL_RESOURCE_ATTRIBUTES: "secret=ambient-canary",
          OTEL_EXPORTER_OTLP_HEADERS: "authorization=ambient-canary",
          OTEL_EXPORTER_OTLP_ENDPOINT: "https://ambient-canary.invalid/metrics",
        },
      });
      const deadline = globalThis.setTimeout(() => child.kill("SIGKILL"), 10000);
      try {
        const [stdout, stderr, exit] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        assert.equal(exit, 0, stderr);
        assert.equal(stderr, "");
        const result = JSON.parse(stdout);
        assert.equal(result.runtime, executable === "node" ? "node24" : "bun");
        assert.ok(result.bytes > 0 && result.bytes <= 128 * 1024);
      } finally {
        clearTimeout(deadline);
        child.kill("SIGKILL");
        await child.exited;
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
