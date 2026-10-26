#!/usr/bin/env bun
import * as v from "valibot";
import { onboardingCommand } from "./commands/onboarding";
import { OnboardingError } from "./tooling";
import { neonLogin, neonProfiles } from "./commands/login";
import { withNeonCredentials } from "./tooling";
import { NeonCredentialError, ProjectResolutionError, RealtimeError } from "./tooling";
import { realtimeEnableCommand, realtimeStatusCommand } from "./commands/realtime";
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { deployCommand } from "./commands/deploy";
import { retireDatabaseCommand } from "./commands/retire";
import { provisionCommand } from "./commands/provision";
import { devCommand } from "./commands/dev";
import { backfillApplyCommand } from "./commands/backfill";
import { compatibilityCommand } from "./commands/compatibility";
import {
  generateProject,
  initializeProject,
  loadProject,
  planRelease,
  assessMigration,
  generateRelease,
  generateCustomRelease,
  readRenameHints,
  projectMigrationStatus,
  applyProjectMigrations,
  MigrationCommandError,
  ProcedureUpgradeError,
  generateProjectBackfill,
  projectBackfillStatus,
} from "./tooling";

const help = `Usage: kello <command> [--cwd <directory>] [--json]

  login [--profile <name>]       Sign in through the official Neon CLI
  profile list                  List official Neon credential profiles
  create [directory] --name <name> --region <region>  Create and link a Neon project
  link [--project-id <id>]       Discover and link an existing Neon project
  integrate [--apply]            Preview or add Kello files to an existing frontend
  init [directory] --name <name>  Create a project without overwriting files
  generate                      Generate public/internal references and manifest
  dev [--development <file>]     Watch sources and deploy each change to the linked Neon preview branch
  schema inspect                Inspect compiled storage metadata
  schema diff                   Plan changes from the committed migration baseline
  migrations generate --name <name>  Write release SQL and snapshot artifacts
  migrations status             Inspect applied history and live drift without DDL
  migrations apply --runtime-role <role>  Apply validated release artifacts
  migrations declare-compatibility --release <file>  Record reviewed compatibility for an active version without DDL
  backfill generate --name <name> --table <table> --sql <file>  Capture a reviewable backfill plan
  backfill apply --backfill <file> --runtime-role <role> --reviewed-hash <hash>  Apply or resume batches
  backfill status --backfill <file>  Inspect saved progress
  deploy [--release <file>] [--dry-run]  Deploy using kello.config.ts or an explicit release
  retire database --retirement <file>  Retire database authority for a saved release
  provision --branch <file> [--dry-run]  Plan, create or resume branch infrastructure
  realtime status               Report Neon Realtime for the linked branch without changes
  realtime enable --origin <origin> [--allow-protected]  Enable Realtime and wait for readiness
  doctor                        Validate configuration, schema, and registered functions

Schema diff and migration generation accept --renames <project-relative JSON file>.
Migration application accepts repeated --reviewed-hash <hash> for reviewed changes.
Use --recover-nontransactional with migrations apply for reviewed concurrent column B-tree indexes.
Custom generation accepts --sql <project-relative file> --mode transactional|nontransactional.
`;

export async function runCli(args: readonly string[]): Promise<number> {
  try {
    const selection = parseArgs({
      args: [...args],
      allowPositionals: true,
      strict: false,
      options: { profile: { type: "string" }, "config-dir": { type: "string" } },
    });
    return withNeonCredentials(
      {
        profile: v.parse(v.optional(v.string()), selection.values.profile),
        configDir: v.parse(v.optional(v.string()), selection.values["config-dir"]),
      },
      () => runCommand(args),
    );
  } catch {
    reportFailure(args.includes("--json"), "arguments", "USAGE", "Invalid arguments; run kello --help", 2);
    return 2;
  }
}

