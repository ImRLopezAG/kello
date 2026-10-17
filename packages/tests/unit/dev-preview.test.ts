import { getEventListeners } from "node:events";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const watchState = vi.hoisted(() => ({ opened: 0, closed: 0 }));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    watch: (...args: Parameters<typeof fs.watch>) => {
      watchState.opened++;
      const watcher = fs.watch(...args);
      watcher.once("close", () => {
        watchState.closed++;
      });
      return watcher;
    },
  };
});

interface DeployCall {
  readonly version: string;
  readonly file: string;
  readonly signal: AbortSignal | undefined;
}
interface ExpectedRelease {
  readonly version: string;
  readonly endpointId: string;
}
interface DeployReceipt {
  readonly identity: { readonly version: string; readonly target: { readonly branchId: string } };
}
type Deploy = (root: string, file: string, signal?: AbortSignal) => Promise<DeployReceipt>;
interface State {
  version: string;
  generateFailure: Error | null;
  environment: string;
  linkedBranch: string;
  targetProject: string;
  targetBranch: string;
  targetEndpoint: string;
  databaseName: string;
  migrationRole: string;
  runtimeRole: string;
  targetFailure: Error | null;
  targetLookup?: () => Promise<void>;
  deploy: Deploy;
  deploys: DeployCall[];
  expected: (ExpectedRelease | undefined)[];
  writes: string[];
}
const state = vi.hoisted(() => {
  const initial: State = {
    version: "v1",
    generateFailure: null,
    environment: "preview",
    linkedBranch: "br-preview",
    targetProject: "p-1",
    targetBranch: "br-preview",
    targetEndpoint: "ep-preview",
    databaseName: "app",
    migrationRole: "migrator",
    runtimeRole: "runtime",
    targetFailure: null,
    deploy: async () => ({ identity: { version: "v1", target: { branchId: "br-preview" } } }),
    deploys: [],
    expected: [],
    writes: [],
  };
  return initial;
});
vi.mock("../../../apps/kello/src/tooling/codegen/generate", () => ({
  async generateProject() {
    if (state.generateFailure) throw state.generateFailure;
    return { version: state.version };
  },
  async assertGeneratedVersion() {},
  async publishProjectConfiguration() {
    state.writes.push("generated");
  },
}));
vi.mock("../../../apps/kello/src/tooling/deploy/neon/project", () => ({
  async readProjectRelease() {
    return {
      project: { config: { linked: true, database: { namespace: "app", metadataNamespace: "meta" } } },
      declaration: {
        environment: state.environment,
        databaseName: state.databaseName,
        migrationRole: state.migrationRole,
        runtimeRole: state.runtimeRole,
        deployment: "app",
      },
    };
  },
  deployProjectRelease: (
    root: string,
    file: string,
    _provider: undefined,
    signal?: AbortSignal,
    expected?: ExpectedRelease,
  ) => {
    state.expected.push(expected);
    return state.deploy(root, file, signal);
  },
}));
vi.mock("../../../apps/kello/src/tooling/deploy/neon/target", () => ({
  async inspectDeploymentTarget(_config: { readonly linked: boolean }, environment: string) {
    if (environment !== "preview") throw new Error("development requires preview");
    await state.targetLookup?.();
    if (state.targetFailure) throw state.targetFailure;
    return {
      environment,
      projectId: state.targetProject,
      branchId: state.targetBranch,
      endpointId: state.targetEndpoint,
      protected: false,
    };
  },
}));
vi.mock("../../../apps/kello/src/tooling/config/resolve", () => ({
  async readResolvedProject() {
    return {
      projectId: state.targetProject,
      branchId: state.linkedBranch,
      public: { serviceUrl: "https://service.example.test/" },
    };
  },
  async resolveNeonProject() {
    return { public: { serviceUrl: "https://service.example.test/" } };
  },
  async saveResolvedProject() {
    state.writes.push("project.json");
  },
}));
vi.mock("../../../apps/kello/src/tooling/config/environment-file", () => ({
  async writeManagedPublicEnvironment() {
    state.writes.push(".env.local");
  },
}));
vi.mock("../../../apps/kello/src/tooling/project/load", () => ({
  async loadProjectConfig() {
    return { config: { development: { debounceMs: 20 } } };
  },
}));
import { startProjectDevelopment } from "../../../apps/kello/src/tooling/dev/project";
import { publishDeployedClient } from "../../../apps/kello/src/tooling/deploy/neon/publish-client";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "kello-dev-preview-"));
  state.version = "v1";
  state.generateFailure = null;
  state.environment = "preview";
  state.linkedBranch = "br-preview";
  state.targetProject = "p-1";
  state.targetBranch = "br-preview";
  state.targetEndpoint = "ep-preview";
  state.databaseName = "app";
  state.migrationRole = "migrator";
  state.runtimeRole = "runtime";
  state.targetFailure = null;
  delete state.targetLookup;
  state.deploys = [];
  state.expected = [];
  state.writes = [];
  // Mirrors ordinary publication: a successful release rewrites .env.local in the watched root.
  state.deploy = async (deployRoot, file, signal) => {
    state.deploys.push({ version: state.version, file, signal });
    await writeFile(join(deployRoot, ".env.local"), `LOOM_URL="https://service.example.test/"\n`);
    return { identity: { version: state.version, target: { branchId: "br-preview" } } };
  };
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function save(name = "source.ts") {
  await writeFile(join(root, name), String(Math.random()));
}
async function idle(development: { flush(): Promise<void> }) {
  for (let attempt = 0; attempt < 5; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 60));
    await development.flush();
  }
}

