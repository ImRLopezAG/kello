import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";
import * as v from "valibot";
import { databaseIdentifier, quoteIdentifier, withMigrationConnection } from "./connection";
import { classifyFrameworkHistory } from "./framework-history";

const bootstrapOptions = v.strictObject({
  connectionString: v.string(),
  metadataNamespace: v.optional(v.pipe(databaseIdentifier, v.regex(/^loom_/)), "loom_meta"),
  runtimeRole: databaseIdentifier,
});
export type BootstrapOptions = v.InferInput<typeof bootstrapOptions>;

export function managedRuntimeRoleMarker(metadataNamespace: string): string {
  return `loom-runtime-v1:${createHash("sha256").update(metadataNamespace).digest("hex")}`;
}

function frameworkStatements(namespace: string): readonly string[] {
  const schema = quoteIdentifier(namespace);
  return [
    `CREATE TABLE ${schema}.migration_history (
      namespace text NOT NULL, ordinal integer NOT NULL CHECK (ordinal > 0), name text NOT NULL,
      hash text NOT NULL CHECK (hash ~ '^[a-f0-9]{64}$'),
      before_hash text NOT NULL, after_hash text NOT NULL, catalog_hash text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (namespace, ordinal), UNIQUE (namespace, hash)
    )`,
  ];
}
export function frameworkMigrations(namespace: string) {
  const schema = quoteIdentifier(namespace);
  const versions = [
    frameworkStatements(namespace),
    [
      `CREATE TABLE ${schema}.development_history (
      namespace text NOT NULL, ordinal integer NOT NULL CHECK (ordinal > 0),
      source_version text NOT NULL CHECK (source_version ~ '^[a-f0-9]{64}$'),
      project_id text NOT NULL, branch_id text NOT NULL, endpoint_id text NOT NULL,
      artifact_hash text NOT NULL CHECK (artifact_hash ~ '^[a-f0-9]{64}$'),
      artifact jsonb NOT NULL CHECK (jsonb_typeof(artifact) = 'object'),
      before_catalog_hash text NOT NULL, after_catalog_hash text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (namespace, ordinal)
    )`,
    ],
    [
      `CREATE TABLE ${schema}.mutation_results (
      scope_hash text NOT NULL CHECK (scope_hash ~ '^[a-f0-9]{64}$'),
      key_hash text NOT NULL CHECK (key_hash ~ '^[a-f0-9]{64}$'),
      fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
      result jsonb NOT NULL, expires_at timestamptz NOT NULL,
      PRIMARY KEY (scope_hash, key_hash)
    )`,
    ],
    [
      `CREATE TABLE ${schema}.connection_tickets (
      deployment text NOT NULL CHECK (length(deployment) BETWEEN 1 AND 256),
      ticket_hash text NOT NULL CHECK (ticket_hash ~ '^[a-f0-9]{64}$'),
      origin text NOT NULL,
      identity jsonb NOT NULL CHECK (jsonb_typeof(identity) = 'object'),
      session_expires_at timestamptz NOT NULL,
      expires_at timestamptz NOT NULL CHECK (expires_at <= session_expires_at),
      PRIMARY KEY (deployment, ticket_hash)
    )`,
      `CREATE INDEX connection_tickets_expiry ON ${schema}.connection_tickets (expires_at)`,
    ],
    [
      `CREATE TABLE ${schema}.table_revisions (
      namespace text NOT NULL, table_name text NOT NULL,
      revision bigint NOT NULL CHECK (revision > 0),
      PRIMARY KEY (namespace, table_name)
    )`,
      `CREATE FUNCTION ${schema}.advance_table_revision() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $loom$
      BEGIN
        UPDATE ${schema}.table_revisions SET revision = revision + 1
        WHERE namespace = TG_TABLE_SCHEMA AND table_name = TG_TABLE_NAME;
        IF NOT FOUND THEN RAISE EXCEPTION 'Missing Loom table revision'; END IF;
        RETURN NULL;
      END
      $loom$`,
    ],
    [
      `CREATE TABLE ${schema}.jobs (
        id uuid PRIMARY KEY, deployment text NOT NULL CHECK (length(deployment) BETWEEN 1 AND 256),
        deduplication_key text NOT NULL CHECK (length(deduplication_key) BETWEEN 1 AND 256),
        fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
        call jsonb NOT NULL CHECK (jsonb_typeof(call) = 'object'),
        identity jsonb NOT NULL, due_at timestamptz NOT NULL,
        state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'running', 'succeeded', 'failed', 'cancelled')),
        attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0 AND attempts <= max_attempts),
        max_attempts integer NOT NULL CHECK (max_attempts BETWEEN 1 AND 10),
        retry_delay_seconds integer NOT NULL CHECK (retry_delay_seconds BETWEEN 0 AND 3600),
        lease_owner text, lease_expires_at timestamptz,
        fencing_token bigint NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
        cancel_requested boolean NOT NULL DEFAULT FALSE,
        result jsonb NOT NULL DEFAULT 'null'::jsonb, error_code text,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        UNIQUE (deployment, deduplication_key),
        CHECK ((state = 'running') = (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL))
      )`,
      `CREATE INDEX jobs_due ON ${schema}.jobs (deployment, due_at, id) WHERE state = 'pending'`,
      `CREATE INDEX jobs_expired ON ${schema}.jobs (deployment, lease_expires_at, id) WHERE state = 'running'`,
    ],
    [
      `CREATE TABLE ${schema}.job_replays (
        job_id uuid NOT NULL REFERENCES ${schema}.jobs (id), deployment text NOT NULL,
        fencing_token bigint NOT NULL CHECK (fencing_token >= 0), attempts integer NOT NULL CHECK (attempts >= 0),
        error_code text, result jsonb NOT NULL, due_at timestamptz NOT NULL,
        replayed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        PRIMARY KEY (job_id, fencing_token)
      )`,
    ],
    [
      `CREATE TABLE ${schema}.trigger_receipts (
        deployment text NOT NULL, invocation_id text NOT NULL, trigger_id text NOT NULL,
        trigger_name text NOT NULL, scheduled_at timestamptz NOT NULL,
        kind text NOT NULL CHECK (kind IN ('cron', 'wake')),
        fingerprint text NOT NULL, job_id uuid REFERENCES ${schema}.jobs (id),
        received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        PRIMARY KEY (deployment, invocation_id),
        CHECK ((kind = 'cron') = (job_id IS NOT NULL))
      )`,
    ],
    [
      `CREATE TABLE ${schema}.deployment_activations (
        deployment text NOT NULL, version text NOT NULL CHECK (version ~ '^[a-f0-9]{64}$'),
        project_id text NOT NULL, branch_id text NOT NULL, endpoint_host text NOT NULL, database_name text NOT NULL,
        token_hash text NOT NULL CHECK (token_hash ~ '^[a-f0-9]{64}$'),
        state text NOT NULL DEFAULT 'quarantined' CHECK (state IN ('quarantined', 'active')),
        updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        PRIMARY KEY (deployment, version)
      )`,
    ],
    [
      `CREATE TABLE ${schema}.storage_intents (
        id uuid PRIMARY KEY DEFAULT uuidv7(),
        deployment text NOT NULL, project_id text NOT NULL, branch_id text NOT NULL,
        owner_hash text NOT NULL CHECK (owner_hash ~ '^[a-f0-9]{64}$'),
        owner_identity jsonb NOT NULL CHECK (jsonb_typeof(owner_identity) = 'object'),
        request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
        fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
        upload jsonb NOT NULL CHECK (jsonb_typeof(upload) = 'object'),
        state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'ready', 'failed')),
        error_code text CHECK (error_code IN ('VERIFICATION_FAILED', 'EXPIRED')),
        upload_expires_at timestamptz NOT NULL DEFAULT clock_timestamp() + interval '5 minutes',
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        UNIQUE (deployment, project_id, branch_id, owner_hash, request_hash),
        CHECK ((state = 'failed') = (error_code IS NOT NULL))
      )`,
      `CREATE INDEX storage_intents_pending ON ${schema}.storage_intents (upload_expires_at, id) WHERE state = 'pending'`,
    ],
    [
      `ALTER TABLE ${schema}.storage_intents ADD COLUMN event_job_id uuid REFERENCES ${schema}.jobs (id)`,
      `CREATE TABLE ${schema}.storage_receipts (
        deployment text NOT NULL, project_id text NOT NULL, branch_id text NOT NULL,
        invocation_id text NOT NULL, trigger_id text NOT NULL, trigger_name text NOT NULL,
        bucket text NOT NULL, object_key text NOT NULL, intent_id uuid NOT NULL REFERENCES ${schema}.storage_intents (id),
        fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
        state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'dispatched', 'failed')),
        job_id uuid REFERENCES ${schema}.jobs (id), received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        PRIMARY KEY (deployment, project_id, branch_id, invocation_id),
        CHECK ((state = 'dispatched') = (job_id IS NOT NULL))
      )`,
    ],
    [
      `ALTER TABLE ${schema}.storage_intents ADD COLUMN cleanup_after timestamptz`,
      `UPDATE ${schema}.storage_intents SET cleanup_after = upload_expires_at + interval '24 hours'`,
      `ALTER TABLE ${schema}.storage_intents ALTER COLUMN cleanup_after SET NOT NULL, ALTER COLUMN cleanup_after SET DEFAULT clock_timestamp() + interval '24 hours 5 minutes'`,
      `CREATE INDEX storage_intents_cleanup ON ${schema}.storage_intents (deployment, project_id, branch_id, cleanup_after, id)`,
    ],
    [
      `CREATE TABLE ${schema}.nontransactional_migrations (
        namespace text PRIMARY KEY, ordinal integer NOT NULL CHECK (ordinal > 0),
        hash text NOT NULL CHECK (hash ~ '^[a-f0-9]{64}$'),
        before_catalog_hash text NOT NULL CHECK (before_catalog_hash ~ '^[a-f0-9]{64}$'),
        started_at timestamptz NOT NULL DEFAULT clock_timestamp()
      )`,
    ],
    [
      `CREATE TABLE ${schema}.backfills (
        namespace text NOT NULL, name text NOT NULL,
        hash text NOT NULL CHECK (hash ~ '^[a-f0-9]{64}$'),
        catalog_hash text NOT NULL CHECK (catalog_hash ~ '^[a-f0-9]{64}$'),
        state text NOT NULL DEFAULT 'running' CHECK (state IN ('running','complete')),
        total bigint NOT NULL DEFAULT 0 CHECK (total >= 0),
        processed bigint NOT NULL DEFAULT 0 CHECK (processed >= 0),
        deleted bigint NOT NULL DEFAULT 0 CHECK (deleted >= 0),
        last_key uuid, updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        PRIMARY KEY(namespace,name), CHECK (processed + deleted <= total)
      )`,
      `CREATE TABLE ${schema}.backfill_rows (
        namespace text NOT NULL, name text NOT NULL, row_id uuid NOT NULL,
        PRIMARY KEY(namespace,name,row_id),
        FOREIGN KEY(namespace,name) REFERENCES ${schema}.backfills(namespace,name) ON DELETE CASCADE
      )`,
    ],
    [
      `CREATE TABLE ${schema}.runtime_compatibility (
        namespace text NOT NULL, deployment text NOT NULL,
        version text NOT NULL CHECK (version ~ '^[a-f0-9]{64}$'),
        source_schema text NOT NULL CHECK (source_schema ~ '^[a-f0-9]{64}$'),
        minimum_ordinal integer NOT NULL CHECK (minimum_ordinal >= 0),
        maximum_ordinal integer NOT NULL CHECK (maximum_ordinal >= minimum_ordinal),
        migration_hashes jsonb NOT NULL CHECK (jsonb_typeof(migration_hashes)='array'),
        PRIMARY KEY(namespace,deployment,version)
      )`,
    ],
    [
      `CREATE TABLE ${schema}.function_ownership (
        project_id text NOT NULL, branch_id text NOT NULL, slug text NOT NULL CHECK (slug ~ '^[a-z0-9]{1,20}$'),
        deployment text NOT NULL, version text NOT NULL CHECK (version ~ '^[a-f0-9]{64}$'),
        role text NOT NULL CHECK (role IN ('service','worker')),
        PRIMARY KEY(project_id,branch_id,slug)
      )`,
    ],
    [
      `CREATE TABLE ${schema}.release_ingress (
        project_id text NOT NULL, branch_id text NOT NULL, deployment text NOT NULL,
        release_key text NOT NULL CHECK (release_key ~ '^[a-f0-9]{64}$'),
        version text NOT NULL CHECK (version ~ '^[a-f0-9]{64}$'),
        state text NOT NULL CHECK (state IN ('candidate','current','retired')),
        PRIMARY KEY(project_id,branch_id,deployment,release_key)
      )`,
      `CREATE UNIQUE INDEX release_ingress_current ON ${schema}.release_ingress(project_id,branch_id,deployment) WHERE state='current'`,
    ],
    [
      `ALTER TABLE ${schema}.storage_receipts ADD COLUMN reconcile_after timestamptz NOT NULL DEFAULT clock_timestamp()`,
      `CREATE INDEX storage_receipts_pending ON ${schema}.storage_receipts(deployment,project_id,branch_id,reconcile_after,invocation_id) WHERE state='pending'`,
    ],
    [
      `ALTER TABLE ${schema}.connection_tickets ADD COLUMN namespace text, ADD COLUMN version text`,
      `CREATE TABLE ${schema}.client_sessions (
        namespace text NOT NULL, deployment text NOT NULL,
        version text NOT NULL CHECK (version ~ '^[a-f0-9]{64}$'),
        ticket_hash text NOT NULL CHECK (ticket_hash ~ '^[a-f0-9]{64}$'),
        expires_at timestamptz NOT NULL,
        PRIMARY KEY(namespace,deployment,ticket_hash)
      )`,
      `CREATE INDEX client_sessions_expiry ON ${schema}.client_sessions(namespace,expires_at)`,
    ],
    [
      `ALTER TABLE ${schema}.deployment_activations
        DROP CONSTRAINT deployment_activations_state_check,
        ADD CONSTRAINT deployment_activations_state_check CHECK (state IN ('quarantined','active','retired'))`,
    ],
    [
      `CREATE TABLE ${schema}.deployment_trigger_bindings (
        deployment text NOT NULL, version text NOT NULL,
        project_id text NOT NULL, branch_id text NOT NULL,
        bindings jsonb NOT NULL CHECK (jsonb_typeof(bindings) = 'object'),
        PRIMARY KEY (deployment, version, project_id, branch_id),
        FOREIGN KEY (deployment, version) REFERENCES ${schema}.deployment_activations(deployment, version)
      )`,
    ],
    [
      `CREATE OR REPLACE FUNCTION ${schema}.advance_table_revision() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $loom$
      BEGIN
        UPDATE ${schema}.table_revisions SET revision = revision + 1
        WHERE namespace = TG_TABLE_SCHEMA AND table_name = TG_TABLE_NAME;
        IF NOT FOUND THEN RAISE EXCEPTION 'Missing Loom table revision'; END IF;
        PERFORM pg_notify('loom_revision_' || md5('${namespace}.' || TG_TABLE_SCHEMA), '1');
        RETURN NULL;
      END
      $loom$`,
    ],
    [
      `ALTER TABLE ${schema}.jobs
        ADD COLUMN claim_version text CHECK (claim_version ~ '^[a-f0-9]{64}$'),
        ADD COLUMN lease_version text CHECK (lease_version ~ '^[a-f0-9]{64}$')`,
      `CREATE TABLE ${schema}.procedure_releases (
        deployment text NOT NULL, version text NOT NULL CHECK (version ~ '^[a-f0-9]{64}$'),
        protocol text NOT NULL CHECK (protocol IN ('loom-legacy-1','loom-orpc-2')),
        migrations jsonb NOT NULL CHECK (jsonb_typeof(migrations) = 'array'),
        PRIMARY KEY (deployment,version)
      )`,
      `CREATE FUNCTION ${schema}.fence_migrated_job_claim() RETURNS trigger
      LANGUAGE plpgsql SET search_path = pg_catalog AS $loom$
      BEGIN
        IF NEW.state = 'running' AND NEW.fencing_token > OLD.fencing_token
          AND OLD.claim_version IS NOT NULL AND (NEW.lease_version IS DISTINCT FROM OLD.claim_version
            OR current_setting('loom.worker_version', true) IS DISTINCT FROM OLD.claim_version)
        THEN RAISE EXCEPTION 'Job belongs to a different runtime version'; END IF;
        RETURN NEW;
      END
      $loom$`,
      `CREATE TRIGGER fence_migrated_job_claim BEFORE UPDATE ON ${schema}.jobs
        FOR EACH ROW EXECUTE FUNCTION ${schema}.fence_migrated_job_claim()`,
    ],
  ];
  versions.push([
    `CREATE TABLE ${schema}.deployment_secrets (
      project_id text NOT NULL, branch_id text NOT NULL, deployment text NOT NULL,
      version text NOT NULL CHECK (version ~ '^[a-f0-9]{64}$'), runtime_role text NOT NULL,
      token text NOT NULL CHECK (token ~ '^[a-f0-9]{64}$'),
      PRIMARY KEY (project_id, branch_id, deployment, version)
    )`,
  ]);
  versions.push([
    `CREATE TABLE ${schema}.component_namespaces (
      mount_path text PRIMARY KEY, namespace text NOT NULL UNIQUE,
      state text NOT NULL CHECK (state IN ('mounted','detached')),
      CHECK (octet_length(namespace) <= 63)
    )`,
    `CREATE TABLE ${schema}.runtime_scopes (
      deployment text NOT NULL, version text NOT NULL, namespace text NOT NULL,
      PRIMARY KEY (deployment,version,namespace)
    )`,
  ]);
  versions.push([
    `ALTER TABLE ${schema}.storage_intents ADD COLUMN owner_scope text CHECK (octet_length(owner_scope) <= 8192)`,
  ]);
  versions.push([
    `CREATE TABLE ${schema}.search_cursor_keys (
      project_id text NOT NULL, branch_id text NOT NULL,
      key text NOT NULL CHECK (key ~ '^[a-f0-9]{64}$'),
      PRIMARY KEY (project_id, branch_id)
    )`,
  ]);
  versions.push([
    `CREATE TABLE ${schema}.rate_limit_policies (
      application_namespace text NOT NULL CHECK (octet_length(application_namespace) BETWEEN 1 AND 256),
      mount_path text NOT NULL CHECK (octet_length(mount_path) <= 256),
      policy_name text NOT NULL CHECK (policy_name ~ '^[A-Za-z][A-Za-z0-9_.-]{0,63}$'),
      version integer NOT NULL CHECK (version > 0),
      mode text NOT NULL CHECK (mode IN ('quota','attempt')),
      scope text NOT NULL CHECK (scope IN ('user','tenant','userInTenant')),
      limit_count integer NOT NULL CHECK (limit_count BETWEEN 1 AND 1000000),
      window_ms integer NOT NULL CHECK (window_ms BETWEEN 1000 AND 86400000),
      fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
      PRIMARY KEY (application_namespace,mount_path,policy_name,version)
    )`,
    `CREATE TABLE ${schema}.rate_limit_buckets (
      application_namespace text NOT NULL, mount_path text NOT NULL,
      policy_name text NOT NULL, version integer NOT NULL,
      key_digest bytea NOT NULL CHECK (octet_length(key_digest) = 32),
      count integer NOT NULL CHECK (count BETWEEN 0 AND 1000000),
      window_start_ms bigint NOT NULL CHECK (window_start_ms BETWEEN 0 AND 9007199254740991),
      window_end_ms bigint NOT NULL CHECK (window_end_ms BETWEEN window_start_ms AND 9007199254740991),
      last_observed_ms bigint NOT NULL CHECK (last_observed_ms BETWEEN window_start_ms AND 9007199254740991),
      cleanup_after_ms bigint NOT NULL CHECK (cleanup_after_ms BETWEEN window_end_ms AND 9007199254740991),
      PRIMARY KEY (application_namespace,mount_path,policy_name,version,key_digest),
      FOREIGN KEY (application_namespace,mount_path,policy_name,version)
        REFERENCES ${schema}.rate_limit_policies (application_namespace,mount_path,policy_name,version)
    )`,
    `CREATE INDEX rate_limit_buckets_cleanup ON ${schema}.rate_limit_buckets (cleanup_after_ms)`,
  ]);
  versions.push([
    // Select by both the historical trigger name and the selected metadata function.
    // A foreign dependency refuses DROP FUNCTION rather than being removed by CASCADE.
    `DO $kello_retire$
    DECLARE owned record;
    BEGIN
      FOR owned IN
        SELECT n.nspname AS namespace, c.relname AS relation, t.tgname AS trigger
        FROM pg_catalog.pg_trigger t
        JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE NOT t.tgisinternal AND t.tgname = 'loom_table_revision'
          AND t.tgfoid = pg_catalog.to_regprocedure('${schema}.advance_table_revision()')
      LOOP
        EXECUTE pg_catalog.format('DROP TRIGGER %I ON %I.%I', owned.trigger, owned.namespace, owned.relation);
      END LOOP;
    END
    $kello_retire$`,
    `DROP FUNCTION IF EXISTS ${schema}.advance_table_revision()`,
    `DROP TABLE IF EXISTS ${schema}.table_revisions`,
    `DROP TABLE IF EXISTS ${schema}.connection_tickets`,
  ]);
  return versions.map((statements, index) => ({
    version: index + 1,
    statements,
    hash: createHash("sha256").update(JSON.stringify(statements)).digest("hex"),
  }));
}

