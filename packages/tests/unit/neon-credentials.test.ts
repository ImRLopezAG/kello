import { expect, test } from "vite-plus/test";
import { resolveBranchCredentials } from "../../../apps/kello-cli/src/tooling/deploy/neon/credentials";

const target = { projectId: "project", branchId: "br-developer", endpointId: "ep-developer" };

test("schema provisioning credentials bind the direct endpoint, role and database without pg identity overrides", async () => {
  for (const uri of [
    "postgresql://other:secret@ep-developer.example/neondb",
    "postgresql://migrator:secret@ep-developer.example/other",
    "postgresql://migrator:secret@ep-developer-pooler.example/neondb",
    ...["host", "hostaddr", "port", "user", "password", "database", "dbname", "options", "connectionString"].map(
      (key) => `postgresql://migrator:secret@ep-developer.example/neondb?${key}=override`,
    ),
    "postgresql://migrator:secret@ep-other.example/neondb",
    "secret-invalid-uri",
    "postgresql://migrator:secret@ep-developer.example/%zz",
  ]) {
    await expect(
      resolveBranchCredentials({ getConnectionUri: async () => ({ uri }) }, target, "neondb", "migrator"),
    ).rejects.toThrow("Provider connection does not match the development target");
  }
  const uri = "postgresql://migrator:secret@ep-developer.example:5433/neondb?sslmode=require";
  const calls: unknown[] = [];
  expect(
    await resolveBranchCredentials(
      {
        getConnectionUri: async (...args) => {
          calls.push(args);
          return { uri };
        },
      },
      target,
      "neondb",
      "migrator",
    ),
  ).toEqual({
    connectionString: uri,
    database: { endpointHost: "ep-developer.example", databaseName: "neondb", port: "5433" },
  });
  expect(calls).toEqual([
    [
      "project",
      {
        branchId: "br-developer",
        endpointId: "ep-developer",
        databaseName: "neondb",
        roleName: "migrator",
        pooled: false,
      },
    ],
  ]);
});

test("schema provisioning credential lookup errors redact provider secrets", async () => {
  await expect(
    resolveBranchCredentials(
      {
        getConnectionUri: async () => {
          throw new Error("postgresql://migrator:provider-secret@ep-developer.example/neondb");
        },
      },
      target,
      "neondb",
      "migrator",
    ),
  ).rejects.toThrow(/^Could not resolve development connection$/);
});
