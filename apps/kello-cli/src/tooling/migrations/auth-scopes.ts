import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type pg from "pg";
import type { loadProject } from "../project/load";
import { resolveProjectPath } from "../config/paths";
import type { MigrationSnapshot } from "./adapter";
import { getTableConfig } from "drizzle-orm/pg-core";

type Project = Awaited<ReturnType<typeof loadProject>>;

/** Externally owned plugin tables must exist before any owned migration is applied. */
export async function assertExternalAuthTables(client: pg.Client, project: Project): Promise<void> {
  for (const scope of project.authScopes) {
    for (const [name, table] of Object.entries(scope.schema.tables)) {
      if (scope.schema.ownedTables[name]) continue;
      const result = await client.query<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2",
        [scope.namespace, name],
      );
      const actual = new Set(result.rows.map((row) => row.column_name));
      if (getTableConfig(table).columns.some((column) => !actual.has(column.name)))
        throw new Error(
          `External Better Auth table is missing required columns: ${scope.mountPath}.${name}; provision it before migration`,
        );
    }
  }
}

/** This is planned ownership, not proof that SQL was applied. Migration history remains authoritative. */
export async function writeAuthOwnership(
  project: Project,
  mountPath: string,
  migrations: string,
  retained: MigrationSnapshot,
) {
  const scope = project.authScopes.find((entry) => entry.mountPath === mountPath);
  if (!scope) return;
  const directory = await resolveProjectPath(project.root, migrations);
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `.auth-ownership-${crypto.randomUUID()}.tmp`);
  await writeFile(
    temporary,
    JSON.stringify(
      {
        format: 1,
        mountPath,
        namespace: scope.namespace,
        runtimeFingerprint: scope.fingerprint,
        activeTables: Object.keys(scope.schema.ownedTables).sort(),
        retainedSnapshot: retained,
      },
      null,
      2,
    ) + "\n",
  );
  await rename(temporary, join(directory, ".auth-ownership.json"));
}