/** Caller owns the session; this function owns one transaction and its bootstrap lock. */
export async function bootstrapSession(
  client: pg.Client,
  metadataNamespace: string,
  runtimeRole: string,
  options: { readonly requireManagedRole?: boolean } = {},
): Promise<void> {
  const schema = quoteIdentifier(metadataNamespace);
  const role = quoteIdentifier(runtimeRole);
  await client.query("BEGIN");
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('loom:bootstrap', 0))");
    const existingRole = await client.query<{ unsafe: boolean; marker: string | null }>(
      `SELECT
      rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR rolname = current_user
      OR pg_has_role(oid, current_user, 'MEMBER')
      OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member = pg_roles.oid)
      AS unsafe, shobj_description(oid, 'pg_authid') AS marker FROM pg_roles WHERE rolname = $1`,
      [runtimeRole],
    );
    if (existingRole.rows[0]?.unsafe)
      throw new Error("Runtime role must not have migration or administrative authority");
    if (
      options.requireManagedRole &&
      existingRole.rows[0] &&
      existingRole.rows[0].marker !== managedRuntimeRoleMarker(metadataNamespace)
    )
      throw new Error(
        "Automatic credentials require a Kello-managed runtime role; supply explicit credentials for an existing role",
      );
    if (!existingRole.rows.length) {
      await client.query(
        // Neon cannot schema-copy passwordless legacy roles. This random, discarded
        // password permits copying while NOLOGIN still prevents authentication.
        `CREATE ROLE ${role} NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${randomBytes(32).toString("hex")}'`,
      );
      await client.query(`COMMENT ON ROLE ${role} IS '${managedRuntimeRoleMarker(metadataNamespace)}'`);
    }
    const namespaces = await client.query<{ owned: boolean }>(
      "SELECT nspowner = (SELECT oid FROM pg_roles WHERE rolname = current_user) AS owned FROM pg_namespace WHERE nspname = $1",
      [metadataNamespace],
    );
    if (namespaces.rows[0] && !namespaces.rows[0].owned)
      throw new Error("Migration identity must own the metadata namespace");
    const created = namespaces.rows.length === 0;
    if (created) {
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`REVOKE ALL ON SCHEMA ${schema} FROM PUBLIC`);
      await client.query(
        `CREATE TABLE ${schema}.framework_migrations (version integer PRIMARY KEY, hash text NOT NULL, applied_at timestamptz NOT NULL DEFAULT clock_timestamp())`,
      );
    }
    const relations = await client.query<{ framework: boolean; migrations: boolean }>(
      "SELECT to_regclass($1) IS NOT NULL AS framework, to_regclass($2) IS NOT NULL AS migrations",
      [`${schema}.framework_migrations`, `${schema}.migration_history`],
    );
    const frameworkHistoryExists = relations.rows[0]?.framework === true;
    const versions = frameworkHistoryExists
      ? (
          await client.query<{ version: number; hash: string }>(
            `SELECT version, hash FROM ${schema}.framework_migrations ORDER BY version`,
          )
        ).rows
      : [];
    const migrations = frameworkMigrations(metadataNamespace);
    const framework = classifyFrameworkHistory({
      metadataExists: !created,
      frameworkHistoryExists,
      migrationHistoryExists: relations.rows[0]?.migrations === true,
      applied: versions,
      expected: migrations,
    });
    if (framework.state === "diverged") {
      if (framework.reason === "gap-or-unsupported-version")
        throw new Error("Unsupported framework metadata version or gap");
      if (framework.reason === "hash-mismatch") throw new Error("Framework migration hash mismatch");
      throw new Error("Refusing unversioned or incomplete existing framework metadata");
    }
    const pending = migrations.slice(versions.length);
    if (pending.length) {
      // Framework-owned DDL already runs atomically. Batch its round trips so another
      // bootstrap does not exhaust the lock timeout while waiting on network latency.
      await client.query(pending.flatMap((migration) => migration.statements).join(";\n"));
      await client.query(
        `INSERT INTO ${schema}.framework_migrations (version, hash)
         SELECT version, hash FROM jsonb_to_recordset($1::jsonb) AS records(version integer, hash text)`,
        [JSON.stringify(pending.map(({ version, hash }) => ({ version, hash })))],
      );
    }
    await client.query(`REVOKE ALL ON SCHEMA ${schema} FROM PUBLIC, ${role}`);
    await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA ${schema} FROM PUBLIC, ${role}`);
    await client.query(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ${schema} FROM PUBLIC, ${role}`);
    await client.query(`REVOKE ALL (claim_version) ON ${schema}.jobs FROM PUBLIC, ${role}`);
    await client.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
    await client.query(`GRANT SELECT, INSERT ON ${schema}.mutation_results TO ${role}`);
    await client.query(`GRANT SELECT, INSERT ON ${schema}.client_sessions TO ${role}`);
    await client.query(`GRANT SELECT ON ${schema}.jobs, ${schema}.procedure_releases TO ${role}`);
    await client.query(
      `GRANT INSERT (id, deployment, deduplication_key, fingerprint, call, identity, due_at, state, attempts, max_attempts, retry_delay_seconds, lease_owner, lease_expires_at, fencing_token, cancel_requested, result, error_code, created_at, lease_version) ON ${schema}.jobs TO ${role}`,
    );
    await client.query(
      `GRANT UPDATE (deduplication_key, state, attempts, due_at, lease_owner, lease_expires_at, fencing_token, cancel_requested, result, error_code, lease_version) ON ${schema}.jobs TO ${role}`,
    );
    await client.query(`GRANT SELECT, INSERT ON ${schema}.job_replays TO ${role}`);
    await client.query(`GRANT SELECT, INSERT ON ${schema}.trigger_receipts TO ${role}`);
    await client.query(`GRANT SELECT ON ${schema}.deployment_activations TO ${role}`);
    await client.query(`GRANT SELECT ON ${schema}.deployment_trigger_bindings TO ${role}`);
    await client.query(`GRANT SELECT ON ${schema}.release_ingress TO ${role}`);
    await client.query(`GRANT SELECT ON ${schema}.rate_limit_policies TO ${role}`);
    await client.query(`GRANT SELECT, INSERT ON ${schema}.rate_limit_buckets TO ${role}`);
    await client.query(
      `GRANT UPDATE (count, window_start_ms, window_end_ms, last_observed_ms, cleanup_after_ms) ON ${schema}.rate_limit_buckets TO ${role}`,
    );
    await client.query(`GRANT SELECT, INSERT ON ${schema}.storage_intents TO ${role}`);
    await client.query(
      `GRANT UPDATE (state, error_code, updated_at, event_job_id, cleanup_after) ON ${schema}.storage_intents TO ${role}`,
    );
    await client.query(`GRANT SELECT, INSERT ON ${schema}.storage_receipts TO ${role}`);
    await client.query(`GRANT UPDATE (state, job_id, reconcile_after) ON ${schema}.storage_receipts TO ${role}`);
    await client.query("COMMIT");
  } catch (cause) {
    await client.query("ROLLBACK");
    throw cause;
  }
}

export async function bootstrapDatabase(options: BootstrapOptions): Promise<void> {
  const config = v.parse(bootstrapOptions, options);
  await withMigrationConnection(config.connectionString, (client) =>
    bootstrapSession(client, config.metadataNamespace, config.runtimeRole),
  );
}
