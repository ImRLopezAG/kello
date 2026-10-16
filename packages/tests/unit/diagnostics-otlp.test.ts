import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { MetricsData } from "effect/observability/OtlpMetrics";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import {
  createOtlpExporter,
  serializeMetrics,
  type OtlpFailureCode,
} from "../../../apps/loom/src/tooling/diagnostics/otlp";

function metrics(count = 1): MetricsData {
  return {
    resourceMetrics: [
      {
        resource: {
          attributes: [{ key: "service.name", value: { stringValue: "kello-dev" } }],
          droppedAttributesCount: 0,
        },
        scopeMetrics: [
          {
            scope: { name: "kello" },
            metrics: [
              {
                name: "kello.rpc.procedure.count",
                sum: {
                  aggregationTemporality: 2,
                  isMonotonic: true,
                  dataPoints: [
                    {
                      attributes: [],
                      startTimeUnixNano: "1791331200000000000",
                      timeUnixNano: "1791331200000000001",
                      asDouble: count,
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    ],
  };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function collector(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || Object.prototype.toString.call(address) === "[object String]") throw new Error("SERVER_ADDRESS");
  // SAFETY: listen(0, literal IP) produces an IP socket address, checked above.
  const port = (address as AddressInfo).port;
  cleanups.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  );
  return `http://127.0.0.1:${port}/custom/metrics`;
}

function exporter(endpoint: string, snapshot = () => metrics(), onFailure?: (code: OtlpFailureCode) => void) {
  const failures: OtlpFailureCode[] = [];
  const value = createOtlpExporter({ endpoint, snapshot, onFailure: onFailure ?? ((code) => failures.push(code)) });
  cleanups.push(() => value.stop(performance.now()));
  return { value, failures };
}

async function body(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

describe("private OTLP JSON bridge", () => {
  test("serializes upstream MetricsData bytes with decimal nanoseconds and cumulative enum", async () => {
    const data = metrics(3);
    const bytes = await serializeMetrics(data);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual(data);
    expect(new TextDecoder().decode(bytes)).toContain('"1791331200000000001"');
  });

  test("rejects serialized bytes above 128 KiB with a fixed code", async () => {
    const data: MetricsData = {
      resourceMetrics: [
        {
          resource: {
            attributes: [{ key: "service.name", value: { stringValue: "é".repeat(70_000) } }],
            droppedAttributesCount: 0,
          },
          scopeMetrics: [],
        },
      ],
    };
    await expect(serializeMetrics(data)).rejects.toThrow("TELEMETRY_OVERSIZED");
  });

  test("accepts exactly 128 KiB request and exactly 16 KiB valid response", async () => {
    const data: MetricsData = {
      resourceMetrics: [
        {
          resource: {
            attributes: [{ key: "padding", value: { stringValue: "" } }],
            droppedAttributesCount: 0,
          },
          scopeMetrics: [],
        },
      ],
    };
    data.resourceMetrics[0]!.resource.attributes[0]!.value.stringValue = "x".repeat(
      128 * 1024 - JSON.stringify(data).length,
    );
    expect((await serializeMetrics(data)).byteLength).toBe(128 * 1024);
    let received = "";
    const endpoint = await collector((request, response) => {
      void (async () => {
        received = await body(request);
        response.end("{}" + " ".repeat(16 * 1024 - 2));
      })();
    });
    const { value, failures } = exporter(endpoint, () => data);
    await value.flush();
    expect(received.length).toBe(128 * 1024);
    expect(failures).toEqual([]);
  });

  test.each([
    "http://localhost:4318/v1/metrics",
    "http://127.1/v1/metrics",
    "http://2130706433/v1/metrics",
    "http://127.0.0.2/v1/metrics",
    "ftp://127.0.0.1/v1/metrics",
    "/v1/metrics",
    "https://collector.example",
    "https://user:SECRET@collector.example/v1/metrics",
    "https://collector.example/v1/metrics?SECRET",
    "https://collector.example/v1/metrics#SECRET",
    "https://collector.example/v1/metrics?",
    "https://collector.example/v1/metrics#",
  ])("rejects invalid configuration before timers: %s", (endpoint) => {
    vi.useFakeTimers();
    expect(() =>
      createOtlpExporter({ endpoint, bearerToken: "SECRET", snapshot: () => metrics(), onFailure: () => {} }),
    ).toThrow(/^TELEMETRY_CONFIG_INVALID$/);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("accepts explicit HTTPS and literal IPv6 without contacting either on expired stop", async () => {
    for (const endpoint of ["https://collector.example/custom/metrics", "http://[::1]:4318/v1/metrics"])
      await exporter(endpoint).value.stop(performance.now());
  });

  test("preserves path, sends only explicit bearer and ignores ambient OTEL canaries", async () => {
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://127.0.0.2:1/SECRET");
    vi.stubEnv("OTEL_EXPORTER_OTLP_HEADERS", "secret=AMBIENT_SECRET");
    vi.stubEnv("OTEL_RESOURCE_ATTRIBUTES", "secret=AMBIENT_SECRET");
    vi.stubEnv("OTEL_SDK_DISABLED", "true");
    const received: Array<{
      url: string | undefined;
      authorization: string | undefined;
      body: string;
      contentType: string | undefined;
    }> = [];
    const endpoint = await collector((request, response) => {
      void (async () => {
        received.push({
          url: request.url,
          authorization: request.headers.authorization,
          body: await body(request),
          contentType: request.headers["content-type"],
        });
        response.end("{}");
      })();
    });
    const value = createOtlpExporter({
      endpoint,
      bearerToken: "EXPLICIT",
      snapshot: () => metrics(),
      onFailure: () => {},
    });
    cleanups.push(() => value.stop(performance.now()));
    await value.flush();
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({
      url: "/custom/metrics",
      authorization: "Bearer EXPLICIT",
      body: JSON.stringify(metrics()),
      contentType: "application/json",
    });
    expect(JSON.stringify(received)).not.toContain("AMBIENT_SECRET");
  });

  test("manual redirects never send the bearer canary to another origin", async () => {
    const stolen: string[] = [];
    const destination = await collector((request, response) => {
      stolen.push(request.headers.authorization ?? "none");
      response.end("{}");
    });
    const endpoint = await collector((_request, response) => {
      response.writeHead(307, { location: destination });
      response.end("{}");
    });
    const failures: OtlpFailureCode[] = [];
    const value = createOtlpExporter({
      endpoint,
      bearerToken: "BEARER_CANARY",
      snapshot: () => metrics(),
      onFailure: (code) => failures.push(code),
    });
    cleanups.push(() => value.stop(performance.now()));
    await value.flush();
    expect(stolen).toEqual([]);
    expect(failures).toEqual(["rejected"]);
  });

  test.each([401, 403, 429, 500])("contains HTTP %s as rejected", async (status) => {
    const endpoint = await collector((_request, response) => {
      response.writeHead(status);
      response.end("SECRET");
    });
    const { value, failures } = exporter(endpoint);
    await expect(value.flush()).resolves.toBeUndefined();
    expect(failures).toEqual(["rejected"]);
  });

  test.each([
    ["{}", undefined],
    ['{"partialSuccess":{}}', undefined],
    ['{"partialSuccess":{"rejectedDataPoints":"0","errorMessage":""}}', undefined],
    ['{"partialSuccess":{"rejectedDataPoints":1}}', "partial"],
    ['{"partialSuccess":{"rejectedDataPoints":"2"}}', "partial"],
    ['{"partialSuccess":{"errorMessage":"SECRET"}}', "partial"],
    ["not-json", "rejected"],
    ["null", "rejected"],
    ['{"partialSuccess":null}', "rejected"],
    ['{"partialSuccess":{"rejectedDataPoints":"no"}}', "rejected"],
    ['{"partialSuccess":{"errorMessage":4}}', "rejected"],
    ["[]", "rejected"],
    ["", "rejected"],
  ] as const)("interprets OTLP response %s", async (text, expected) => {
    const endpoint = await collector((_request, response) => response.end(text));
    const { value, failures } = exporter(endpoint);
    await value.flush();
    expect(failures).toEqual(expected ? [expected] : []);
  });

  test("caps streamed response at 16 KiB and cancels without waiting for EOF", async () => {
    const closed = Promise.withResolvers<void>();
    const endpoint = await collector((_request, response) => {
      response.on("close", () => closed.resolve());
      response.write(" ".repeat(16 * 1024));
      response.write(" ");
    });
    const { value, failures } = exporter(endpoint);
    await value.flush();
    expect(failures).toEqual(["oversized"]);
    await closed.promise;
  });

  test("one second deadline includes a body hung after response headers", async () => {
    const endpoint = await collector((_request, response) => {
      response.writeHead(200);
      response.write("{");
    });
    const { value, failures } = exporter(endpoint);
    const started = performance.now();
    await value.flush();
    expect(performance.now() - started).toBeLessThan(1600);
    expect(failures).toEqual(["timeout"]);
  });

  test("does not submit bytes if snapshot and serialization already consumed the request deadline", async () => {
    vi.useFakeTimers({ toFake: ["performance"] });
    let requests = 0;
    const endpoint = await collector((_request, response) => {
      requests++;
      response.end("{}");
    });
    const { value, failures } = exporter(endpoint, () => {
      vi.advanceTimersByTime(1100);
      return metrics();
    });
    await value.flush();
    expect(requests).toBe(0);
    expect(failures).toEqual(["timeout"]);
  });

  test("malformed UTF-8 is rejected without exposing response bytes", async () => {
    const endpoint = await collector((_request, response) => response.end(Buffer.from([0xff])));
    const { value, failures } = exporter(endpoint);
    await value.flush();
    expect(failures).toEqual(["rejected"]);
  });

  test("overlapping flush joins one flight, then recovery sends the next cumulative snapshot", async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const received: string[] = [];
    let count = 1;
    const endpoint = await collector((request, response) => {
      void (async () => {
        received.push(await body(request));
        if (received.length === 1) {
          started.resolve();
          await release.promise;
          response.writeHead(500);
        }
        response.end("{}");
      })();
    });
    const { value, failures } = exporter(endpoint, () => metrics(count));
    const first = value.flush();
    await started.promise;
    count = 3;
    const second = value.flush();
    expect(second).toBe(first);
    expect(received).toHaveLength(1);
    release.resolve();
    await Promise.all([first, second]);
    await value.flush();
    expect(received.map((text) => JSON.parse(text))).toEqual([metrics(1), metrics(3)]);
    expect(failures).toEqual(["rejected"]);
  });

  test("periodic attempts run every ten seconds without catch-up or overlap", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let requests = 0;
    const endpoint = await collector((_request, response) => {
      requests++;
      started.resolve();
      void release.promise.then(() => response.end("{}"));
    });
    const { value } = exporter(endpoint);
    await vi.advanceTimersByTimeAsync(9999);
    expect(requests).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    await started.promise;
    await vi.advanceTimersByTimeAsync(30000);
    expect(requests).toBe(1);
    const flight = value.flush();
    release.resolve();
    await flight;
    expect(requests).toBe(1);
    await vi.advanceTimersByTimeAsync(10000);
    await value.flush();
    expect(requests).toBe(2);
    await value.stop(performance.now());
    await vi.advanceTimersByTimeAsync(30000);
    expect(requests).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("stop joins in-flight work then sends one final cumulative snapshot with no overlap", async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const received: string[] = [];
    let count = 1;
    const endpoint = await collector((request, response) => {
      void (async () => {
        received.push(await body(request));
        if (received.length === 1) {
          started.resolve();
          await release.promise;
        }
        response.end("{}");
      })();
    });
    const { value } = exporter(endpoint, () => metrics(count));
    const flight = value.flush();
    await started.promise;
    count = 4;
    const stopping = value.stop();
    expect(value.stop()).toBe(stopping);
    const joined = value.flush();
    expect(received).toHaveLength(1);
    release.resolve();
    await flight;
    await joined;
    await stopping;
    expect(received.map((text) => JSON.parse(text))).toEqual([metrics(1), metrics(4)]);
    await value.flush();
    expect(received).toHaveLength(2);
  });

  test("disconnect during stop settles the flight and sends one final cumulative snapshot", async () => {
    const entered = Promise.withResolvers<ServerResponse>();
    const received: string[] = [];
    let count = 1;
    const endpoint = await collector((request, response) => {
      void (async () => {
        received.push(await body(request));
        if (received.length === 1) {
          response.writeHead(200, { "content-type": "application/json" });
          response.write("{");
          entered.resolve(response);
        } else response.end("{}");
      })();
    });
    const { value, failures } = exporter(endpoint, () => metrics(count));
    const flight = value.flush();
    const response = await entered.promise;
    count = 4;
    const before = performance.now();
    const stopping = value.stop();
    response.destroy();
    await expect(flight).resolves.toBeUndefined();
    await expect(stopping).resolves.toBeUndefined();
    expect(performance.now() - before).toBeLessThan(2000);
    expect(failures).toEqual(["network"]);
    expect(received.map((text) => JSON.parse(text))).toEqual([metrics(1), metrics(4)]);
    await value.flush();
    expect(received).toHaveLength(2);
  });

  test("short stop deadline cancels hung body and leaves no time for a second request", async () => {
    const started = Promise.withResolvers<void>();
    let requests = 0;
    const endpoint = await collector((_request, response) => {
      requests++;
      response.write("{");
      started.resolve();
    });
    const { value, failures } = exporter(endpoint);
    const flight = value.flush();
    await started.promise;
    const before = performance.now();
    await value.stop(before + 80);
    await flight;
    expect(performance.now() - before).toBeLessThan(500);
    expect(requests).toBe(1);
    expect(failures).toEqual(["timeout"]);
  });

  test("default stop bounds in-flight and hung final response within two seconds", async () => {
    const started = Promise.withResolvers<void>();
    let requests = 0;
    const endpoint = await collector((_request, response) => {
      requests++;
      response.write("{");
      started.resolve();
    });
    const { value, failures } = exporter(endpoint);
    void value.flush();
    await started.promise;
    const before = performance.now();
    await value.stop();
    expect(performance.now() - before).toBeLessThan(2400);
    expect(requests).toBe(2);
    expect(failures).toEqual(["timeout", "timeout"]);
  });

  test("dead collector, snapshot and callback failures never reject flush or stop", async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || Object.prototype.toString.call(address) === "[object String]") throw new Error("SERVER_ADDRESS");
    // SAFETY: listen on an IP returns the IP address variant.
    const port = (address as AddressInfo).port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const { value, failures } = exporter(`http://127.0.0.1:${port}/v1/metrics`);
    await expect(value.flush()).resolves.toBeUndefined();
    expect(failures).toEqual(["network"]);
    const broken = exporter(
      "http://127.0.0.1:1/v1/metrics",
      () => {
        throw new Error("SECRET");
      },
      () => {
        throw new Error("SECRET");
      },
    );
    await expect(broken.value.flush()).resolves.toBeUndefined();
    await expect(broken.value.stop()).resolves.toBeUndefined();
  });

  test("contains serialization bounds failure before network", async () => {
    let requests = 0;
    const endpoint = await collector((_request, response) => {
      requests++;
      response.end("{}");
    });
    const data: MetricsData = {
      resourceMetrics: [
        {
          resource: {
            attributes: [{ key: "large", value: { stringValue: "x".repeat(131072) } }],
            droppedAttributesCount: 0,
          },
          scopeMetrics: [],
        },
      ],
    };
    const { value, failures } = exporter(endpoint, () => data);
    await value.flush();
    expect(requests).toBe(0);
    expect(failures).toEqual(["oversized"]);
  });
});
