import assert from "node:assert/strict";
import { expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateProject, initializeProject, loadProjectConfig, saveResolvedProject } from "kello-cli";
import type { DiscoveryProvider } from "kello-cli";
import { publishDeployedClient } from "../../../apps/kello-cli/src/tooling/deploy/neon/publish-client";

test("deployment discovery updates the generated client without changing its release version", async () => {
  const root = await mkdtemp(join(tmpdir(), "loom-deployed-client-"));
  const provider: DiscoveryProvider = {
    getProject: async (id) => ({ id, name: "fixture", pgVersion: 18, regionId: "aws-us-east-2" }),
    listBranches: async () => [{ id: "br-test", name: "dev", protected: false, isDefault: false }],
    listBranchDatabases: async () => [{ name: "neondb", branchId: "br-test", ownerName: "neondb_owner" }],
    getNeonAuth: async () => null,
    getNeonDataApi: async () => null,
    listBranchFunctions: async () => [
      { id: "fn-test", slug: "service", name: "service", invocationUrl: "https://functions.example.test/service" },
    ],
  };
  try {
    await initializeProject(root, "client");
    await symlink(
      await realpath(fileURLToPath(new URL("../node_modules", import.meta.url))),
      join(root, "node_modules"),
    );
    await saveResolvedProject(root, {
      format: 1,
      projectId: "project-test",
      branchId: "br-test",
      branchName: "dev",
      protected: false,
      isDefault: false,
      databaseName: "neondb",
      migrationRole: "neondb_owner",
      public: {},
    });
    const generated = await generateProject(root);
    const identity = {
      projectId: "project-test",
      branchId: "br-test",
      version: generated.version,
      serviceSlug: "service",
    };
    await publishDeployedClient(root, identity, provider);
    expect((await generateProject(root)).version).toBe(generated.version);
    expect(await readFile(join(root, "kello/_generated/config.js"), "utf8")).toContain(
      "https://functions.example.test/service",
    );
    expect(await readFile(join(root, ".env.local"), "utf8")).toContain(
      'LOOM_URL="https://functions.example.test/service"',
    );
    const priorUrl = process.env.LOOM_URL;
    try {
      process.env.LOOM_URL = "https://old.example.test/service";
      await publishDeployedClient(root, identity, provider);
      expect(await readFile(join(root, "kello/_generated/config.js"), "utf8")).not.toContain("old.example.test");
    } finally {
      if (priorUrl === undefined) delete process.env.LOOM_URL;
      else process.env.LOOM_URL = priorUrl;
    }
    await assert.rejects(
      publishDeployedClient(root, { ...identity, serviceSlug: "missing" }, provider),
      /absent or ambiguous/,
    );
    await publishDeployedClient(root, { ...identity, branchId: "br-other" }, provider);
    expect((await loadProjectConfig(root)).config.branchId).toBe("br-test");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