test("a save deploys once to the linked preview and later saves update the same target", async () => {
  const development = await startProjectDevelopment(root, "kello.config.ts");
  try {
    await idle(development);
    expect(state.deploys.map((entry) => entry.version)).toEqual(["v1"]);
    expect(development.active?.version).toBe("v1");
    expect(development.url?.href).toBe("https://service.example.test/");
    // The .env.local publication event and unchanged saves leave the source version unchanged.
    await save();
    await idle(development);
    expect(state.deploys).toHaveLength(1);
    state.version = "v2";
    await save();
    await idle(development);
    expect(state.deploys.map((entry) => [entry.version, entry.file])).toEqual([
      ["v1", "kello.config.ts"],
      ["v2", "kello.config.ts"],
    ]);
    expect(development.active?.version).toBe("v2");
    // Each release is bound to the generated candidate and the session's pinned endpoint.
    expect(state.expected).toMatchObject([
      { version: "v1", endpointId: "ep-preview" },
      { version: "v2", endpointId: "ep-preview" },
    ]);
  } finally {
    await development.stop();
  }
});

test("owned .env.local publication events while publication is pending do not cancel it", async () => {
  const { writeManagedPublicEnvironment } = await vi.importActual<
    typeof import("../../../apps/kello/src/tooling/config/environment-file")
  >("../../../apps/kello/src/tooling/config/environment-file");
  state.deploy = async (deployRoot, file, signal) => {
    state.deploys.push({ version: state.version, file, signal });
    // Real publication writer: root ..env.local-<uuid>.tmp then rename to .env.local.
    await writeManagedPublicEnvironment(deployRoot, {
      LOOM_URL: `https://service.example.test/${state.deploys.length}`,
    });
    // Publication remains pending well past the debounce while its events are delivered.
    await new Promise((resolve) => setTimeout(resolve, 200));
    signal?.throwIfAborted();
    state.writes.push("published");
    return { identity: { version: state.version, target: { branchId: "br-preview" } } };
  };
  const development = await startProjectDevelopment(root, "kello.config.ts");
  try {
    await idle(development);
    await idle(development);
    expect(state.deploys.map((entry) => entry.signal?.aborted)).toEqual([false]);
    expect(state.writes).toEqual(["published"]);
    expect(development.active?.version).toBe("v1");
    expect(development.failure).toBeNull();
    // A real source edit still cancels a pending publication.
    state.version = "v2";
    state.deploy = async (_root, file, signal) => {
      state.deploys.push({ version: state.version, file, signal });
      await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
      throw signal?.reason;
    };
    await save();
    await vi.waitFor(() => expect(state.deploys).toHaveLength(2));
    await save("other.ts");
    await vi.waitFor(() => expect(state.deploys[1]?.signal?.aborted).toBe(true));
  } finally {
    await development.stop();
  }
});

