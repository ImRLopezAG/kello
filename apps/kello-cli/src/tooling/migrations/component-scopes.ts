import { join } from "node:path";
import type pg from "pg";
import type { loadProject } from "../project/load";
import { componentNamespace } from "../project/component-namespace";
import { acquireMigrationLock, assertMigrationConnection, quoteIdentifier } from "./connection";
import type { SchemaDefinition } from "kello/server";
import type { NativeMigrationSchema } from "./adapter";

interface ProjectMigrationScope {
  readonly mountPath: string;
  readonly namespace: string;
  readonly migrations: string;
  readonly schema: SchemaDefinition | NativeMigrationSchema;
  readonly entityTables: readonly string[];
}

export function projectMigrationScopes(project: Awaited<ReturnType<typeof loadProject>>) {
  const scopes: ProjectMigrationScope[] = [
    {
      mountPath: "",
      namespace: project.config.database.namespace,
      migrations: project.config.database.migrations,
      schema: project.schema,
      entityTables: project.schema.metadata.entities.map((entity) => entity.sqlName),
    },
    ...project.componentScopes
      .filter((scope) => scope.schemaFile !== undefined || scope.schema.metadata.entities.length > 0)
      .map((scope) => ({
        mountPath: scope.mountPath,
        namespace: scope.namespace,
        migrations: join(project.config.database.migrations, "components", scope.namespace),
        schema: scope.schema,
        entityTables: scope.schema.metadata.entities.map((entity) => entity.sqlName),
      })),
    ...project.authScopes.map((scope) => ({
      mountPath: scope.mountPath,
      namespace: scope.namespace,
      migrations: join(project.config.database.migrations, "components", scope.namespace),
      schema: { namespace: scope.namespace, tables: scope.schema.ownedTables, retainRemoved: true },
      entityTables: [],
    })),
  ].sort((a, b) => a.namespace.localeCompare(b.namespace));
  if (new Set(scopes.map((scope) => scope.namespace)).size !== scopes.length)
    throw new Error("Application and component namespaces must be distinct");
  return scopes;
}

export async function reconcileComponentNamespaces(
  client: pg.Client,
  metadataNamespace: string,
  scopes: readonly { readonly mountPath: string; readonly namespace: string }[],
): Promise<void> {
  assertMigrationConnection(client);
  await acquireMigrationLock(client, "loom:component-ownership");
  const table = `${quoteIdentifier(metadataNamespace)}.component_namespaces`;
  const mounted = scopes.filter((scope) => scope.mountPath !== "");
  const paths = new Set<string>();
  const namespaces = new Set<string>();
  for (const scope of mounted) {
    if (
      scope.namespace !== componentNamespace(scope.mountPath) ||
      paths.has(scope.mountPath) ||
      namespaces.has(scope.namespace)
    )
      throw new Error("Component namespace identity collision");
    paths.add(scope.mountPath);
    namespaces.add(scope.namespace);
  }
  await client.query("BEGIN");
  try {
    for (const scope of mounted) {
      const existing = await client.query<{ mount_path: string; namespace: string }>(
        `SELECT mount_path,namespace FROM ${table} WHERE mount_path=$1 OR namespace=$2 FOR UPDATE`,
        [scope.mountPath, scope.namespace],
      );
      if (existing.rows.some((row) => row.mount_path !== scope.mountPath || row.namespace !== scope.namespace))
        throw new Error("Component namespace ownership cannot be reassigned");
      if (!existing.rowCount) {
        const catalog = await client.query("SELECT 1 FROM pg_namespace WHERE nspname=$1", [scope.namespace]);
        if (catalog.rowCount) throw new Error("Refusing unowned existing component namespace");
      }
      await client.query(
        `INSERT INTO ${table}(mount_path,namespace,state) VALUES($1,$2,'mounted') ON CONFLICT(mount_path) DO UPDATE SET state='mounted' WHERE ${table}.state <> 'mounted'`,
        [scope.mountPath, scope.namespace],
      );
    }
    await client.query(
      `UPDATE ${table} SET state='detached' WHERE state <> 'detached' AND NOT (mount_path=ANY($1::text[]))`,
      [[...paths]],
    );
    await client.query("COMMIT");
  } catch (cause) {
    await client.query("ROLLBACK");
    throw cause;
  }
}
