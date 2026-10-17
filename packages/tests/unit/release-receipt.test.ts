import { expect, test } from "vite-plus/test";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withNeonReleaseReceipt } from "kello/tooling";
import type { NeonReleaseStage } from "kello/tooling";

const key = "a".repeat(64);
const identity = {
  deployment: "preview",
  version: "b".repeat(64),
  inputHash: "c".repeat(64),
  target: {
    environment: "preview" as const,
    projectId: "project",
    branchId: "branch",
    branchName: "preview",
    endpointId: "ep-preview",
    postgresVersion: 18 as const,
    protected: false,
  },
  database: {
    endpointHost: "ep-preview.example",
    databaseName: "neondb",
    namespace: "app",
    metadataNamespace: "loom_meta",
  },
  schema: { minimum: "d".repeat(64), maximum: "e".repeat(64), target: "e".repeat(64) },
  migrationHashes: ["f".repeat(64)],
};

test("release receipt persists ordered acknowledgements and rejects changed inputs or progress", async () => {
  const root = await mkdtemp(join(tmpdir(), "loom-release-"));
  const metrics = channel("kello.deployment.metric");
  const events: string[] = [];
  const capture: Parameters<typeof metrics.subscribe>[0] = (event) => events.push(JSON.stringify(event));
  metrics.subscribe(capture);
  try {
    await expect(
      withNeonReleaseReceipt(root, key, { ...identity, version: "secret-value" }, async () => {}),
    ).rejects.toEqual(new Error("Invalid release identity"));
    const session = await withNeonReleaseReceipt(root, key, identity, async (receipt) => {
      expect(receipt.read().completed).toEqual([]);
      await expect(receipt.complete({ stage: "migrations", head: identity.schema.target })).rejects.toThrow("order");
      await receipt.complete({ stage: "metadata" });
      await receipt.complete({ stage: "metadata" });
      await receipt.complete({ stage: "quarantine", revokedGrants: 1, cancelledJobs: 2 });
      expect(events).toEqual([
        JSON.stringify({ type: "release.acknowledgement", stage: "metadata", status: "recorded" }),
        JSON.stringify({ type: "release.acknowledgement", stage: "metadata", status: "replayed" }),
        JSON.stringify({ type: "release.acknowledgement", stage: "quarantine", status: "recorded" }),
      ]);
      await expect(receipt.complete({ stage: "quarantine", revokedGrants: 0, cancelledJobs: 2 })).rejects.toThrow(
        "conflict",
      );
      expect(events).toHaveLength(3);
      const copy = receipt.read();
      copy.completed.length = 0;
      expect(receipt.read().completed).toHaveLength(2);
      await expect(withNeonReleaseReceipt(root, key, identity, async () => {})).rejects.toThrow("locked");
      return receipt;
    });
    await expect(session.complete({ stage: "metadata" })).rejects.toThrow("closed");
    await expect(
      withNeonReleaseReceipt(root, key, { ...identity, version: "1".repeat(64) }, async () => {}),
    ).rejects.toThrow("identity");
    await withNeonReleaseReceipt(root, key, identity, async (receipt) => {
      expect(receipt.read().completed).toHaveLength(2);
      await expect(receipt.complete({ stage: "migrations", head: "0".repeat(64) })).rejects.toThrow("schema");
      await receipt.complete({ stage: "migrations", head: identity.schema.target });
    });
    const path = join(root, ".kello/releases", key, "release.json");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, "utf8")).completed).toHaveLength(3);
    expect(events).toHaveLength(4);
    expect(events.at(-1)).toBe(
      JSON.stringify({ type: "release.acknowledgement", stage: "migrations", status: "recorded" }),
    );
    await writeFile(path, "{broken");
    await expect(withNeonReleaseReceipt(root, key, identity, async () => {})).rejects.toThrow("read");
    expect(await readFile(path, "utf8")).toBe("{broken");
  } finally {
    metrics.unsubscribe(capture);
    await rm(root, { recursive: true, force: true });
  }
});

