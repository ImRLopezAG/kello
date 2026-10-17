import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defineConfig,
  enableRealtime,
  createRealtimeProvider,
  loadProjectConfig,
  readRealtimeStatus,
  RealtimeError,
  type DiscoveryProvider,
  type RealtimeEnableInput,
  type RealtimeProvider,
} from "kello/tooling";

import { realtimeStatusCommand } from "../../../apps/kello/src/commands/realtime";

const canary = "nrt_live_1_secret-canary";
const origins = ["https://app.example.test"];

function discovery(branch = { id: "br-test", name: "dev", protected: false, isDefault: false }): DiscoveryProvider {
  return {
    getProject: async (id) => ({ id, name: "fixture", pgVersion: 18, regionId: "aws-us-east-2" }),
    listBranches: async () => [branch],
    listBranchDatabases: async () => [{ name: "neondb", branchId: branch.id, ownerName: "neondb_owner" }],
    getNeonAuth: async () => null,
    getNeonDataApi: async () => null,
    listBranchFunctions: async () => [],
  };
}

function realtime(states: { enabled: boolean; pending: boolean }[], compute = true) {
  const enable: RealtimeEnableInput[] = [];
  const calls = { get: 0, enable };
  const provider: RealtimeProvider = {
    hasCompute: async () => compute,
    get: async (projectId, branchId) => {
      expect([projectId, branchId]).toEqual(["project-test", "br-test"]);
      const state = states[Math.min(calls.get++, states.length - 1)]!;
      return {
        ...state,
        invocationUrl: state.enabled ? "https://realtime.example.test/br-test" : undefined,
        allowedOrigins: state.enabled ? origins : [],
        secret: canary,
      };
    },
    enable: async (input) => {
      calls.enable.push(input);
    },
  };
  return { provider, calls };
}

async function project() {
  const root = await mkdtemp(join(tmpdir(), "kello-realtime-"));
  await writeFile(join(root, ".neon"), JSON.stringify({ projectId: "project-test", branch: "dev" }));
  return root;
}

