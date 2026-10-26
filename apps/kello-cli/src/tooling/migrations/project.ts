import { bootstrapSession } from "./bootstrap";
import { assertExternalAuthTables, writeAuthOwnership } from "./auth-scopes";
import { acquireMigrationLock, withMigrationConnection } from "./connection";
import { projectMigrationScopes, reconcileComponentNamespaces } from "./component-scopes";
import { readFile } from "node:fs/promises";
import * as v from "valibot";
import { loadProject } from "../project/load";
import { resolveProjectPath } from "../config/paths";
import { emptySnapshot, createSnapshot, snapshotHash } from "./adapter";
import type { RenameHint } from "./adapter";
import { readMigrations, writeMigration, renameHintsValidator } from "./history";
import { planMigration } from "./planner";
import type { MigrationPlan } from "./planner";
import type { MigrationArtifact } from "./history";
import { migrationStatusOnConnection } from "./status";
import type { MigrationStatus } from "./status";
import { applyMigrationsOnConnection } from "./runner";
import type { MigrationReceipt } from "./runner";
import { planCustomMigration } from "./custom";
import type { MigrationMode } from "./custom";

export async function generateCustomRelease(
  root: string,
  name: string,
  filename: string,
  mode: MigrationMode,
): Promise<MigrationArtifact> {
  const project = await loadProject(root);
  const history = await readMigrations(project.root, project.config.database.migrations);
  const head = history.at(-1);
  const baseline = head?.plan.snapshot ?? (await emptySnapshot(project.config.database.namespace));
  const sql = await readFile(await resolveProjectPath(project.root, filename), "utf8");
  const plan = await planCustomMigration(baseline, project.schema, sql, mode, head?.plan.hash ?? null);
  return writeMigration(project.root, project.config.database.migrations, name, plan);
}

export async function readRenameHints(root: string, filename: string): Promise<readonly RenameHint[]> {
  return v.parse(renameHintsValidator, JSON.parse(await readFile(await resolveProjectPath(root, filename), "utf8")));
}

export async function planRelease(root: string, renames: readonly RenameHint[] = []): Promise<MigrationPlan> {
  const project = await loadProject(root);
  const history = await readMigrations(project.root, project.config.database.migrations);
  const baseline = history.at(-1)?.plan.snapshot ?? (await emptySnapshot(project.config.database.namespace));
  return planMigration(baseline, project.schema, renames, history.at(-1)?.plan.hash ?? null);
}

export async function generateRelease(
  root: string,
  name: string,
  renames: readonly RenameHint[] = [],
): Promise<
  MigrationArtifact & {
    readonly scopes: readonly {
      readonly mountPath: string;
      readonly namespace: string;
      readonly artifact: MigrationArtifact;
    }[];
  }
> {
  const project = await loadProject(root);
  const generated: { mountPath: string; namespace: string; artifact: MigrationArtifact }[] = [];
  for (const scope of projectMigrationScopes(project)) {
    const history = await readMigrations(project.root, scope.migrations);
    const baseline = history.at(-1)?.plan.snapshot ?? (await emptySnapshot(scope.namespace));
    const plan = await planMigration(
      baseline,
      scope.schema,
      scope.mountPath ? [] : renames,
      history.at(-1)?.plan.hash ?? null,
    );
    await writeAuthOwnership(project, scope.mountPath, scope.migrations, plan.snapshot);
    if (!plan.statements.length || plan.before === plan.after) continue;
    const artifact = await writeMigration(project.root, scope.migrations, name, plan);
    generated.push({ mountPath: scope.mountPath, namespace: scope.namespace, artifact });
  }
  const primary = generated.find((scope) => scope.mountPath === "") ?? generated[0];
  if (!primary) throw new Error("Migration has no structural change");
  return { ...primary.artifact, scopes: generated };
}

export class MigrationCommandError extends Error {
  constructor(
    readonly code: "MISSING_CONNECTION" | "UNGENERATED_SCHEMA" | "INCONSISTENT_DATABASE" | "REVIEW_REQUIRED",
  ) {
    const messages = {
      MISSING_CONNECTION:
        "Set the migration URL environment variable named in kello.config.ts before inspecting or applying database migrations",
      UNGENERATED_SCHEMA: "Generate and review migrations for the current schema before application",
      INCONSISTENT_DATABASE:
        "Migration stopped because database history or catalog state differs; inspect kello migrations status",
      REVIEW_REQUIRED:
        "Review the pending artifact hashes shown by kello migrations status, then pass --reviewed-hash for each reviewed change",
    };
    super(messages[code]);
    this.name = "MigrationCommandError";
  }
}

