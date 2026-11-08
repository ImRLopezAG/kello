import { expect, test, vi } from "vite-plus/test";
import { createNeonDeploymentEntrypoint } from "kello/neon";

const binding = {
  metadataNamespace: "kello_meta",
  deployment: "preview",
  version: "a".repeat(64),
  projectId: "project",
  branchId: "br-preview",
  branchName: "preview",
  endpointHost: "ep-preview.example",
  databaseName: "neondb",
};
const token = "b".repeat(64);
const artifactHash = "c".repeat(64);
const health = () =>
  new Request("https://app.test/_kello/deployment/health", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });

test("shutdown drains a probe even when ordinary runtime cleanup fails", async () => {
  vi.stubEnv("KELLO_ACTIVATION_TOKEN", token);
  const probing = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let starts = 0;
  let settled = false;
  const entry = createNeonDeploymentEntrypoint({
    binding,
    artifactHash,
    role: "service",
    start: async () => {
      if (++starts === 1)
        return {
          fetch: async () => new Response("ordinary"),
          stop: async () => {
            throw new Error("cleanup failed");
          },
        };
      probing.resolve();
      await release.promise;
      return { fetch: async () => new Response("unused"), stop: async () => {} };
    },
  });
  try {
    await entry.fetch(new Request("https://app.test/ordinary"));
    const pending = entry.fetch(health());
    await probing.promise;
    const stopped = entry.stop().then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    release.resolve();
    await stopped;
    expect((await pending).status).toBe(503);
    expect(settled).toBe(true);
  } finally {
    release.resolve();
    await entry.stop().catch(() => {});
    vi.unstubAllEnvs();
  }
});

test("deployment health authenticates before startup and never dispatches through the probe runtime", async () => {
  vi.stubEnv("KELLO_ACTIVATION_TOKEN", token);
  let starts = 0;
  let stops = 0;
  let calls = 0;
  const entry = createNeonDeploymentEntrypoint({
    binding,
    artifactHash,
    role: "service",
    start: async () => {
      starts++;
      return {
        fetch: async () => {
          calls++;
          return new Response("ordinary");
        },
        stop: async () => {
          stops++;
        },
      };
    },
  });
  try {
    for (const request of [
      new Request(health().url),
      new Request(health().url, { method: "POST" }),
      new Request(health().url, { method: "POST", headers: { authorization: `Bearer ${"d".repeat(64)}` } }),
      new Request(health().url, { method: "POST", headers: { authorization: `Bearer ${"é".repeat(64)}` } }),
    ])
      expect((await entry.fetch(request)).status).toBe(404);
    expect(starts).toBe(0);
    expect((await entry.fetch(new Request(health(), { signal: AbortSignal.abort() }))).status).toBe(503);
    expect(starts).toBe(0);
    const response = await entry.fetch(health());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      format: 1,
      version: binding.version,
      artifactHash,
      role: "service",
      databaseDrainProtocol: 0,
    });
    expect([starts, stops, calls]).toEqual([1, 1, 0]);
    expect(await (await entry.fetch(new Request("https://app.test/ordinary"))).text()).toBe("ordinary");
    expect([starts, stops, calls]).toEqual([2, 1, 1]);
  } finally {
    await entry.stop();
    vi.unstubAllEnvs();
  }
  expect(stops).toBe(2);
  expect((await entry.fetch(health())).status).toBe(503);
});

test("deployment probe joins concurrent startup, drains shutdown and redacts failures", async () => {
  vi.stubEnv("KELLO_ACTIVATION_TOKEN", token);
  let starts = 0;
  let stops = 0;
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const entry = createNeonDeploymentEntrypoint({
    binding,
    artifactHash,
    role: "worker",
    start: async () => {
      starts++;
      started.resolve();
      await release.promise;
      return {
        fetch: async () => {
          throw new Error("must not dispatch");
        },
        stop: async () => {
          stops++;
        },
      };
    },
  });
  try {
    const first = entry.fetch(health());
    await started.promise;
    const second = entry.fetch(health());
    const stopping = entry.stop();
    expect(entry.stop()).toBe(stopping);
    release.resolve();
    expect((await first).status).toBe(503);
    expect((await second).status).toBe(503);
    await stopping;
    expect([starts, stops]).toEqual([1, 1]);
    let attempts = 0;
    const broken = createNeonDeploymentEntrypoint({
      binding,
      artifactHash,
      role: "worker",
      start: async () => {
        attempts++;
        if (attempts === 1) throw new Error("secret connection");
        return {
          fetch: async () => {
            throw new Error("must not dispatch");
          },
          stop: async () => {
            if (attempts === 2) throw new Error("secret cleanup failure");
          },
        };
      },
    });
    const failed = await broken.fetch(health());
    expect(failed.status).toBe(503);
    expect(await failed.text()).toBe("Service unavailable");
    const cleanupFailed = await broken.fetch(health());
    expect(cleanupFailed.status).toBe(503);
    expect(await cleanupFailed.text()).toBe("Service unavailable");
    expect((await broken.fetch(health())).status).toBe(200);
    await broken.stop();
  } finally {
    release.resolve();
    await entry.stop();
    vi.unstubAllEnvs();
  }
});
