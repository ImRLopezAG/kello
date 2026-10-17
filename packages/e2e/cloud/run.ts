import assert from "node:assert/strict";
import { mkdir, readFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import pg from "pg";
import * as v from "valibot";
import { defineConfig, inspectDeploymentTarget } from "kello/tooling";
import { runHistoricalAcceptance } from "../historical/run";

const suite = v.parse(
  v.picklist(["tasks", "jobs-storage", "services", "upgrade", "components", "better-auth", "search"]),
  process.env.LOOM_CLOUD_SUITE,
);
const projectId = v.parse(v.pipe(v.string(), v.minLength(1)), process.env.KELLO_CLOUD_PROJECT_ID);
const branchId = v.parse(v.pipe(v.string(), v.minLength(1)), process.env.LOOM_CLOUD_BRANCH_ID);
assert(projectId && branchId, "Required cloud acceptance needs a project and branch");
const target = await inspectDeploymentTarget(
  defineConfig({ project: "acceptance", provider: { projectId, targets: { preview: { branchId } } } }),
  "preview",
);
assert(
  !target.protected && target.branchName.startsWith("loom-acceptance-"),
  "Use an unprotected disposable acceptance branch",
);
const cwd = fileURLToPath(new URL("../", import.meta.url));
const directory = resolve(process.env.LOOM_CLOUD_RECEIPT_DIR ?? join(cwd, ".cloud-receipts"));
await mkdir(directory, { recursive: true });
const env = { ...process.env };
const neonCli = createRequire(import.meta.resolve("kello/tooling")).resolve("neon/dist/index.js");
async function neon(args: string[]) {
  try {
    const result = await promisify(execFile)(
      "node",
      [neonCli, ...args, "--project-id", projectId, "--branch", branchId, "--output", "json"],
      { timeout: 90000 },
    );
    return result.stdout;
  } catch {
    // Provider diagnostics can contain credentials. Keep them out of CI output.
    throw new Error(`Neon acceptance setup failed: ${args.slice(0, 3).join(" ")}`);
  }
}
if (!env.LOOM_MIGRATION_DATABASE_URL) {
  const result = await promisify(execFile)(
    "node",
    [
      neonCli,
      "connection-string",
      branchId,
      "--project-id",
      projectId,
      "--role-name",
      env.LOOM_CLOUD_MIGRATION_ROLE ?? "neondb_owner",
      "--ssl",
      "verify-full",
    ],
    { timeout: 30000 },
  ).catch(() => {
    throw new Error("Cloud connection discovery failed");
  });
  const address = new URL(result.stdout.trim());
  assert.equal(address.protocol, "postgresql:");
  assert.equal(address.searchParams.get("sslmode"), "verify-full");
  env.LOOM_MIGRATION_DATABASE_URL = address.href;
}
env.LOOM_CLOUD_RUNTIME_ROLE ??= `runtime_${crypto.randomUUID().replaceAll("-", "")}`;
// Verify even an explicitly supplied URL before Auth setup can execute DDL.
const migrationAddress = new URL(env.LOOM_MIGRATION_DATABASE_URL);
assert.equal(migrationAddress.protocol, "postgresql:");
assert.equal(
  migrationAddress.hostname.split(".")[0],
  target.endpointId,
  "Database URL must belong to the selected branch endpoint",
);
assert(migrationAddress.hostname.endsWith(".neon.tech") && !migrationAddress.hash);
assert.equal(migrationAddress.port, "");
for (const parameter of migrationAddress.searchParams.keys())
  assert(["sslmode", "channel_binding"].includes(parameter), "Unexpected database URL option");
migrationAddress.searchParams.set("sslmode", "verify-full");
env.LOOM_MIGRATION_DATABASE_URL = migrationAddress.href;
if (suite === "tasks" || suite === "jobs-storage") {
  if (env.LOOM_CLOUD_SETUP_AUTH === "1") {
    const admin = new pg.Client({ connectionString: env.LOOM_MIGRATION_DATABASE_URL });
    try {
      await admin.connect();
      const role = await admin.query("SELECT 1 FROM pg_roles WHERE rolname='neon_service'");
      if (role.rowCount) {
        const name = (await admin.query<{ name: string }>("SELECT current_database() AS name")).rows[0]?.name;
        assert(name);
        await admin.query(`GRANT CREATE ON DATABASE "${name.replaceAll('"', '""')}" TO neon_service`);
      }
    } finally {
      await admin.end();
    }
    const result = v.parse(
      v.object({ base_url: v.string() }),
      JSON.parse(
        await neon([
          "neon-auth",
          "enable",
          "--database-name",
          decodeURIComponent(new URL(env.LOOM_MIGRATION_DATABASE_URL).pathname.slice(1)),
        ]),
      ),
    );
    env.VITE_NEON_AUTH_URL = result.base_url;
    await neon(["neon-auth", "domain", "allow-localhost", "enable"]);
    await neon([
      "neon-auth",
      "config",
      "email-password",
      "update",
      "--enabled",
      "--require-email-verification=false",
      "--disable-sign-up=false",
    ]);
  }
  assert(env.VITE_NEON_AUTH_URL, "Real Neon Auth acceptance requires its branch URL");
  env.LOOM_CLOUD_NEON_AUTH = "1";
  env.LOOM_CLOUD_AUTH_EXAMPLE = suite;
}
if (suite === "better-auth") {
  env.LOOM_CLOUD_HOSTED_AUTH = "1";
  env.LOOM_TEST_DATABASE_URL = env.LOOM_MIGRATION_DATABASE_URL;
}
if (suite === "components") env.LOOM_CLOUD_COMPONENTS = "1";
if (suite === "search") env.LOOM_CLOUD_SEARCH = "1";
if (suite === "services") env.LOOM_CLOUD_SERVICES = "1";
if (suite === "upgrade") {
  if (!env.LOOM_CLOUD_PREVIOUS_VERSION) {
    const historical = await runHistoricalAcceptance(
      { ...env, LOOM_CLOUD_LIVE_SECONDS: "1", LOOM_CLOUD_LIVE_WARMUP_SECONDS: "30" },
      join(directory, "historical.json"),
    );
    env.LOOM_CLOUD_PREVIOUS_VERSION = historical.version;
    // The predecessor's test issuer is owned by this disposable fixture.
    await neon(["functions", "delete", "loomissuer"]);
  }
  env.LOOM_CLOUD_UPGRADE = "1";
}
const file =
  suite === "search"
    ? "search"
    : suite === "better-auth"
      ? "better-auth"
      : suite === "components"
        ? "components"
        : suite === "tasks" || suite === "jobs-storage"
          ? "neon-auth"
          : `orpc-${suite}`;
const receipt = join(directory, `${suite}.json`);
await rm(receipt, { force: true });
env.LOOM_CLOUD_RECEIPT = receipt;
const child = Bun.spawn(["bun", "test", "cloud/target.test.ts", "cloud/database.test.ts", `cloud/${file}.test.ts`], {
  cwd,
  env,
  stdout: "inherit",
  stderr: "inherit",
});
assert.equal(await child.exited, 0, "Required cloud suite failed");
const saved = v.parse(
  v.object({ projectId: v.literal(projectId), branchId: v.literal(branchId), passed: v.literal(true) }),
  JSON.parse(await readFile(receipt, "utf8")),
);
console.log(`Required ${suite} acceptance passed on ${saved.branchId}; receipt ${receipt}`);