async function projectDatabase(root: string) {
  const project = await loadProject(root);
  const connectionString = process.env[project.config.database.migrationUrlEnv];
  if (!connectionString) throw new MigrationCommandError("MISSING_CONNECTION");
  return {
    project,
    options: {
      root: project.root,
      migrations: project.config.database.migrations,
      namespace: project.config.database.namespace,
      metadataNamespace: project.config.database.metadataNamespace,
      connectionString,
    },
  };
}

export async function projectMigrationStatus(
  root: string,
): Promise<
  MigrationStatus & { readonly components: readonly { readonly mountPath: string; readonly status: MigrationStatus }[] }
> {
  const { project, options } = await projectDatabase(root);
  return withMigrationConnection(options.connectionString, async (client) => {
    let application: MigrationStatus | undefined;
    const components: { mountPath: string; status: MigrationStatus }[] = [];
    for (const scope of projectMigrationScopes(project)) {
      const status = await migrationStatusOnConnection(client, {
        root: project.root,
        namespace: scope.namespace,
        migrations: scope.migrations,
        metadataNamespace: options.metadataNamespace,
      });
      if (scope.mountPath) components.push({ mountPath: scope.mountPath, status });
      else application = status;
    }
    if (!application) throw new Error("Application migration scope missing");
    return {
      ...application,
      components,
      consistent: application.consistent && components.every((entry) => entry.status.consistent),
      issues: [...new Set([...application.issues, ...components.flatMap((entry) => entry.status.issues)])],
    };
  });
}

export async function applyProjectMigrations(
  root: string,
  runtimeRole: string,
  reviewedHashes: readonly string[] = [],
  recoverNontransactional = false,
): Promise<MigrationReceipt & { readonly components: readonly MigrationReceipt[] }> {
  const { project, options } = await projectDatabase(root);
  const scopes = projectMigrationScopes(project);
  for (const scope of scopes) {
    const history = await readMigrations(project.root, scope.migrations);
    if (snapshotHash(await createSnapshot(scope.schema, history.at(-1)?.plan.snapshot)) !== history.at(-1)?.plan.after)
      throw new MigrationCommandError("UNGENERATED_SCHEMA");
  }
  return withMigrationConnection(options.connectionString, async (client) => {
    await acquireMigrationLock(client, "loom:component-ownership");
    await assertExternalAuthTables(client, project);
    for (const scope of scopes) await acquireMigrationLock(client, `loom:migrations:${scope.namespace}`);
    await bootstrapSession(client, options.metadataNamespace, runtimeRole);
    for (const scope of scopes) {
      const status = await migrationStatusOnConnection(client, {
        root: project.root,
        migrations: scope.migrations,
        namespace: scope.namespace,
        metadataNamespace: options.metadataNamespace,
      });
      if (
        status.issues.some(
          (issue) => !recoverNontransactional || (issue !== "LIVE_DRIFT" && issue !== "NONTRANSACTIONAL_IN_PROGRESS"),
        )
      )
        throw new MigrationCommandError("INCONSISTENT_DATABASE");
      if (status.pending.some((artifact) => !artifact.safety.automatic && !reviewedHashes.includes(artifact.hash)))
        throw new MigrationCommandError("REVIEW_REQUIRED");
    }
    await reconcileComponentNamespaces(client, options.metadataNamespace, scopes);
    let application: MigrationReceipt | undefined;
    const components: MigrationReceipt[] = [];
    for (const scope of scopes) {
      const receipt = await applyMigrationsOnConnection(client, {
        root: project.root,
        migrations: scope.migrations,
        namespace: scope.namespace,
        metadataNamespace: options.metadataNamespace,
        runtimeRole,
        reviewedHashes: [...reviewedHashes],
        recoverNontransactional,
        sourceVersion: project.version,
      });
      if (!scope.mountPath) application = receipt;
      else components.push(receipt);
    }
    if (!application) throw new Error("Application migration scope missing");
    return { ...application, components };
  });
}