test("release receipts bind final functions and enabled triggers to prepared resources", async () => {
  const root = await mkdtemp(join(tmpdir(), "loom-release-stages-"));
  const functions = [
    { role: "service" as const, functionId: "service-id", deploymentId: 1, slug: "loomservice" },
    { role: "worker" as const, functionId: "worker-id", deploymentId: 2, slug: "loomworker" },
  ] satisfies Extract<NeonReleaseStage, { stage: "bootstrap" }>["functions"];
  const trigger = {
    triggerId: "wake",
    name: "wake",
    functionSlug: "loomworker",
    functionPath: "/api/kello/triggers",
    enabled: false,
    inherited: false,
    type: "schedule" as const,
    cron: "* * * * *",
  };
  try {
    await withNeonReleaseReceipt(root, key, identity, async (receipt) => {
      await receipt.complete({ stage: "metadata" });
      await receipt.complete({ stage: "quarantine", revokedGrants: 0, cancelledJobs: 0 });
      await receipt.complete({ stage: "migrations", head: identity.schema.target });
      await receipt.complete({ stage: "prepared" });
      await expect(receipt.complete({ stage: "bootstrap", artifactHash: "secret-value", functions })).rejects.toThrow(
        "Invalid release acknowledgement",
      );
      await receipt.complete({ stage: "bootstrap", artifactHash: key, functions });
      await expect(
        receipt.complete({
          stage: "triggers",
          triggers: [{ ...trigger, enabled: true }],
          bindings: { wake: { kind: "wake", name: "wake" } },
        }),
      ).rejects.toThrow("bindings");
      await expect(
        receipt.complete({
          stage: "triggers",
          triggers: [{ ...trigger, functionSlug: "otherworker" }],
          bindings: { wake: { kind: "wake", name: "wake" } },
        }),
      ).rejects.toThrow("worker identity");
      await receipt.complete({
        stage: "triggers",
        triggers: [trigger],
        bindings: { wake: { kind: "wake", name: "wake" } },
      });
      await expect(
        receipt.complete({
          stage: "functions",
          artifactHash: identity.version,
          functions: [functions[0], { ...functions[1], functionId: "replacement" }],
        }),
      ).rejects.toThrow("identity");
      await receipt.complete({ stage: "functions", artifactHash: identity.version, functions });
      await receipt.complete({ stage: "health" });
      await receipt.complete({ stage: "activated" });
      await expect(receipt.complete({ stage: "complete", enabledTriggerIds: ["other"] })).rejects.toThrow("triggers");
      await receipt.complete({ stage: "complete", enabledTriggerIds: ["wake"] });
    });
    await withNeonReleaseReceipt(root, key, identity, async (receipt) => {
      expect(receipt.read().completed).toHaveLength(10);
      await receipt.complete({ stage: "complete", enabledTriggerIds: ["wake"] });
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed receipt writes require reopening and release the local lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "loom-release-write-"));
  const directory = join(root, ".kello/releases", key);
  const path = join(directory, "release.json");
  const saved = join(directory, "saved.json");
  const metrics = channel("kello.deployment.metric");
  const events: string[] = [];
  const capture: Parameters<typeof metrics.subscribe>[0] = (event) => events.push(JSON.stringify(event));
  metrics.subscribe(capture);
  try {
    await expect(
      withNeonReleaseReceipt(root, key, identity, async (receipt) => {
        await rename(path, saved);
        await mkdir(path);
        await expect(receipt.complete({ stage: "metadata" })).rejects.toThrow("uncertain");
        expect(events).toEqual([
          JSON.stringify({ type: "release.acknowledgement", stage: "metadata", status: "write-error" }),
        ]);
        await rm(path, { recursive: true });
        await rename(saved, path);
        await expect(receipt.complete({ stage: "metadata" })).rejects.toThrow("uncertain");
        expect(() => receipt.read()).toThrow("uncertain");
        throw new Error("provider stopped");
      }),
    ).rejects.toThrow("provider stopped");
    await withNeonReleaseReceipt(root, key, identity, async (receipt) => {
      expect(receipt.read().completed).toEqual([]);
      await receipt.complete({ stage: "metadata" });
    });
    expect(events).toEqual([
      JSON.stringify({ type: "release.acknowledgement", stage: "metadata", status: "write-error" }),
      JSON.stringify({ type: "release.acknowledgement", stage: "metadata", status: "recorded" }),
    ]);
  } finally {
    metrics.unsubscribe(capture);
    await rm(root, { recursive: true, force: true });
  }
});
import { channel } from "node:diagnostics_channel";
