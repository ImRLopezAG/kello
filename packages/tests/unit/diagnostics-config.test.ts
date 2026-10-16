import { describe, expect, test } from "vite-plus/test";
import { validateOtlpConfig } from "../../../apps/loom/src/tooling/diagnostics/config";

describe("private telemetry configuration", () => {
  test.each([
    "https://collector.example/custom/metrics",
    "http://127.0.0.1:4318/custom/metrics",
    "http://[::1]:4318/custom/metrics",
  ])("preserves the explicit endpoint and bearer header: %s", (endpoint) => {
    const config = validateOtlpConfig({ endpoint, bearerToken: "EXPLICIT" });
    expect(config.endpoint.href).toBe(endpoint);
    expect(config.headers.get("Content-Type")).toBe("application/json");
    expect(config.headers.get("Authorization")).toBe("Bearer EXPLICIT");
    expect(validateOtlpConfig({ endpoint }).headers.has("Authorization")).toBe(false);
  });

  test.each([
    "",
    "/v1/metrics",
    "https://collector.example",
    "https://collector.example/",
    "http://localhost/v1/metrics",
    "http://127.1/v1/metrics",
    "http://2130706433/v1/metrics",
    "http://127.0.0.2/v1/metrics",
    "http://0x7f000001/v1/metrics",
    "ftp://127.0.0.1/v1/metrics",
    "https://user:SECRET@collector.example/v1/metrics",
    "https://@collector.example/v1/metrics",
    "https://collector.example/v1/metrics?SECRET",
    "https://collector.example/v1/metrics#SECRET",
    "https://collector.example/v1/metrics?",
    "https://collector.example/v1/metrics#",
  ])("rejects invalid endpoint with a fixed secret-free error: %s", (endpoint) => {
    expect(() => validateOtlpConfig({ endpoint, bearerToken: "SECRET" })).toThrow(/^TELEMETRY_CONFIG_INVALID$/);
  });

  test.each(["SECRET\r", "SECRET\n", "SECRET\r\nInjected: value", "SECRET\u0100"])(
    "rejects invalid bearer header with a fixed error: %s",
    (bearerToken) => {
      expect(() => validateOtlpConfig({ endpoint: "https://collector.example/custom/metrics", bearerToken })).toThrow(
        /^TELEMETRY_CONFIG_INVALID$/,
      );
    },
  );
});
