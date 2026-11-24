import assert from "node:assert/strict";
import { mkdir, readFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as pg from "../fixtures/postgres";
import * as v from "valibot";
import { defineConfig, inspectDeploymentTarget } from "kello-cli";
import { runHistoricalAcceptance } from "../historical/run";
import { acceptanceSchemasForRole, assertDisposableBranch, redact } from "./lifecycle";
import { executeTeardown } from "./teardown";

const suite = v.parse(
  v.picklist([
    "tasks",
    "jobs-storage",
    "next",
    "start",
    "components-browser",
    "services",
    "upgrade",
    "components",
    "better-auth",
    "search",
  ]),
  process.env.KELLO_CLOUD_SUITE,
);
const projectId = v.parse(v.pipe(v.string(), v.minLength(1)), process.env.KELLO_CLOUD_PROJECT_ID);
const branchId = v.parse(v.pipe(v.string(), v.minLength(1)), process.env.KELLO_CLOUD_BRANCH_ID);
assert(projectId && branchId, "Required cloud acceptance needs a project and branch");
const target = await inspectDeploymentTarget(
  defineConfig({ project: "acceptance", provider: { projectId, targets: { preview: { branchId } } } }),
  "preview",
);
assert(
  !target.protected && target.branchName.startsWith("kello-acceptance-"),
  "Use an unprotected disposable acceptance branch",
);
const cwd = fileURLToPath(new URL("../", import.meta.url));
const directory = resolve(process.env.KELLO_CLOUD_RECEIPT_DIR ?? join(cwd, ".cloud-receipts"));
await mkdir(directory, { recursive: true });
const env = { ...process.env };
const neonCli = createRequire(import.meta.resolve("kello-cli")).resolve("neon/dist/index.js");
async function neon(args: string[], branchScoped = true) {
  try {
    const result = await promisify(execFile)(
      "node",
      [
        neonCli,
        ...args,
        "--project-id",
        projectId,
        ...(branchScoped ? ["--branch", branchId] : []),
        "--output",
        "json",
      ],
      { timeout: 90000 },
    );
    return result.stdout;
  } catch {
    // Provider diagnostics can contain credentials. Keep them out of CI output.
    throw new Error(`Neon acceptance setup failed: ${args.slice(0, 3).join(" ")}`);
  }
}
// Leftover functions keep their wake triggers firing, so a branch without a bounded expiry would stay awake forever.
const branchRecord = v.object({
  name: v.string(),
  protected: v.optional(v.boolean()),
  default: v.optional(v.boolean()),
  expires_at: v.optional(v.nullable(v.string())),
});
/** The Neon CLI prints either the branch itself or `{ branch }`. */
function parseBranch(output: string) {
  const parsed = v.parse(v.union([v.object({ branch: branchRecord }), branchRecord]), JSON.parse(output));
  return "branch" in parsed ? parsed.branch : parsed;
}
assertDisposableBranch(parseBranch(await neon(["branches", "get", branchId], false)));
async function listFunctionSlugs() {
  const listed: unknown = JSON.parse(await neon(["functions", "list"]));
  return v.parse(v.array(v.object({ slug: v.string() })), listed).map(({ slug }) => slug);
}
if (!env.KELLO_MIGRATION_DATABASE_URL) {
  const result = await promisify(execFile)(
    "node",
    [
      neonCli,
      "connection-string",
      branchId,
      "--project-id",
      projectId,
      "--role-name",
      env.KELLO_CLOUD_MIGRATION_ROLE ?? "neondb_owner",
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
  env.KELLO_MIGRATION_DATABASE_URL = address.href;
}
// Only a role this runner generated is owned by it and may be dropped during teardown.
const ownsRuntimeRole = !env.KELLO_CLOUD_RUNTIME_ROLE;
env.KELLO_CLOUD_RUNTIME_ROLE ??= `runtime_${crypto.randomUUID().replaceAll("-", "")}`;
// Verify even an explicitly supplied URL before Auth setup can execute DDL.
const migrationAddress = new URL(env.KELLO_MIGRATION_DATABASE_URL);
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
env.KELLO_MIGRATION_DATABASE_URL = migrationAddress.href;
if (
  suite === "tasks" ||
  suite === "jobs-storage" ||
  suite === "next" ||
  suite === "start" ||
  suite === "components-browser"
) {
  if (env.KELLO_CLOUD_SETUP_AUTH === "1") {
    const admin = new pg.Client({ connectionString: env.KELLO_MIGRATION_DATABASE_URL });
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
          decodeURIComponent(new URL(env.KELLO_MIGRATION_DATABASE_URL).pathname.slice(1)),
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
  env.KELLO_CLOUD_NEON_AUTH = "1";
  env.KELLO_CLOUD_AUTH_EXAMPLE = suite === "components-browser" ? "components" : suite;
}
if (suite === "better-auth") {
  env.KELLO_CLOUD_HOSTED_AUTH = "1";
  env.KELLO_TEST_DATABASE_URL = env.KELLO_MIGRATION_DATABASE_URL;
}
if (suite === "components") env.KELLO_CLOUD_COMPONENTS = "1";
if (suite === "search") env.KELLO_CLOUD_SEARCH = "1";
if (suite === "services") env.KELLO_CLOUD_SERVICES = "1";
if (suite === "upgrade") {
  if (!env.KELLO_CLOUD_PREVIOUS_VERSION) {
    const historical = await runHistoricalAcceptance(
      { ...env, KELLO_CLOUD_LIVE_SECONDS: "1", KELLO_CLOUD_LIVE_WARMUP_SECONDS: "30" },
      join(directory, "historical.json"),
    );
    env.KELLO_CLOUD_PREVIOUS_VERSION = historical.version;
    // The predecessor's test issuer is owned by this disposable fixture.
    await neon(["functions", "delete", "kelloissuer"]);
  }
  env.KELLO_CLOUD_UPGRADE = "1";
}
const file =
  suite === "search"
    ? "search"
    : suite === "better-auth"
      ? "better-auth"
      : suite === "components"
        ? "components"
        : suite === "tasks" ||
            suite === "jobs-storage" ||
            suite === "next" ||
            suite === "start" ||
            suite === "components-browser"
          ? "neon-auth"
          : `orpc-${suite}`;
const receipt = join(directory, `${suite}.json`);
await rm(receipt, { force: true });
env.KELLO_CLOUD_RECEIPT = receipt;
const deploysFunctions = file === "neon-auth";
const functionsBefore = deploysFunctions ? new Set(await listFunctionSlugs()) : new Set<string>();
let exitCode: number;
try {
  const child = Bun.spawn(["bun", "test", "cloud/target.test.ts", "cloud/database.test.ts", `cloud/${file}.test.ts`], {
    cwd,
    env,
    stdout: "inherit",
    stderr: "inherit",
  });
  exitCode = await child.exited;
} finally {
  if (deploysFunctions) await teardown();
}
assert.equal(exitCode, 0, "Required cloud suite failed");
const saved = v.parse(
  v.object({ projectId: v.literal(projectId), branchId: v.literal(branchId), passed: v.literal(true) }),
  JSON.parse(await readFile(receipt, "utf8")),
);
console.log(`Required ${suite} acceptance passed on ${saved.branchId}; receipt ${receipt}`);

/** Stops the deployed functions and wake triggers, then drops the fixture's schemas and runtime role. */
async function teardown() {
  const functions = new Set<string>();
  const failures: string[] = [];
  try {
    for (const slug of await listFunctionSlugs()) if (!functionsBefore.has(slug)) functions.add(slug);
  } catch {
    failures.push("function listing");
  }
  try {
    const recorded = v.parse(
      v.object({ namespace: v.optional(v.string()), functions: v.array(v.object({ slug: v.string() })) }),
      JSON.parse(await readFile(receipt, "utf8")),
    );
    for (const { slug } of recorded.functions) functions.add(slug);
    if (recorded.namespace && !recorded.namespace.startsWith("accept_"))
      // Example-configured namespaces are shared by later runs on the branch; report rather than drop them.
      console.warn(`Acceptance teardown keeps configured namespace ${recorded.namespace}`);
  } catch {
    // Failed runs write no receipt; the listing diff above covers newly created functions.
  }
  const role = env.KELLO_CLOUD_RUNTIME_ROLE!;
  try {
    failures.push(
      ...(await executeTeardown(
        {
          functions: [...functions],
          schemas: ownsRuntimeRole ? acceptanceSchemasForRole(role) : [],
          roles: ownsRuntimeRole ? [role] : [],
        },
        {
          deleteFunction: (slug) => neon(["functions", "delete", slug]),
          connectionString: env.KELLO_MIGRATION_DATABASE_URL!,
        },
      )),
    );
  } catch (cause) {
    failures.push(redact(cause instanceof Error ? cause.message : "teardown"));
  }
  if (failures.length) {
    process.exitCode = 1;
    console.error(`Acceptance teardown incomplete (${failures.join(", ")}); run \`bun run cleanup:cloud\``);
  } else console.log(`Acceptance teardown removed ${functions.size} function(s) and the fixture database objects`);
}