test("saves during a running release coalesce into one serialized successor", async () => {
  let release = () => {};
  const blocked = new Promise<void>((resolve) => (release = resolve));
  let running = 0;
  let maximum = 0;
  const ordinary = state.deploy;
  state.deploy = async (deployRoot, file, signal) => {
    running++;
    maximum = Math.max(maximum, running);
    try {
      if (state.deploys.length === 0) {
        state.deploys.push({ version: state.version, file, signal });
        await blocked;
        signal?.throwIfAborted();
        return { identity: { version: "v1", target: { branchId: "br-preview" } } };
      }
      return await ordinary(deployRoot, file, signal);
    } finally {
      running--;
    }
  };
  const development = await startProjectDevelopment(root, "kello.config.ts");
  try {
    while (state.deploys.length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
    state.version = "v2";
    await save("a.ts");
    await save("b.ts");
    await save("c.ts");
    await new Promise((resolve) => setTimeout(resolve, 100));
    release();
    await idle(development);
    expect(state.deploys.map((entry) => entry.version)).toEqual(["v1", "v2"]);
    expect(state.deploys[0]?.signal?.aborted).toBe(true);
    expect(maximum).toBe(1);
    expect(development.active?.version).toBe("v2");
  } finally {
    await development.stop();
  }
});

test("a failed edit keeps the last usable release and the next save recovers", async () => {
  const development = await startProjectDevelopment(root, "kello.config.ts");
  try {
    await idle(development);
    state.generateFailure = new Error("build failed");
    state.version = "v2";
    await save();
    await idle(development);
    expect(development.failure).not.toBeNull();
    expect(development.active?.version).toBe("v1");
    expect(state.deploys).toHaveLength(1);
    state.generateFailure = null;
    state.version = "v3";
    await save();
    await idle(development);
    expect(development.failure).toBeNull();
    expect(state.deploys.map((entry) => entry.version)).toEqual(["v1", "v3"]);
  } finally {
    await development.stop();
  }
});

test("protected, default, production and mismatched preview targets are refused before release", async () => {
  state.targetFailure = new Error("Preview deployment refuses protected or default branches");
  await expect(startProjectDevelopment(root, "kello.config.ts")).rejects.toThrow("protected");
  state.targetFailure = null;
  state.environment = "production";
  await expect(startProjectDevelopment(root, "kello.config.ts")).rejects.toThrow(/preview/);
  state.environment = "preview";
  state.linkedBranch = "br-other";
  await expect(startProjectDevelopment(root, "kello.config.ts")).rejects.toThrow(/linked/);
  expect(state.deploys).toEqual([]);
});

test("cancellation before setup starts no release and never loads a local backend", async () => {
  await expect(startProjectDevelopment(root, "kello.config.ts", undefined, AbortSignal.abort())).rejects.toThrow();
  expect(state.deploys).toEqual([]);
});

test("stop during a release aborts it and awaits its cleanup without teardown", async () => {
  let cleaned = false;
  state.deploy = async (_root, file, signal) => {
    state.deploys.push({ version: state.version, file, signal });
    await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    cleaned = true;
    throw signal?.reason;
  };
  const development = await startProjectDevelopment(root, "kello.config.ts");
  while (state.deploys.length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
  await development.stop();
  expect(state.deploys[0]?.signal?.aborted).toBe(true);
  expect(cleaned).toBe(true);
  expect(development.active).toBeNull();
  expect(development.failure).toBeNull();
});

test("a cancelled revision cannot publish public client coordinates", async () => {
  const release = { projectId: "p-1", branchId: "br-preview", version: "v1", serviceSlug: "s1" };
  await expect(publishDeployedClient(root, release, undefined, AbortSignal.abort())).rejects.toThrow();
  expect(state.writes).toEqual([]);
  await publishDeployedClient(root, release);
  expect(state.writes).toEqual(["project.json", ".env.local", "generated"]);
});

test("abort during deferred preview lookup creates no watcher or release and leaves no listener", async () => {
  const entered = Promise.withResolvers<void>();
  const lookup = Promise.withResolvers<void>();
  state.targetLookup = async () => {
    entered.resolve();
    await lookup.promise;
  };
  const controller = new AbortController();
  const opened = watchState.opened;
  const starting = startProjectDevelopment(root, "kello.config.ts", undefined, controller.signal);
  await entered.promise;
  controller.abort();
  lookup.resolve();
  await expect(starting).rejects.toThrow();
  expect(watchState.opened).toBe(opened);
  expect(state.deploys).toEqual([]);
  expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
});

test("external abort after watcher setup prevents initial release and removes its listener", async () => {
  const controller = new AbortController();
  const development = await startProjectDevelopment(root, "kello.config.ts", undefined, controller.signal);
  try {
    controller.abort();
    await development.flush();
    await vi.waitFor(() => expect(watchState.closed).toBe(watchState.opened));
    expect(state.deploys).toEqual([]);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  } finally {
    await development.stop();
  }
});

for (const change of ["linked target", "targetEndpoint", "databaseName", "migrationRole", "runtimeRole"] as const) {
  test(`watching refuses changed ${change} before releasing and retains the selected preview`, async () => {
    const development = await startProjectDevelopment(root, "kello.config.ts");
    try {
      await idle(development);
      expect(state.deploys).toHaveLength(1);
      if (change === "linked target") {
        // Both config and the saved link agree on a new project/branch: still forbidden in this watch session.
        state.targetProject = "p-other";
        state.targetBranch = state.linkedBranch = "br-other";
      } else state[change] = "changed";
      state.version = "v2";
      await save();
      await idle(development);
      expect(state.deploys).toHaveLength(1);
      expect(development.failure).toMatchObject({
        error: { cause: { message: expect.stringMatching(/selected preview target/) } },
      });
      expect(development.active).toEqual({ version: "v1", branchId: "br-preview" });
    } finally {
      await development.stop();
    }
  });
}

test("an abort-triggered stop surfaces a rejecting release cleanup without an unobserved rejection", async () => {
  state.deploy = async (_root, file, signal) => {
    state.deploys.push({ version: state.version, file, signal });
    await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    throw new Error("receipt lock removal failed");
  };
  const controller = new AbortController();
  const development = await startProjectDevelopment(root, "kello.config.ts", undefined, controller.signal);
  while (state.deploys.length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort();
  await new Promise((resolve) => setTimeout(resolve, 60));
  await expect(development.stop()).rejects.toMatchObject({ cause: { message: "receipt lock removal failed" } });
  expect(development.active).toBeNull();
});