test("status is read-only and reports the bound target without secrets", async () => {
  const root = await project();
  try {
    const { provider, calls } = realtime([{ enabled: false, pending: false }]);
    const status = await readRealtimeStatus(root, defineConfig({}), {}, discovery(), provider);
    expect(status).toEqual({
      projectId: "project-test",
      branchId: "br-test",
      branchName: "dev",
      databaseName: "neondb",
      state: "disabled",
      allowedOrigins: [],
    });
    expect(calls.enable).toEqual([]);
    await assert.rejects(readFile(join(root, ".loom/project.json")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("enable waits for readiness, persists the public URL, and is idempotent", async () => {
  const root = await project();
  try {
    const { provider, calls } = realtime([
      { enabled: false, pending: false },
      { enabled: true, pending: false },
    ]);
    const options = { allowedOrigins: origins, timeoutMs: 1_000 };
    const ready = await enableRealtime(root, defineConfig({}), options, discovery(), provider);
    expect(ready).toMatchObject({ state: "ready", realtimeUrl: "https://realtime.example.test/br-test" });
    expect(calls.enable).toEqual([
      { projectId: "project-test", branchId: "br-test", allowedOrigins: origins, timeoutMs: 1_000 },
    ]);
    expect((await enableRealtime(root, defineConfig({}), options, discovery(), provider)).state).toBe("ready");
    expect(calls.enable).toHaveLength(1);
    const saved = await readFile(join(root, ".loom/project.json"), "utf8");
    expect(saved).not.toContain(canary);
    expect((await loadProjectConfig(root)).publicConfiguration).toEqual({
      realtimeUrl: "https://realtime.example.test/br-test",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an expired wait reports pending and persists nothing", async () => {
  const root = await project();
  try {
    const { provider } = realtime([
      { enabled: false, pending: false },
      { enabled: true, pending: true },
    ]);
    const result = await enableRealtime(
      root,
      defineConfig({}),
      { allowedOrigins: origins, timeoutMs: 1 },
      discovery(),
      provider,
    );
    expect(result.state).toBe("pending");
    expect(result).not.toHaveProperty("realtimeUrl");
    await assert.rejects(readFile(join(root, ".loom/project.json")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("enable rejects unsafe origins, protected or default targets, conflicts, and missing compute", async () => {
  const root = await project();
  try {
    const config = defineConfig({});
    const ok = { allowedOrigins: origins, timeoutMs: 1 };
    for (const allowedOrigins of [
      [],
      ["*"],
      ["https://*"],
      ["https://*.example.com"],
      ["https://app.example.test/path"],
      ["ftp://app.example.test"],
    ]) {
      const { provider, calls } = realtime([{ enabled: false, pending: false }]);
      await assert.rejects(enableRealtime(root, config, { allowedOrigins, timeoutMs: 1 }, discovery(), provider), {
        code: "REALTIME_ORIGINS_INVALID",
      });
      expect(calls.enable).toEqual([]);
      expect(calls.get).toBe(0);
    }
    const protectedBranch = discovery({ id: "br-test", name: "dev", protected: true, isDefault: false });
    const defaultBranch = discovery({ id: "br-test", name: "dev", protected: false, isDefault: true });
    for (const target of [protectedBranch, defaultBranch]) {
      const { provider, calls } = realtime([{ enabled: false, pending: false }]);
      await assert.rejects(enableRealtime(root, config, ok, target, provider), { code: "REALTIME_TARGET_PROTECTED" });
      expect(calls.enable).toEqual([]);
      expect(
        (
          await enableRealtime(
            root,
            config,
            { ...ok, allowProtected: true },
            target,
            realtime([{ enabled: true, pending: false }]).provider,
          )
        ).state,
      ).toBe("ready");
    }
    await assert.rejects(
      enableRealtime(
        root,
        config,
        { ...ok, selection: { projectId: "project-other" } },
        discovery(),
        realtime([]).provider,
      ),
      { code: "PROJECT_CONFLICT" },
    );
    const missing = realtime([{ enabled: false, pending: false }], false);
    await assert.rejects(enableRealtime(root, config, ok, discovery(), missing.provider), {
      code: "REALTIME_COMPUTE_MISSING",
    });
    expect(missing.calls.enable).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("provider failures become fixed errors without provider text", async () => {
  const fail = (kind: string) => async () => {
    throw Object.assign(new Error(`provider said ${canary}`), { kind, status: kind === "auth" ? 403 : 500 });
  };
  const client = {
    realtime: { get: fail("auth"), enable: fail("api") },
    postgres: { endpoints: { listByBranch: fail("auth") } },
  };
  const provider = createRealtimeProvider(client);
  for (const [run, code] of [
    [() => provider.get("project-test", "br-test"), "REALTIME_DENIED"],
    [() => provider.hasCompute("project-test", "br-test"), "REALTIME_DENIED"],
    [
      () => provider.enable({ projectId: "project-test", branchId: "br-test", allowedOrigins: origins, timeoutMs: 1 }),
      "REALTIME_PROVIDER_FAILED",
    ],
  ] as const) {
    const error = await run().then(
      () => undefined,
      (cause: unknown) => cause,
    );
    assert(error instanceof RealtimeError);
    expect(error.code).toBe(code);
    expect(error.message).not.toContain(canary);
    expect(error.cause).toBeUndefined();
  }
});

test("realtime mutation refuses every disagreeing branch and database binding", async () => {
  const root = await project();
  const originalEnv = process.env.NEON_BRANCH_ID;
  try {
    const other = { id: "br-other", name: "other", protected: false, isDefault: false };
    const target = discovery();
    target.listBranches = async () => [{ id: "br-test", name: "dev", protected: false, isDefault: false }, other];
    target.listBranchDatabases = async (_projectId, branchId) => [
      { name: "neondb", branchId, ownerName: "neondb_owner" },
      { name: "otherdb", branchId, ownerName: "neondb_owner" },
    ];
    const database = { migrationRole: "neondb_owner", runtimeRole: "loom_runtime" };
    const deployment = { ...database, environment: "preview" as const, deployment: "preview" };
    const cases = [
      { config: { branchId: "br-other" } },
      { selection: { branch: "other" } },
      { env: "br-other" },
      { link: { branch: "dev", branchId: "br-other" } },
      { config: { branchId: "missing" } },
      {
        config: {
          development: { ...database, databaseName: "neondb" },
          deployment: { ...deployment, databaseName: "otherdb" },
        },
      },
      { config: { deployment: { ...deployment, databaseName: "neondb" } }, selection: { databaseName: "otherdb" } },
    ];
    for (const entry of cases) {
      delete process.env.NEON_BRANCH_ID;
      if (entry.env) process.env.NEON_BRANCH_ID = entry.env;
      await writeFile(
        join(root, ".neon"),
        JSON.stringify({ projectId: "project-test", ...(entry.link ?? { branch: "dev" }) }),
      );
      const { provider, calls } = realtime([{ enabled: false, pending: false }]);
      provider.get = async () => {
        calls.get++;
        return {
          enabled: true,
          pending: false,
          invocationUrl: "https://realtime.example.test",
          allowedOrigins: origins,
        };
      };
      await assert.rejects(
        enableRealtime(
          root,
          defineConfig(entry.config ?? {}),
          {
            allowedOrigins: origins,
            timeoutMs: 1,
            selection: entry.selection ?? {},
          },
          target,
          provider,
        ),
      );
      expect(calls.get).toBe(0);
      expect(calls.enable).toEqual([]);
    }
  } finally {
    if (originalEnv === undefined) delete process.env.NEON_BRANCH_ID;
    else process.env.NEON_BRANCH_ID = originalEnv;
    await rm(root, { recursive: true, force: true });
  }
});

test("branch name and ID aliases agree at the mutation boundary", async () => {
  const root = await project();
  try {
    await writeFile(
      join(root, ".neon"),
      JSON.stringify({ projectId: "project-test", branch: "dev", branchId: "br-test" }),
    );
    const { provider } = realtime([{ enabled: true, pending: false }]);
    expect(
      (
        await enableRealtime(
          root,
          defineConfig({ branchId: "br-test" }),
          {
            allowedOrigins: origins,
            timeoutMs: 1,
            selection: { branch: "dev" },
          },
          discovery(),
          provider,
        )
      ).state,
    ).toBe("ready");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ready with different observed origins refuses success and persistence", async () => {
  const root = await project();
  try {
    const { provider, calls } = realtime([{ enabled: true, pending: false }]);
    await assert.rejects(
      enableRealtime(
        root,
        defineConfig({}),
        {
          allowedOrigins: ["https://new.example.test"],
          timeoutMs: 1,
        },
        discovery(),
        provider,
      ),
      { code: "REALTIME_ORIGINS_CONFLICT" },
    );
    expect(calls.enable).toHaveLength(1);
    await assert.rejects(readFile(join(root, ".loom/project.json")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("actual status command leaves authored project unchanged on config failure", async () => {
  const root = await project();
  try {
    await writeFile(join(root, "kello.config.ts"), "export default { projectId: 42 };\n");
    const before = (await readdir(root, { recursive: true })).sort();
    await assert.rejects(realtimeStatusCommand(root, true));
    expect((await readdir(root, { recursive: true })).sort()).toEqual(before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("actual status command loads authored imports without project writes on success or provider failure", async () => {
  const root = await project();
  try {
    await mkdir(join(root, "node_modules"));
    await symlink(join(import.meta.dir, "../node_modules/valibot"), join(root, "node_modules/valibot"));
    await writeFile(
      join(root, "settings.ts"),
      'import { basename } from "node:path"; import { parse, string } from "valibot"; export default { branchId: parse(string(), basename("/br-test")) };\n',
    );
    await writeFile(join(root, "kello.config.ts"), 'export { default } from "./settings";\n');
    const before = (await readdir(root, { recursive: true })).sort();
    const { provider, calls } = realtime([{ enabled: false, pending: false }]);
    expect(await realtimeStatusCommand(root, true, { discovery: discovery(), realtime: provider })).toBe(0);
    expect(calls.get).toBe(1);
    expect(calls.enable).toEqual([]);
    expect((await readdir(root, { recursive: true })).sort()).toEqual(before);
    provider.get = async () => {
      throw new RealtimeError("REALTIME_DENIED", "Access denied.");
    };
    await assert.rejects(realtimeStatusCommand(root, true, { discovery: discovery(), realtime: provider }), {
      code: "REALTIME_DENIED",
    });
    expect((await readdir(root, { recursive: true })).sort()).toEqual(before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("saved branch and database bindings cannot be silently replaced", async () => {
  const root = await project();
  try {
    const initial = realtime([{ enabled: true, pending: false }]);
    await enableRealtime(
      root,
      defineConfig({}),
      { allowedOrigins: origins, timeoutMs: 1 },
      discovery(),
      initial.provider,
    );
    const saved = await readFile(join(root, ".loom/project.json"), "utf8");
    const target = discovery();
    target.listBranches = async () => [
      { id: "br-test", name: "dev", protected: false, isDefault: false },
      { id: "br-other", name: "other", protected: false, isDefault: false },
    ];
    target.listBranchDatabases = async (_projectId, branchId) => [
      { name: "neondb", branchId, ownerName: "neondb_owner" },
      { name: "otherdb", branchId, ownerName: "neondb_owner" },
    ];
    await writeFile(join(root, ".neon"), JSON.stringify({ projectId: "project-test" }));
    for (const selection of [{ branch: "other" }, { databaseName: "otherdb" }]) {
      const { provider, calls } = realtime([]);
      await assert.rejects(
        enableRealtime(root, defineConfig({}), { allowedOrigins: origins, timeoutMs: 1, selection }, target, provider),
        { code: "PROJECT_CONFLICT" },
      );
      expect(calls.get).toBe(0);
      expect(calls.enable).toEqual([]);
      expect(await readFile(join(root, ".loom/project.json"), "utf8")).toBe(saved);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ambiguous branch aliases are refused before realtime provider calls", async () => {
  const root = await project();
  try {
    const target = discovery();
    target.listBranches = async () => [
      { id: "br-test", name: "dev", protected: false, isDefault: false },
      { id: "dev", name: "other", protected: false, isDefault: false },
    ];
    const { provider, calls } = realtime([]);
    await assert.rejects(
      enableRealtime(
        root,
        defineConfig({ branchId: "br-test" }),
        { allowedOrigins: origins, timeoutMs: 1 },
        target,
        provider,
      ),
      { code: "BRANCH_AMBIGUOUS" },
    );
    expect(calls.get).toBe(0);
    expect(calls.enable).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("observed origins compare as normalized sets", async () => {
  const root = await project();
  try {
    const { provider, calls } = realtime([]);
    provider.get = async () => ({
      enabled: true,
      pending: false,
      invocationUrl: "https://realtime.example.test",
      allowedOrigins: [origins[0]! + "/", origins[0]!],
    });
    expect(
      (await enableRealtime(root, defineConfig({}), { allowedOrigins: origins, timeoutMs: 1 }, discovery(), provider))
        .state,
    ).toBe("ready");
    expect(calls.enable).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SDK wait timeout resolves for reread while request timeout remains a fixed failure", async () => {
  // Resolve the SDK from its owning package; the e2e workspace does not declare it directly.
  const sdk = await import(Bun.resolveSync("@neon/sdk", join(import.meta.dir, "../../../apps/kello")));
  const wait = new sdk.NeonWaitTimeoutError(canary, { timeoutMs: 1, operations: [] });
  const request = new sdk.NeonRequestTimeoutError(canary, { timeoutMs: 1 });
  for (const cause of [wait, request]) {
    const provider = createRealtimeProvider({
      realtime: {
        get: async () => ({ enabled: false, pending: false }),
        enable: async (_params, options) => {
          expect(options).toEqual({ waitForReadiness: true, wait: { timeoutMs: 123 } });
          throw cause;
        },
      },
      postgres: { endpoints: { listByBranch: async () => [] } },
    });
    const result = provider.enable({
      projectId: "project-test",
      branchId: "br-test",
      allowedOrigins: origins,
      timeoutMs: 123,
    });
    if (cause === wait) await result;
    else
      await assert.rejects(result, {
        code: "REALTIME_PROVIDER_FAILED",
        message: "Neon Realtime request failed. Check `kello realtime status` before retrying.",
      });
  }
});
