import { expect, test } from "vite-plus/test";
import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, resolveProjectPath } from "kello-cli";

test("configuration has bounded defaults and rejects unknown settings and protected namespaces", () => {
  expect(defineConfig({ project: "tasks" }).database.postgresVersion).toBe(18);
  expect(defineConfig({ project: "tasks" }).database.migrations).toBe("kello/_generated/migrations");
  expect(defineConfig({ project: "tasks", backend: "backend" }).database.migrations).toBe(
    "backend/_generated/migrations",
  );
  expect(defineConfig({ project: "tasks", database: { migrations: "history" } }).database.migrations).toBe("history");
  expect(defineConfig({ project: "tasks" })).not.toHaveProperty("realtime");
  expect(() => defineConfig({ project: "tasks", database: { namespace: "pg_catalog" } })).toThrow();
  expect(() => defineConfig({ database: { namespace: "uuid-ossp" } })).toThrow();
  expect(() =>
    defineConfig({ project: "tasks", database: { runtimeUrlEnv: "DATABASE_URL", migrationUrlEnv: "DATABASE_URL" } }),
  ).toThrow("separate");
  const config = { project: "tasks" };
  Object.defineProperty(config, "unexpected", { value: true, enumerable: true });
  expect(() => defineConfig(config)).toThrow();
});

test("job configuration matches queue limits and requires exact second conversion", () => {
  expect(defineConfig({ project: "tasks" }).jobs.maxAttempts).toBe(10);
  expect(
    defineConfig({ project: "tasks", jobs: { maxAttempts: 2, leaseMs: 300000, retryBaseMs: 0 } }).jobs,
  ).toMatchObject({ maxAttempts: 2, leaseMs: 300000, retryBaseMs: 0 });
  for (const jobs of [
    { maxAttempts: 11 },
    { leaseMs: 301000 },
    { leaseMs: 1001 },
    { retryBaseMs: 100 },
    { retryBaseMs: 3600001 },
  ])
    expect(() => defineConfig({ project: "tasks", jobs })).toThrow();
});

test("authentication configuration requires explicit safe JWKS and canonical origins", () => {
  const issuer = { issuer: "https://identity.example.test", jwksUrl: "https://identity.example.test/jwks" };
  expect(defineConfig({ project: "tasks", auth: { issuers: [issuer], audience: "kello" } }).auth.issuers).toEqual([
    issuer,
  ]);
  for (const auth of [
    { issuers: [{ ...issuer, jwksUrl: "http://identity.example.test/jwks" }] },
    { issuers: [{ ...issuer, issuer: "https://user:password@identity.example.test" }] },
    { issuers: [issuer, issuer] },
    { audience: "" },
    { origins: ["https://app.example.test/path"] },
    { origins: ["http://app.example.test"] },
  ])
    expect(() => defineConfig({ project: "tasks", auth })).toThrow();
  expect(defineConfig({ project: "tasks", auth: { origins: ["http://localhost:5173"] } }).auth.origins).toEqual([
    "http://localhost:5173",
  ]);
});

test("project paths reject traversal and symlink escapes without requiring the output to exist", async () => {
  const root = await mkdtemp(join(tmpdir(), "loom-config-"));
  const outside = await mkdtemp(join(tmpdir(), "loom-outside-"));
  try {
    await mkdir(join(root, "kello"));
    await symlink(outside, join(root, "linked"));
    expect(await resolveProjectPath(root, "kello/new/file.ts")).toBe(join(await realpath(root), "kello/new/file.ts"));
    await expect(resolveProjectPath(root, "../outside")).rejects.toThrow("escape");
    await expect(resolveProjectPath(root, "linked/new/file.ts")).rejects.toThrow("escape");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
