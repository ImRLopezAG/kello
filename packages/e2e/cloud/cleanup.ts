/**
 * Lists (default) or removes (`--apply`) acceptance leftovers on one `kello-acceptance-*` branch:
 * Neon functions, `accept_*` / `kello_accept_*` schemas and `runtime_*` roles.
 *
 *   bun run cleanup:cloud -- --project-id <id> --branch <id> [--include-functions [--keep <slug>]...] [--apply]
 *
 * Project and branch fall back to KELLO_CLOUD_PROJECT_ID / KELLO_CLOUD_BRANCH_ID. Output contains
 * object names only, never connection strings or provider diagnostics.
 */
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { parseArgs, promisify } from "node:util";
import pg from "pg";
import * as v from "valibot";
import { assertAcceptanceBranch, selectLeftovers } from "./lifecycle";
import { executeTeardown } from "./teardown";

const { values } = parseArgs({
  options: {
    "project-id": { type: "string" },
    branch: { type: "string" },
    keep: { type: "string", multiple: true },
    apply: { type: "boolean", default: false },
    // Function slugs carry no ownership marker; deleting them asserts this branch is used only for acceptance.
    "include-functions": { type: "boolean", default: false },
  },
});
const projectId = values["project-id"] ?? process.env.KELLO_CLOUD_PROJECT_ID;
const branchId = values.branch ?? process.env.KELLO_CLOUD_BRANCH_ID;
if (!projectId || !branchId) throw new Error("Pass --project-id and --branch (or KELLO_CLOUD_PROJECT_ID/BRANCH_ID)");

const neonCli = createRequire(import.meta.resolve("kello-cli")).resolve("neon/dist/index.js");
async function neon(args: string[], json = true) {
  try {
    const result = await promisify(execFile)(
      "node",
      [neonCli, ...args, "--project-id", projectId!, ...(json ? ["--output", "json"] : [])],
      { timeout: 90000 },
    );
    return result.stdout;
  } catch {
    // Provider diagnostics can contain credentials. Keep them out of the output.
    throw new Error(`Neon cleanup operation failed: ${args.slice(0, 2).join(" ")}`);
  }
}

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
const branch = parseBranch(await neon(["branches", "get", branchId]));
assertAcceptanceBranch(branch);
const connectionString = (
  await neon(["connection-string", branchId, "--role-name", "neondb_owner", "--ssl", "verify-full"], false)
).trim();
const client = new pg.Client({ connectionString, connectionTimeoutMillis: 15000 });
let schemas: string[];
let roles: string[];
try {
  await client.connect();
  schemas = (
    await client.query<{ name: string }>(
      String.raw`SELECT nspname AS name FROM pg_namespace WHERE nspname ~ '^(kello_)?accept_[a-f0-9]{32}$' ORDER BY 1`,
    )
  ).rows.map((row) => row.name);
  roles = (
    await client.query<{ name: string }>(
      String.raw`SELECT rolname AS name FROM pg_roles WHERE rolname ~ '^runtime_[a-f0-9]{32}$' ORDER BY 1`,
    )
  ).rows.map((row) => row.name);
} catch {
  throw new Error("Could not list acceptance database objects");
} finally {
  await client.end().catch(() => {});
}
const functions = v
  .parse(v.array(v.object({ slug: v.string() })), JSON.parse(await neon(["functions", "list", "--branch", branchId])))
  .map(({ slug }) => slug);
const plan = selectLeftovers({
  schemas,
  roles,
  functions: values["include-functions"] ? functions : [],
  keepFunctions: values.keep ?? [],
});

const mode = values.apply ? "Removing" : "DRY RUN: would remove";
console.log(`${mode} from ${branch.name}:`);
for (const slug of plan.functions) console.log(`  function ${slug}`);
for (const schema of plan.schemas) console.log(`  schema   ${schema}`);
for (const role of plan.roles) console.log(`  role     ${role}`);
if (!plan.functions.length && !plan.schemas.length && !plan.roles.length) console.log("  nothing");
if (!values["include-functions"] && functions.length)
  console.log(
    `  (${functions.length} function(s) not listed; add --include-functions if this branch is acceptance-only)`,
  );
if (!values.apply) {
  console.log("Re-run with --apply to delete.");
} else {
  const failures = await executeTeardown(plan, {
    deleteFunction: (slug) => neon(["functions", "delete", slug, "--branch", branchId]),
    connectionString,
  });
  if (failures.length) {
    console.error(`Cleanup incomplete: ${failures.join(", ")}`);
    process.exitCode = 1;
  } else console.log("Cleanup complete.");
}
