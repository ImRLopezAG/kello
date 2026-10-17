import { beforeEach, expect, test, vi } from "vite-plus/test";
import type { DeploymentDatabaseProvider } from "../../../apps/kello/src/tooling/deploy/neon/connection";
import type { NeonReleasePreparationOptions } from "../../../apps/kello/src/tooling/deploy/neon/prepare-release";

interface RecordingClient {
  query(text: string): Promise<{ rows: { token: string; runtime_role: string }[] }>;
}

const version = "a".repeat(64);
interface State {
  endpoints: string[];
  branch: string;
  queries: string[];
  bootstraps: number;
  uris: number;
  releases: number;
  releaseInput: NeonReleasePreparationOptions | undefined;
}
const state = vi.hoisted(() => {
  const initial: State = {
    endpoints: [],
    branch: "br-preview",
    queries: [],
    bootstraps: 0,
    uris: 0,
    releases: 0,
    releaseInput: undefined,
  };
  return initial;
});
vi.mock("../../../apps/kello/src/tooling/project/load", async () => {
  const { defineConfig } = await import("../../../apps/kello/src/tooling/config/define-config");
  return {
    async loadProject() {
      return {
        root: "/project",
        version,
        components: [],
        application: undefined,
        config: defineConfig({
          project: "tasks",
          provider: { projectId: "project", targets: { preview: { branchId: state.branch } } },
          deployment: {
            environment: "preview",
            deployment: "preview",
            databaseName: "neondb",
            migrationRole: "migrator",
            runtimeRole: "loom_runtime",
            componentScopes: [],
          },
        }),
      };
    },
  };
});
vi.mock("../../../apps/kello/src/tooling/migrations/history", () => ({
  async readMigrations() {
    return [{ plan: { hash: "b".repeat(64), after: "c".repeat(64) } }];
  },
}));
vi.mock("../../../apps/kello/src/tooling/migrations/connection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../apps/kello/src/tooling/migrations/connection")>()),
  async withMigrationConnection<T>(_uri: string, operation: (client: RecordingClient) => Promise<T>): Promise<T> {
    return operation({
      async query(text: string) {
        state.queries.push(text);
        return { rows: [{ token: "d".repeat(64), runtime_role: "loom_runtime" }] };
      },
    });
  },
  async acquireMigrationLock() {},
}));
vi.mock("../../../apps/kello/src/tooling/migrations/bootstrap", () => ({
  async bootstrapSession() {
    state.bootstraps++;
  },
}));
vi.mock("../../../apps/kello/src/tooling/deploy/neon/release", () => ({
  async deployNeonRelease(_root: string, input: NeonReleasePreparationOptions) {
    state.releases++;
    state.releaseInput = input;
    throw new Error("release reached");
  },
}));
import { deployProjectRelease } from "../../../apps/kello/src/tooling/deploy/neon/project";
import { withDeploymentConnection } from "../../../apps/kello/src/tooling/deploy/neon/connection";

let endpoint = "ep-preview";
const databaseProvider: DeploymentDatabaseProvider = {
  getProject: async () => ({ id: "project", name: "tasks", regionId: "aws-us-east-2", pgVersion: 18 }),
  listBranches: async () => [
    { id: "br-preview", name: "preview", protected: false, isDefault: false },
    { id: "br-other", name: "other", protected: false, isDefault: false },
  ],
  // Each inspection consumes the next writable endpoint, modelling a provider change between checks.
  listEndpoints: async () => {
    endpoint = (state.endpoints.length > 1 ? state.endpoints.shift() : state.endpoints[0]) ?? endpoint;
    const writable = {
      type: "read_write",
      autoscalingLimitMinCu: 0.25,
      autoscalingLimitMaxCu: 1,
      suspendTimeout: 300,
    } as const;
    return [
      { ...writable, id: endpoint, branchId: "br-preview" },
      { ...writable, id: "ep-other", branchId: "br-other" },
    ];
  },
  getConnectionUri: async (_project, request) => {
    state.uris++;
    return { uri: `postgres://${request.roleName}:secret@${request.endpointId}.example/neondb` };
  },
};
// SAFETY: with deployNeonRelease mocked, the release path calls only the target and connection methods implemented above.
const provider = databaseProvider as Parameters<typeof deployProjectRelease>[2];
const expected = {
  version,
  projectId: "project",
  branchId: "br-preview",
  endpointId: "ep-preview",
  databaseName: "neondb",
  migrationRole: "migrator",
  runtimeRole: "loom_runtime",
  deployment: "preview",
};
beforeEach(() => {
  delete process.env.LOOM_DATABASE_URL;
  delete process.env.LOOM_ACTIVATION_TOKEN;
  state.endpoints = ["ep-preview"];
  state.branch = "br-preview";
  state.queries = [];
  state.bootstraps = state.uris = state.releases = 0;
});
function writes() {
  return { queries: state.queries, bootstraps: state.bootstraps, releases: state.releases };
}

