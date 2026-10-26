import { test, expect } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { integrateProject, createNeonProject, type OnboardingProvider } from "kello-cli";

test("integration previews and preserves existing frontend configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "loom-integrate-"));
  try {
    const application = JSON.stringify({ name: "frontend", dependencies: { next: "16.0.0" } });
    await writeFile(join(root, "package.json"), application);
    await writeFile(join(root, "tsconfig.json"), "{}\n");
    const preview = await integrateProject(root, false);
    expect(preview.files).toContain("kello/schema.ts");
    expect(preview.applied).toBe(false);
    await assert.rejects(readFile(join(root, "kello/schema.ts")));
    const result = await integrateProject(root, true);
    expect(result.applied).toBe(true);
    expect(await readFile(join(root, "package.json"), "utf8")).toBe(application);
    expect(await readFile(join(root, "tsconfig.json"), "utf8")).toBe("{}\n");
    expect((await integrateProject(root, true)).files).toEqual([]);
    await writeFile(join(root, "kello/schema.ts"), "user changes\n");
    expect((await integrateProject(root, false)).collisions).toContain("kello/schema.ts");
    await assert.rejects(integrateProject(root, true), /collision/);
    expect(await readFile(join(root, "kello/schema.ts"), "utf8")).toBe("user changes\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an ambiguous create is reconciled without replaying the mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "loom-create-"));
  const projects: { id: string; name: string; orgId: string }[] = [];
  let creates = 0;
  const provider: OnboardingProvider = {
    organizations: async () => [{ id: "org-test", name: "Test" }],
    projects: async () => projects,
    create: async ({ name, orgId }) => {
      creates += 1;
      projects.push({ id: "project-test", name, orgId });
      throw new Error("response lost secret-sentinel");
    },
    rename: async (id, name) => {
      const row = projects.find((entry) => entry.id === id);
      assert(row);
      row.name = name;
    },
  };
  try {
    const input = { name: "app", orgId: "org-test", region: "aws-us-east-1" };
    await assert.rejects(createNeonProject(root, input, provider), /reconcile/);
    expect(await readFile(join(root, ".kello/onboarding.json"), "utf8")).not.toContain("secret-sentinel");
    expect((await createNeonProject(root, input, provider)).projectId).toBe("project-test");
    expect((await createNeonProject(root, input, provider)).projectId).toBe("project-test");
    expect(creates).toBe(1);
    expect(projects[0]?.name).toBe("app");
    await assert.rejects(createNeonProject(root, { ...input, name: "other" }, provider), /different/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a missing result or denied create stays unresolved without issuing a second create", async () => {
  const root = await mkdtemp(join(tmpdir(), "loom-create-denied-"));
  let creates = 0;
  const provider: OnboardingProvider = {
    organizations: async () => [],
    projects: async () => [],
    create: async () => {
      creates += 1;
      throw new Error("quota or permission failure");
    },
    rename: async () => {
      throw new Error("unexpected rename");
    },
  };
  try {
    const input = { name: "app", orgId: "org-test", region: "aws-us-east-1" };
    await assert.rejects(createNeonProject(root, input, provider), /reconcile/);
    await assert.rejects(createNeonProject(root, input, provider), /reconcile/);
    expect(creates).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent create calls cannot both mutate Neon", async () => {
  const root = await mkdtemp(join(tmpdir(), "loom-create-concurrent-"));
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let creates = 0;
  const provider: OnboardingProvider = {
    organizations: async () => [],
    projects: async () => [],
    create: async () => {
      creates += 1;
      entered.resolve();
      await release.promise;
      return { id: "project-test" };
    },
    rename: async () => {},
  };
  const input = { name: "app", orgId: "org-test", region: "aws-us-east-1" };
  const first = createNeonProject(root, input, provider);
  try {
    await entered.promise;
    await assert.rejects(createNeonProject(root, input, provider), /locked/);
    release.resolve();
    expect((await first).projectId).toBe("project-test");
    expect(creates).toBe(1);
  } finally {
    release.resolve();
    await first;
    await rm(root, { recursive: true, force: true });
  }
});

test("a definite permission rejection permits an explicit retry after access is repaired", async () => {
  const root = await mkdtemp(join(tmpdir(), "loom-create-permission-"));
  let creates = 0;
  const provider: OnboardingProvider = {
    organizations: async () => [],
    projects: async () => [],
    create: async () => {
      creates += 1;
      if (creates === 1) throw Object.assign(new Error("sensitive provider body"), { kind: "auth", status: 403 });
      return { id: "project-test" };
    },
    rename: async () => {},
  };
  try {
    const input = { name: "app", orgId: "org-test", region: "aws-us-east-1" };
    await assert.rejects(createNeonProject(root, input, provider), /HTTP 403/);
    expect((await createNeonProject(root, input, provider)).projectId).toBe("project-test");
    expect(creates).toBe(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an existing link prevents an accidental extra cloud project", async () => {
  const root = await mkdtemp(join(tmpdir(), "loom-create-linked-"));
  let creates = 0;
  const provider: OnboardingProvider = {
    organizations: async () => [],
    projects: async () => [],
    create: async () => {
      creates += 1;
      return { id: "project-new" };
    },
    rename: async () => {},
  };
  try {
    await writeFile(join(root, ".neon"), JSON.stringify({ projectId: "project-existing" }));
    await assert.rejects(
      createNeonProject(root, { name: "app", orgId: "org-test", region: "aws-us-east-1" }, provider),
      /already selects/,
    );
    expect(creates).toBe(0);
    await rm(join(root, ".neon"));
    await mkdir(join(root, ".kello"), { recursive: true });
    await writeFile(
      join(root, ".kello/project.json"),
      JSON.stringify({
        format: 1,
        projectId: "project-existing",
        branchId: "br-existing",
        branchName: "main",
        protected: false,
        isDefault: true,
        databaseName: "neondb",
        migrationRole: "neondb_owner",
        public: {},
      }),
    );
    await assert.rejects(
      createNeonProject(root, { name: "app", orgId: "org-test", region: "aws-us-east-1" }, provider),
      /already selects/,
    );
    expect(creates).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
