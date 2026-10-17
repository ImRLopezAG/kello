import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defineConfig,
  resolveNeonProject,
  saveResolvedProject,
  loadProjectConfig,
  writeManagedPublicEnvironment,
  type DiscoveryProvider,
} from "kello/tooling";

function discovery(): DiscoveryProvider {
  return {
    getProject: async (id) => ({ id, name: "fixture", pgVersion: 18, regionId: "aws-us-east-2" }),
    listBranches: async () => [{ id: "br-test", name: "dev", protected: false, isDefault: true }],
    listBranchDatabases: async () => [{ name: "neondb", branchId: "br-test", ownerName: "neondb_owner" }],
    getNeonAuth: async () => ({
      projectId: "auth-fixture",
      baseUrl: "https://auth.example.test/auth",
      jwksUrl: "https://auth.example.test/jwks",
      secretServerKey: "secret-sentinel",
    }),
    getNeonDataApi: async () => ({ url: "https://data.example.test/rest" }),
    listBranchFunctions: async () => [
      { id: "fn-test", slug: "service", name: "service", invocationUrl: "https://functions.example.test/service" },
    ],
  };
}
test("config is optional and discovery keeps service, auth, and data URLs separate", async () => {
  const root = await mkdtemp(join(tmpdir(), "loom-resolution-"));
  try {
    const empty = await loadProjectConfig(root);
    expect(empty.config.backend).toBe("kello");
    expect(empty.publicConfiguration).toEqual({});
    await writeFile(join(root, ".neon"), JSON.stringify({ projectId: "project-test", branch: "dev" }));
    const resolved = await resolveNeonProject(root, defineConfig({}), { serviceSlug: "service" }, discovery());
    expect(resolved.public).toEqual({
      serviceUrl: "https://functions.example.test/service",
      authUrl: "https://auth.example.test/auth",
      dataApiUrl: "https://data.example.test/rest",
    });
    await saveResolvedProject(root, resolved);
    const linked = await loadProjectConfig(root);
    expect(linked.publicConfiguration).toEqual(resolved.public);
    expect(linked.config.projectId).toBe("project-test");
    expect(linked.config.branchId).toBe("br-test");
    expect(linked.config.development).toMatchObject({
      databaseName: "neondb",
      migrationRole: "neondb_owner",
      runtimeRole: "loom_runtime",
    });
    expect(linked.config.deployment).toMatchObject({
      environment: "preview",
      databaseName: "neondb",
      migrationRole: "neondb_owner",
      runtimeRole: "loom_runtime",
    });
    expect(await readFile(join(root, ".kello/project.json"), "utf8")).not.toContain("secret-sentinel");
    await writeFile(
      join(root, "kello.config.ts"),
      'export default { backend: "server", database: { namespace: "custom" } };',
    );
    expect((await loadProjectConfig(root)).config.backend).toBe("server");
    await writeFile(join(root, "kello.config.ts"), "export default null;");
    await assert.rejects(loadProjectConfig(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("conflicting projects, multiple databases, and absent selected functions fail closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "loom-ambiguous-"));
  try {
    await writeFile(join(root, ".neon"), JSON.stringify({ projectId: "project-test" }));
    await assert.rejects(resolveNeonProject(root, defineConfig({ projectId: "project-other" }), {}, discovery()), {
      code: "PROJECT_CONFLICT",
    });
    const api = discovery();
    api.listBranchDatabases = async () => [
      { name: "first", branchId: "br-test", ownerName: "owner" },
      { name: "second", branchId: "br-test", ownerName: "owner" },
    ];
    await assert.rejects(resolveNeonProject(root, defineConfig({}), {}, api), { code: "DATABASE_AMBIGUOUS" });
    expect((await resolveNeonProject(root, defineConfig({}), { databaseName: "second" }, api)).databaseName).toBe(
      "second",
    );
    await assert.rejects(resolveNeonProject(root, defineConfig({}), { serviceSlug: "missing" }, discovery()), {
      code: "SERVICE_AMBIGUOUS",
    });
    const resolved = await resolveNeonProject(root, defineConfig({}), {}, discovery());
    expect(resolved.public.serviceUrl).toBeUndefined();
    await saveResolvedProject(root, resolved);
    await writeFile(join(root, ".neon"), JSON.stringify({ projectId: "project-test", branch: "different" }));
    await assert.rejects(loadProjectConfig(root), { code: "PROJECT_STATE_INVALID" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("managed public env writes retain comments and unrelated CRLF content, rejecting secrets and duplicates", async () => {
  const root = await mkdtemp(join(tmpdir(), "loom-public-env-"));
  try {
    const path = join(root, ".env.local");
    await writeFile(
      path,
      '# retained\r\nUNRELATED="keep#this"\r\nLOOM_URL="https://old.example.test" # retained inline\r\n',
    );
    await writeManagedPublicEnvironment(root, {
      LOOM_URL: "https://new.example.test",
      NEON_PROJECT_ID: "project-test",
    });
    expect(await readFile(path, "utf8")).toBe(
      '# retained\r\nUNRELATED="keep#this"\r\nLOOM_URL="https://new.example.test" # retained inline\r\nNEON_PROJECT_ID="project-test"\r\n',
    );
    await assert.rejects(writeManagedPublicEnvironment(root, { LOOM_URL: "https://secret@host.example.test" }));
    await writeFile(path, 'LOOM_URL="https://a.test"\nLOOM_URL="https://b.test"\n');
    const before = await readFile(path, "utf8");
    await assert.rejects(writeManagedPublicEnvironment(root, { LOOM_URL: "https://new.test" }));
    expect(await readFile(path, "utf8")).toBe(before);
    await writeManagedPublicEnvironment(root, { LOOM_URL: undefined });
    expect(await readFile(path, "utf8")).toBe(before);
    await rm(path);
    await writeFile(join(root, "private.env"), "SECRET=preserve\n");
    await symlink("private.env", path);
    await assert.rejects(writeManagedPublicEnvironment(root, { LOOM_URL: "https://new.test" }), /non-file/);
    expect(await readFile(join(root, "private.env"), "utf8")).toBe("SECRET=preserve\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("relink removes an old public endpoint when the new branch has none", async () => {
  const root = await mkdtemp(join(tmpdir(), "loom-clear-env-"));
  try {
    await writeFile(join(root, ".env.local"), 'LOOM_URL="https://old.test" # old deployment\nOTHER=retained\n');
    await writeManagedPublicEnvironment(root, { LOOM_URL: null, NEON_AUTH_URL: null });
    expect(await readFile(join(root, ".env.local"), "utf8")).toBe("# old deployment\nOTHER=retained\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
