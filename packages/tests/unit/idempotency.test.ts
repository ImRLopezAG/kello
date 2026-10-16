import { expect, test } from "vite-plus/test";
import { prepareMutationReplay, validateIdempotencyOptions } from "../../../apps/kello/src/core/server/idempotency";
import type { JsonValue } from "kello/server";

const options = { deployment: "test", metadataNamespace: "loom_meta" };
test("idempotency configuration and keys reject invalid or unbounded identifiers", () => {
  expect(() => validateIdempotencyOptions(options)).not.toThrow();
  for (const metadataNamespace of ["public", "loom_meta; DROP SCHEMA public", `loom_${"x".repeat(59)}`]) {
    expect(() => validateIdempotencyOptions({ ...options, metadataNamespace })).toThrow();
  }
  for (const deployment of ["", "x".repeat(257)]) {
    expect(() => validateIdempotencyOptions({ ...options, deployment })).toThrow();
  }
  for (const key of [undefined, "", "with spaces", "x".repeat(129)]) {
    expect(() => prepareMutationReplay(options, null, key, null)).toThrow("INVALID_IDEMPOTENCY_KEY");
  }
  expect(() => prepareMutationReplay(options, null, crypto.randomUUID(), null)).not.toThrow();
});

test("mutation fingerprints refuse non-JSON values before database work", () => {
  const sparse: JsonValue[] = [];
  sparse.length = 1;
  for (const args of [Number.NaN, Infinity, { nested: [-Infinity] }, sparse]) {
    expect(() => prepareMutationReplay(options, null, "key", args)).toThrow();
  }
});
