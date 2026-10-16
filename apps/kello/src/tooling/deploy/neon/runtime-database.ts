import * as v from "valibot";
import { databaseIdentifier, withMigrationConnection } from "../../migrations/connection";
import type { DeploymentDatabaseIdentity } from "./connection";

export interface RuntimeDatabaseOptions {
  readonly connectionString: string;
  readonly database: DeploymentDatabaseIdentity;
  readonly runtimeRole: string;
  readonly namespace: string;
  readonly metadataNamespace: string;
  readonly signal?: AbortSignal;
}

/** Read-only credential preflight. The database identity must come from the verified deployment target. */
export async function inspectRuntimeDatabase(input: RuntimeDatabaseOptions) {
  try {
    const { signal, ...values } = input;
    const options = structuredClone(values);
    const database = v.parse(
      v.strictObject({
        endpointHost: v.pipe(v.string(), v.regex(/^[a-z0-9.-]+$/)),
        databaseName: databaseIdentifier,
      }),
      options.database,
    );
    const runtimeRole = v.parse(databaseIdentifier, options.runtimeRole);
    const namespace = v.parse(databaseIdentifier, options.namespace);
    const metadataNamespace = v.parse(v.pipe(databaseIdentifier, v.regex(/^loom_/)), options.metadataNamespace);
    if (namespace === metadataNamespace) throw new Error("Namespaces overlap");
    const address = new URL(options.connectionString);
    if (
      !["postgres:", "postgresql:"].includes(address.protocol) ||
      decodeURIComponent(address.username) !== runtimeRole ||
      address.hostname.replace(/-pooler(?=\.)/, "") !== database.endpointHost ||
      decodeURIComponent(address.pathname.slice(1)) !== database.databaseName ||
      ["host", "hostaddr", "port", "user", "password", "database", "dbname", "options", "connectionString"].some(
        (key) => address.searchParams.has(key),
      )
    )
      throw new Error("Connection mismatch");
    signal?.throwIfAborted();
    return await withMigrationConnection(options.connectionString, async (client) => {
      await client.query("BEGIN READ ONLY");
      // Runtime URLs may use transaction pooling, so settings must belong to this transaction.
      await client.query(
        "SET LOCAL search_path = pg_catalog; SET LOCAL statement_timeout = '60s'; SET LOCAL lock_timeout = '5s'",
      );
      const authority = await client.query<{ safe: boolean }>(
        `
        SELECT current_user = $1 AND session_user = $1 AND current_database() = $2
          AND NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)
          AND NOT EXISTS (SELECT 1 FROM pg_auth_members WHERE member = r.oid)
          AND NOT has_database_privilege(current_database(), 'CREATE')
          AND NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspowner = r.oid OR has_schema_privilege(oid, 'CREATE'))
          AND NOT EXISTS (SELECT 1 FROM pg_shdepend
            WHERE refclassid = 'pg_authid'::regclass AND refobjid = r.oid AND deptype = 'o'
              AND dbid IN (0, (SELECT oid FROM pg_database WHERE datname = current_database())))
          AND has_schema_privilege($3, 'USAGE') AND has_schema_privilege($4, 'USAGE') AS safe
        FROM pg_roles r WHERE rolname = current_user`,
        [runtimeRole, database.databaseName, namespace, metadataNamespace],
      );
      if (authority.rows.length !== 1 || authority.rows[0]?.safe !== true) throw new Error("Unsafe runtime authority");
      const metadata = await client.query<{
        relname: string;
        table_readable: boolean;
        readable: boolean;
        writable: boolean;
      }>(
        `
        SELECT c.relname, has_table_privilege(c.oid, 'SELECT') AS table_readable,
          (has_table_privilege(c.oid, 'SELECT') OR has_any_column_privilege(c.oid, 'SELECT')) AS readable,
          (has_table_privilege(c.oid, CASE WHEN c.relname='client_sessions' THEN 'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER' ELSE 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER' END)
            OR has_any_column_privilege(c.oid, CASE WHEN c.relname='client_sessions' THEN 'UPDATE,REFERENCES' ELSE 'INSERT,UPDATE,REFERENCES' END)) AS writable
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relkind = 'r'
          AND c.relname = ANY($2::text[])`,
        [
          metadataNamespace,
          [
            "deployment_activations",
            "deployment_trigger_bindings",
            "framework_migrations",
            "migration_history",
            "development_history",
            "nontransactional_migrations",
            "backfills",
            "backfill_rows",
            "runtime_compatibility",
            "runtime_scopes",
            "procedure_releases",
            "function_ownership",
            "release_ingress",
            "client_sessions",
            "deployment_secrets",
            "search_cursor_keys",
          ],
        ],
      );
      if (
        metadata.rows.length !== 16 ||
        metadata.rows.some(
          (row) =>
            row.writable ||
            (["deployment_secrets", "search_cursor_keys", "runtime_scopes"].includes(row.relname) && row.readable) ||
            (["deployment_activations", "deployment_trigger_bindings", "release_ingress"].includes(row.relname) &&
              !row.table_readable),
        )
      )
        throw new Error("Unsafe metadata access");
      const routing = await client.query<{ writable: boolean }>(
        `SELECT has_column_privilege(c.oid,'claim_version','INSERT,UPDATE,REFERENCES') AS writable
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname=$1 AND c.relname='jobs' AND c.relkind='r'`,
        [metadataNamespace],
      );
      if (routing.rows.length !== 1 || routing.rows[0]?.writable !== false)
        throw new Error("Runtime can change job routing");
      signal?.throwIfAborted();
      await client.query("ROLLBACK");
      return Object.freeze({
        ...database,
        runtimeRole,
        namespace,
        metadataNamespace,
        postgresVersion: 18 as const,
      });
    });
  } catch {
    throw new Error("Runtime database preflight failed");
  }
}