async function runCommand(args: readonly string[]): Promise<number> {
  const structured = args.includes("--json");
  let command = "arguments";
  let databaseCommand = false;
  try {
    const parsed = parseArgs({
      args: [...args],
      allowPositionals: true,
      strict: true,
      options: {
        profile: { type: "string" },
        "config-dir": { type: "string" },
        keyring: { type: "boolean" },
        "project-id": { type: "string" },
        "org-id": { type: "string" },
        region: { type: "string" },
        database: { type: "string" },
        apply: { type: "boolean" },
        cwd: { type: "string" },
        name: { type: "string" },
        renames: { type: "string" },
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
        "runtime-role": { type: "string" },
        "reviewed-hash": { type: "string", multiple: true },
        "recover-nontransactional": { type: "boolean" },
        backfill: { type: "string" },
        table: { type: "string" },
        "batch-size": { type: "string" },
        "max-batches": { type: "string" },
        sql: { type: "string" },
        mode: { type: "string" },
        release: { type: "string" },
        retirement: { type: "string" },
        branch: { type: "string" },
        development: { type: "string" },
        "dry-run": { type: "boolean" },
        origin: { type: "string", multiple: true },
        "allow-protected": { type: "boolean" },
      },
    });
    const [first, second, ...extra] = parsed.positionals;
    if (parsed.values.help || !first) {
      console.log(structured ? JSON.stringify({ ok: true, help }) : help);
      return 0;
    }
    command = first;
    const root = resolve(parsed.values.cwd ?? process.cwd());
    const credentialOptions = { profile: parsed.values.profile, configDir: parsed.values["config-dir"] };
    if (first === "login" && !second) return await neonLogin({ ...credentialOptions, keyring: parsed.values.keyring });
    if (first === "profile" && second === "list" && !extra.length) return await neonProfiles(credentialOptions);
    delete parsed.values.profile;
    delete parsed.values["config-dir"];
    if (["create", "link", "integrate"].includes(first)) {
      const allowed =
        first === "integrate"
          ? ["cwd", "json", "apply"]
          : first === "link"
            ? ["cwd", "json", "project-id", "org-id", "branch", "database", "dry-run"]
            : ["cwd", "json", "name", "region", "org-id", "branch", "database", "dry-run"];
      if (
        extra.length ||
        (first !== "create" && second) ||
        Object.keys(parsed.values).some((key) => !allowed.includes(key))
      )
        throw new OnboardingError("ONBOARDING_SELECTION", "Unexpected onboarding arguments; run kello --help.");
      if (first === "create" || first === "link" || first === "integrate")
        return await onboardingCommand(first, resolve(root, second ?? "."), {
          structured,
          name: parsed.values.name,
          region: parsed.values.region,
          projectId: parsed.values["project-id"],
          orgId: parsed.values["org-id"],
          branch: parsed.values.branch,
          databaseName: parsed.values.database,
          dryRun: parsed.values["dry-run"],
          apply: parsed.values.apply,
        });
    }
    if (first === "migrations" && second === "declare-compatibility") {
      command = "migrations declare-compatibility";
      if (
        extra.length ||
        !parsed.values.release ||
        Object.keys(parsed.values).some((name) => !["cwd", "json", "release"].includes(name))
      ) {
        reportFailure(
          structured,
          command,
          "USAGE",
          "migrations declare-compatibility requires --release and accepts --cwd and --json",
          2,
        );
        return 2;
      }
      databaseCommand = true;
      return await compatibilityCommand(root, parsed.values.release, structured);
    }
    if (first === "retire" || parsed.values.retirement !== undefined) {
      if (
        first !== "retire" ||
        second !== "database" ||
        extra.length ||
        !parsed.values.retirement ||
        Object.keys(parsed.values).some((name) => !["cwd", "json", "retirement"].includes(name))
      ) {
        reportFailure(
          structured,
          command,
          "USAGE",
          "retire database requires --retirement and accepts --cwd and --json",
          2,
        );
        return 2;
      }
      command = "retire database";
      return await retireDatabaseCommand(root, parsed.values.retirement, structured);
    }
    if (first === "realtime" || parsed.values.origin !== undefined || parsed.values["allow-protected"] !== undefined) {
      const allowed = second === "enable" ? ["cwd", "json", "origin", "allow-protected"] : ["cwd", "json"];
      if (
        first !== "realtime" ||
        (second !== "status" && second !== "enable") ||
        extra.length ||
        Object.keys(parsed.values).some((name) => !allowed.includes(name))
      ) {
        reportFailure(
          structured,
          command,
          "USAGE",
          "Use kello realtime status, or kello realtime enable --origin <origin> [--allow-protected]",
          2,
        );
        return 2;
      }
      command = `realtime ${second}`;
      return second === "status"
        ? await realtimeStatusCommand(root, structured)
        : await realtimeEnableCommand(root, structured, {
            allowedOrigins: parsed.values.origin ?? [],
            allowProtected: parsed.values["allow-protected"] ?? false,
          });
    }
    if (
      first === "backfill" ||
      ["backfill", "table", "batch-size", "max-batches"].some((name) => Object.keys(parsed.values).includes(name))
    ) {
      const allowed =
        second === "generate"
          ? ["name", "table", "sql", "batch-size"]
          : second === "apply"
            ? ["backfill", "runtime-role", "reviewed-hash", "max-batches"]
            : ["backfill"];
      const hashes = parsed.values["reviewed-hash"] ?? [];
      const batchSize = parsed.values["batch-size"] === undefined ? 500 : Number(parsed.values["batch-size"]);
      const maxBatches = parsed.values["max-batches"] === undefined ? undefined : Number(parsed.values["max-batches"]);
      if (
        first !== "backfill" ||
        !["generate", "apply", "status"].includes(second ?? "") ||
        extra.length ||
        Object.keys(parsed.values).some((name) => !["cwd", "json", ...allowed].includes(name)) ||
        (second === "generate" &&
          (!parsed.values.name ||
            !parsed.values.table ||
            !parsed.values.sql ||
            !Number.isSafeInteger(batchSize) ||
            batchSize < 1 ||
            batchSize > 10000)) ||
        (second !== "generate" && !parsed.values.backfill) ||
        (second === "apply" &&
          (!parsed.values["runtime-role"] ||
            hashes.length !== 1 ||
            (maxBatches !== undefined && (!Number.isSafeInteger(maxBatches) || maxBatches < 1))))
      ) {
        reportFailure(
          structured,
          command,
          "USAGE",
          "Backfill commands require explicit plan, batch and review options; see --help",
          2,
        );
        return 2;
      }
      databaseCommand = true;
      if (second === "generate" && parsed.values.name && parsed.values.table && parsed.values.sql) {
        const artifact = await generateProjectBackfill(
          root,
          parsed.values.name,
          parsed.values.table,
          parsed.values.sql,
          batchSize,
        );
        console.log(
          structured
            ? JSON.stringify({ ok: true, command: "backfill generate", artifact })
            : JSON.stringify(artifact, null, 2),
        );
        return 0;
      }
      if (second === "status" && parsed.values.backfill) {
        const receipt = await projectBackfillStatus(root, parsed.values.backfill);
        console.log(
          structured
            ? JSON.stringify({ ok: true, command: "backfill status", receipt })
            : JSON.stringify(receipt, null, 2),
        );
        return 0;
      }
      const role = parsed.values["runtime-role"];
      const reviewed = hashes[0];
      if (parsed.values.backfill && role && reviewed)
        return await backfillApplyCommand(
          root,
          parsed.values.backfill,
          { runtimeRole: role, reviewedHash: reviewed, maxBatches },
          structured,
        );
      throw new Error("Invalid backfill command");
    }
    if (parsed.values["recover-nontransactional"] !== undefined && (first !== "migrations" || second !== "apply")) {
      reportFailure(structured, command, "USAGE", "--recover-nontransactional requires migrations apply", 2);
      return 2;
    }
    if (first === "dev" || parsed.values.development !== undefined) {
      if (
        first !== "dev" ||
        parsed.positionals.length !== 1 ||
        parsed.values.development === "" ||
        Object.keys(parsed.values).some((name) => !["cwd", "json", "development"].includes(name))
      ) {
        reportFailure(structured, command, "USAGE", "dev accepts --development, --cwd and --json", 2);
        return 2;
      }
      const file = parsed.values.development ?? "kello.config.ts";
      return await devCommand(root, file, structured);
    }
    if (first === "provision" || parsed.values.branch !== undefined) {
      if (
        first !== "provision" ||
        parsed.positionals.length !== 1 ||
        !parsed.values.branch ||
        Object.keys(parsed.values).some((name) => !["cwd", "json", "branch", "dry-run"].includes(name))
      ) {
        reportFailure(
          structured,
          command,
          "USAGE",
          "provision accepts --branch, --dry-run, --cwd and --json options",
          2,
        );
        return 2;
      }
      return await provisionCommand(root, parsed.values.branch, structured, parsed.values["dry-run"] ?? false);
    }
    if (first === "deploy" || parsed.values.release !== undefined || parsed.values["dry-run"] !== undefined) {
      if (
        first !== "deploy" ||
        parsed.positionals.length !== 1 ||
        parsed.values.release === "" ||
        Object.keys(parsed.values).some((name) => !["cwd", "json", "release", "dry-run"].includes(name))
      ) {
        reportFailure(structured, command, "USAGE", "deploy accepts --release, --dry-run, --cwd and --json options", 2);
        return 2;
      }
      return await deployCommand(
        root,
        parsed.values.release ?? "kello.config.ts",
        structured,
        parsed.values["dry-run"] ?? false,
      );
    }
    if (parsed.values.sql !== undefined || parsed.values.mode !== undefined) {
      const mode = parsed.values.mode;
      if (
        first !== "migrations" ||
        second !== "generate" ||
        !parsed.values.sql ||
        !parsed.values.name ||
        parsed.values.renames !== undefined ||
        (mode !== "transactional" && mode !== "nontransactional") ||
        extra.length
      ) {
        reportFailure(
          structured,
          command,
          "USAGE",
          "Custom generation requires --name, --sql and --mode transactional|nontransactional, without --renames",
          2,
        );
        return 2;
      }
      const artifact = await generateCustomRelease(root, parsed.values.name, parsed.values.sql, mode);
      const assessment = await assessMigration(artifact.plan);
      console.log(
        structured
          ? JSON.stringify({ ok: true, command, artifact, assessment })
          : `Generated custom migration ${artifact.name}. Review and commit its SQL and snapshot before application.\n${JSON.stringify(assessment, null, 2)}`,
      );
      return 0;
    }
    if (extra.length) {
      reportFailure(structured, command, "USAGE", "Unexpected positional arguments; run kello --help", 2);
      return 2;
    }
    if (first === "init") {
      if (!parsed.values.name) {
        reportFailure(structured, command, "MISSING_VALUE", "init requires --name", 2);
        return 2;
      }
      const created = await initializeProject(resolve(root, second ?? "."), parsed.values.name);
      console.log(
        structured
          ? JSON.stringify({ ok: true, command, files: created })
          : `Created ${created.length} project files. Install dependencies, then run kello link and kello generate.`,
      );
      return 0;
    }
    if (first === "generate" && !second) {
      const manifest = await generateProject(root);
      console.log(
        structured
          ? JSON.stringify({ ok: true, command, manifest })
          : `Generated ${manifest.procedures.length} procedure contracts (${manifest.version}).`,
      );
      return 0;
    }
    if (first === "migrations" && (second === "apply" || second === "status")) {
      if (second === "apply" && !parsed.values["runtime-role"]) {
        reportFailure(structured, command, "MISSING_VALUE", "migrations apply requires --runtime-role", 2);
        return 2;
      }
      databaseCommand = true;
      if (second === "status") {
        const status = await projectMigrationStatus(root);
        console.log(
          structured ? JSON.stringify({ ok: status.consistent, command, status }) : JSON.stringify(status, null, 2),
        );
        return status.consistent ? 0 : 4;
      }
      const role = parsed.values["runtime-role"];
      if (role) {
        const receipt = await applyProjectMigrations(
          root,
          role,
          parsed.values["reviewed-hash"],
          parsed.values["recover-nontransactional"],
        );
        console.log(
          structured
            ? JSON.stringify({ ok: true, command, receipt })
            : `Applied ${receipt.applied.length + receipt.components.reduce((total, scope) => total + scope.applied.length, 0)} migrations across ${receipt.components.length + 1} scopes in ${receipt.target.database} as ${receipt.target.role}.`,
        );
      }
      return 0;
    }
    if ((first === "schema" && second === "diff") || (first === "migrations" && second === "generate")) {
      if (first === "migrations" && !parsed.values.name) {
        reportFailure(structured, command, "MISSING_VALUE", "migrations generate requires --name", 2);
        return 2;
      }
      const renames = parsed.values.renames ? await readRenameHints(root, parsed.values.renames) : [];
      if (first === "schema") {
        const plan = await planRelease(root, renames);
        const assessment = await assessMigration(plan);
        console.log(
          structured
            ? JSON.stringify({ ok: true, command, baseline: "committed", plan, assessment })
            : JSON.stringify({ baseline: "committed", statements: plan.statements, ...assessment }, null, 2),
        );
      } else if (parsed.values.name) {
        const artifact = await generateRelease(root, parsed.values.name, renames);
        const assessments = await Promise.all(
          artifact.scopes.map(async (scope) => ({
            namespace: scope.namespace,
            assessment: await assessMigration(scope.artifact.plan),
          })),
        );
        console.log(
          structured
            ? JSON.stringify({ ok: true, command, artifact, assessments })
            : `Generated ${artifact.scopes.length} migration${artifact.scopes.length === 1 ? "" : "s"}: ${artifact.scopes.map((scope) => scope.artifact.name).join(", ")}. Review and commit their SQL and snapshots before application.\n${JSON.stringify(assessments, null, 2)}`,
        );
      }
      return 0;
    }
    if ((first === "schema" && second === "inspect") || (first === "doctor" && !second)) {
      const project = await loadProject(root);
      const result = {
        project: project.config.project,
        version: project.version,
        schemaFingerprint: project.schema.fingerprint,
        procedures: project.procedures.length,
        target: project.config.provider ?? null,
      };
      console.log(
        structured
          ? JSON.stringify({ ok: true, command, ...result, schema: project.schema.metadata })
          : first === "schema"
            ? JSON.stringify(project.schema.metadata, null, 2)
            : `Project ${result.project}: valid configuration, schema and ${result.procedures} procedures. Version ${result.version}.`,
      );
      return 0;
    }
    reportFailure(structured, command, "USAGE", "Unknown command or arguments; run kello --help", 2);
    return 2;
  } catch (cause) {
    if (cause instanceof RealtimeError) {
      reportFailure(structured, command, cause.code, cause.message, 5);
      return 5;
    }
    if (cause instanceof ProjectResolutionError || cause instanceof OnboardingError) {
      reportFailure(structured, command, cause.code, cause.message, 3);
      return 3;
    }
    if (cause instanceof NeonCredentialError) {
      reportFailure(structured, command, cause.code, cause.message, 6);
      return 6;
    }
    // Executable project code can throw arbitrary strings or credentials. Never print it by default.
    if (cause instanceof ProcedureUpgradeError) {
      const message =
        "Durable work blocks activation. Drain the retained release or add validated mappings in kello/upgrade.ts.";
      console.error(
        structured
          ? JSON.stringify({
              ok: false,
              command,
              error: { code: "DURABLE_UPGRADE_BLOCKED", message, inventory: cause.inventory },
              exitCode: 5,
            })
          : `DURABLE_UPGRADE_BLOCKED: ${message}\n${JSON.stringify(cause.inventory, null, 2)}`,
      );
      return 5;
    }
    if (command === "arguments") {
      reportFailure(structured, command, "USAGE", "Invalid arguments; run kello --help", 2);
      return 2;
    }
    if (command === "provision") {
      reportFailure(
        structured,
        command,
        "PROVISIONING_FAILED",
        "Branch provisioning failed. Check the declaration, provider access and saved receipt; retain the same identity for retry.",
        5,
      );
      return 5;
    }
    if (command.startsWith("realtime ")) {
      reportFailure(
        structured,
        command,
        "REALTIME_FAILED",
        "Realtime command failed. Check the linked target and provider access, then run kello realtime status.",
        5,
      );
      return 5;
    }
    if (command === "dev") {
      reportFailure(
        structured,
        command,
        "DEVELOPMENT_FAILED",
        "Development failed. Check the linked preview target, release declaration, environment and access before restarting.",
        5,
      );
      return 5;
    }
    if (command === "deploy") {
      reportFailure(
        structured,
        command,
        "DEPLOYMENT_FAILED",
        "Deployment failed. Check the release declaration, environment and saved receipts; retry with the same release identity.",
        5,
      );
      return 5;
    }
    if (command === "retire database") {
      reportFailure(
        structured,
        command,
        "RETIREMENT_FAILED",
        "Database retirement failed. Check the declaration, saved release, target access and remaining dependencies before retrying.",
        5,
      );
      return 5;
    }
    if (cause instanceof MigrationCommandError) {
      reportFailure(structured, command, cause.code, cause.message, 4);
      return 4;
    }
    if (databaseCommand) {
      reportFailure(
        structured,
        command,
        "MIGRATION_FAILED",
        "Migration operation failed. Inspect migration status, reviewed artifacts and database access.",
        4,
      );
      return 4;
    }
    reportFailure(
      structured,
      command,
      "PROJECT_INVALID",
      "Project validation failed. Check configuration, source imports, paths and existing files.",
      3,
    );
    return 3;
  }
}

function reportFailure(structured: boolean, command: string, code: string, message: string, exitCode: number): void {
  console.error(
    structured ? JSON.stringify({ ok: false, command, error: { code, message }, exitCode }) : `${code}: ${message}`,
  );
}

if (import.meta.main) process.exitCode = await runCli(process.argv.slice(2));
