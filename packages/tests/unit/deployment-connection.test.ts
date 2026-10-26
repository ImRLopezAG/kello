import { expect, test } from "vite-plus/test";
import { defineConfig, withDeploymentConnection, prepareDeploymentActivation } from "kello-cli";
import type { DeploymentDatabaseProvider } from "kello-cli";

const config = defineConfig({
  project: "tasks",
  provider: { projectId: "project", targets: { preview: { branchId: "br-preview" } } },
});
test("deployment connection rejects identity overrides before opening a database session", async () => {
  const options = { config, environment: "preview" as const, databaseName: "neondb", migrationRole: "migrator" };
  for (const uri of [
    "not a URL secret-token",
    "postgres://other:secret@ep-preview.example/neondb",
    "postgres://migrator:secret@ep-preview.example/other",
    "postgres://migrator:secret@ep-preview-pooler.example/neondb",
    "postgres://migrator:secret@other.example/neondb",
    "postgres://migrator:secret@ep-preview.example/neondb?host=other",
    "postgres://migrator:secret@ep-preview.example/neondb?user=other",
    "postgres://migrator:secret@ep-preview.example/neondb?options=-csearch_path=other",
  ]) {
    const provider: DeploymentDatabaseProvider = {
      getProject: async () => ({ id: "project", name: "tasks", regionId: "aws-us-east-2", pgVersion: 18 }),
      listBranches: async () => [{ id: "br-preview", name: "preview", protected: false, isDefault: false }],
      listEndpoints: async () => [
        {
          id: "ep-preview",
          branchId: "br-preview",
          type: "read_write",
          autoscalingLimitMinCu: 0.25,
          autoscalingLimitMaxCu: 1,
          suspendTimeout: 300,
        },
      ],
      getConnectionUri: async (projectId, request) => {
        expect(projectId).toBe("project");
        expect(request).toEqual({
          branchId: "br-preview",
          endpointId: "ep-preview",
          databaseName: "neondb",
          roleName: "migrator",
          pooled: false,
        });
        return { uri };
      },
    };
    let ran = false;
    await expect(
      withDeploymentConnection(
        options,
        async () => {
          ran = true;
        },
        provider,
      ),
    ).rejects.toThrow("Provider connection does not match the deployment target");
    expect(ran).toBe(false);
  }
});

test("activation tokens require exactly 32 bytes of lowercase hex before provider access", async () => {
  for (const activationToken of ["", "a".repeat(63), "a".repeat(64) + "\n", "A".repeat(64)]) {
    await expect(
      prepareDeploymentActivation({
        config,
        environment: "preview",
        databaseName: "neondb",
        migrationRole: "migrator",
        deployment: "preview",
        version: "b".repeat(64),
        activationToken,
      }),
    ).rejects.toThrow("Invalid deployment activation input");
  }
});
