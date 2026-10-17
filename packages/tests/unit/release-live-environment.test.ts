import { expect, test } from "vite-plus/test";
import { releaseInputHash } from "../../../apps/kello/src/tooling/deploy/neon/prepare-release";

test("managed Realtime secret rotation changes keyed release identity without disclosing secrets", () => {
  const input = {
    slugs: { service: "service", worker: "worker" },
    variables: { APP_VALUE: "public" },
    schedules: [],
    storage: [],
  };
  const token = "a".repeat(64);
  const firstSecret = "test-only-first-realtime-signing-key";
  const secondSecret = "test-only-rotated-realtime-signing-key";
  const first = releaseInputHash(token, input, { LOOM_REALTIME_SECRET: firstSecret });
  const rotated = releaseInputHash(token, input, { LOOM_REALTIME_SECRET: secondSecret });
  expect(rotated).not.toBe(first);
  expect(releaseInputHash(token, input, { LOOM_REALTIME_SECRET: firstSecret })).toBe(first);
  expect(releaseInputHash("b".repeat(64), input, { LOOM_REALTIME_SECRET: firstSecret })).not.toBe(first);
  expect(JSON.stringify({ inputHash: first })).not.toContain(firstSecret);
  expect(first).toMatch(/^[a-f0-9]{64}$/);
});
