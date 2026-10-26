import { mkdir, open, link, rm, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import * as v from "valibot";
import { loadProject, loadProjectConfig } from "../project/load";
import { resolveProjectPath } from "../config/paths";
import { readMigrations } from "./history";
import { createSnapshot, snapshotHash } from "./adapter";
import { MigrationCommandError } from "./project";
import {
  createBackfillPlan,
  validateBackfillPlan,
  backfillPlanValidator,
  runBackfill,
  backfillStatus,
} from "./backfill";

export async function generateProjectBackfill(
  root: string,
  name: string,
  table: string,
  sqlFile: string,
  batchSize = 500,
) {
  const project = await loadProject(root);
  const head = (await readMigrations(project.root, project.config.database.migrations)).at(-1);
  if (!head || snapshotHash(await createSnapshot(project.schema)) !== head.plan.after)
    throw new MigrationCommandError("UNGENERATED_SCHEMA");
  const plan = await createBackfillPlan({
    name,
    table,
    namespace: project.config.database.namespace,
    migrationHash: head.plan.hash,
    batchSize,
    sql: await readFile(await resolveProjectPath(project.root, sqlFile), "utf8"),
  });
  const relative = `backfills/${plan.name}.json`;
  const path = await resolveProjectPath(project.root, relative);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(plan, null, 2) + "\n");
      await file.sync();
    } finally {
      await file.close();
    }
    // Linking publishes the complete file without overwriting an existing reviewed plan.
    await link(temporary, path);
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await rm(temporary, { force: true });
  }
  return { file: relative, plan };
}

async function readProjectBackfill(root: string, file: string) {
  return validateBackfillPlan(
    v.parse(backfillPlanValidator, JSON.parse(await readFile(await resolveProjectPath(root, file), "utf8"))),
  );
}

export async function projectBackfillStatus(root: string, file: string) {
  const { config } = await loadProjectConfig(root);
  const connectionString = process.env[config.database.migrationUrlEnv];
  if (!connectionString) throw new MigrationCommandError("MISSING_CONNECTION");
  return backfillStatus({
    connectionString,
    namespace: config.database.namespace,
    metadataNamespace: config.database.metadataNamespace,
    plan: await readProjectBackfill(root, file),
  });
}

export async function applyProjectBackfill(
  root: string,
  file: string,
  options: {
    readonly runtimeRole: string;
    readonly reviewedHash: string;
    readonly maxBatches?: number;
    readonly signal?: AbortSignal;
  },
) {
  const project = await loadProject(root);
  const connectionString = process.env[project.config.database.migrationUrlEnv];
  if (!connectionString) throw new MigrationCommandError("MISSING_CONNECTION");
  const head = (await readMigrations(project.root, project.config.database.migrations)).at(-1);
  if (!head || snapshotHash(await createSnapshot(project.schema)) !== head.plan.after)
    throw new MigrationCommandError("UNGENERATED_SCHEMA");
  return runBackfill({
    ...options,
    connectionString,
    root: project.root,
    migrations: project.config.database.migrations,
    namespace: project.config.database.namespace,
    metadataNamespace: project.config.database.metadataNamespace,
    sourceVersion: project.version,
    plan: await readProjectBackfill(project.root, file),
  });
}