test("the pinned authority reaches managed credential writes and the release", async () => {
  const { loadProject } = await import("../../../apps/kello/src/tooling/project/load");
  const { config } = await loadProject("/project");
  const pinned = {
    ...expected,
    namespace: config.database.namespace,
    metadataNamespace: config.database.metadataNamespace,
  };
  await expect(deployProjectRelease("/project", "kello.config.ts", provider, undefined, pinned)).rejects.toThrow(
    "release reached",
  );
  expect(state.bootstraps).toBe(1);
  expect(state.releases).toBe(1);
  const { version: _version, ...target } = pinned;
  // The release's own database connection receives the same pinned authority.
  expect(state.releaseInput).toMatchObject({ version, expectedTarget: target });
});

for (const change of [
  "endpoint before credentials",
  "endpoint after the lock",
  "linked branch",
  "version",
  "databaseName",
  "migrationRole",
  "runtimeRole",
  "namespace",
  "metadataNamespace",
  "deployment",
] as const)
  test(`a changed ${change} after development preflight rejects with zero privileged writes`, async () => {
    const { loadProject } = await import("../../../apps/kello/src/tooling/project/load");
    const { config } = await loadProject("/project");
    let pinned = {
      ...expected,
      namespace: config.database.namespace,
      metadataNamespace: config.database.metadataNamespace,
    };
    if (change === "endpoint before credentials") state.endpoints = ["ep-changed"];
    if (change === "endpoint after the lock") state.endpoints = ["ep-preview", "ep-changed"];
    if (change === "linked branch") state.branch = "br-other";
    if (change === "version") pinned = { ...pinned, version: "e".repeat(64) };
    if (
      ["databaseName", "migrationRole", "runtimeRole", "namespace", "metadataNamespace", "deployment"].includes(change)
    )
      pinned = { ...pinned, [change]: "pinned_other" };
    await expect(deployProjectRelease("/project", "kello.config.ts", provider, undefined, pinned)).rejects.toThrow(
      change === "endpoint after the lock" ? /while acquiring the lock/ : /selected preview target/,
    );
    expect(writes()).toEqual({ queries: [], bootstraps: 0, releases: 0 });
  });

test("the release's own deployment connection refuses a target differing from the pinned authority", async () => {
  const { loadProject } = await import("../../../apps/kello/src/tooling/project/load");
  const { config } = await loadProject("/project");
  const { version: _version, ...pinned } = {
    ...expected,
    namespace: config.database.namespace,
    metadataNamespace: config.database.metadataNamespace,
  };
  const options = { config, environment: "preview" as const, databaseName: "neondb", migrationRole: "migrator" };
  state.endpoints = ["ep-changed"];
  await expect(
    withDeploymentConnection({ ...options, expectedTarget: pinned }, async () => {}, databaseProvider),
  ).rejects.toThrow("selected preview target");
  state.endpoints = ["ep-preview"];
  await expect(
    withDeploymentConnection(
      { ...options, expectedTarget: { ...pinned, namespace: "other" } },
      async () => {},
      provider,
    ),
  ).rejects.toThrow("selected preview target");
  expect(state.uris).toBe(0);
  let ran = false;
  await withDeploymentConnection(
    { ...options, expectedTarget: pinned },
    async () => {
      ran = true;
    },
    provider,
  );
  expect(ran).toBe(true);
});
