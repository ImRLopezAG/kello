import assert from "node:assert/strict";
import { test } from "bun:test";
import pg from "pg";
import { bootstrapDatabase, inspectRuntimeDatabase } from "kello-cli";

const connectionString = process.env.LOOM_TEST_DATABASE_URL;
test.skipIf(!connectionString)("runtime preflight verifies actual credentials without granting authority", async () => {
  if (!connectionString) throw new Error("Missing database");
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const namespace = `app_${suffix}`;
  const metadataNamespace = `loom_${suffix}`;
  const runtimeRole = `runtime_${suffix}`;
  const otherRole = `other_${suffix}`;
  const admin = new pg.Client({ connectionString });
  await admin.connect();
  const runtime = new URL(connectionString);
  runtime.username = runtimeRole;
  runtime.password = "preflight-test-secret";
  const options = {
    connectionString: runtime.href,
    namespace,
    metadataNamespace,
    runtimeRole,
    database: { endpointHost: runtime.hostname, databaseName: decodeURIComponent(runtime.pathname.slice(1)) },
  };
  const refused = /^Error: Runtime database preflight failed$/;
  try {
    await bootstrapDatabase({ connectionString, metadataNamespace, runtimeRole });
    await admin.query(`ALTER ROLE "${runtimeRole}" LOGIN PASSWORD 'preflight-test-secret'`);
    await admin.query(`CREATE ROLE "${otherRole}" NOLOGIN`);
    await admin.query(`CREATE SCHEMA "${namespace}"`);
    await admin.query(`GRANT USAGE ON SCHEMA "${namespace}" TO "${runtimeRole}"`);
    await admin.query(`CREATE TABLE "${namespace}".items (id integer)`);
    await admin.query(`CREATE TYPE "${namespace}".status AS ENUM ('open')`);
    await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON "${namespace}".items TO "${runtimeRole}"`);
    assert.deepEqual(await inspectRuntimeDatabase(options), {
      ...options.database,
      runtimeRole,
      namespace,
      metadataNamespace,
      postgresVersion: 18,
    });
    for (const [grant, revoke] of [
      [`ALTER ROLE "${runtimeRole}" BYPASSRLS`, `ALTER ROLE "${runtimeRole}" NOBYPASSRLS`],
      [`ALTER ROLE "${runtimeRole}" CREATEDB`, `ALTER ROLE "${runtimeRole}" NOCREATEDB`],
      [`ALTER ROLE "${runtimeRole}" CREATEROLE`, `ALTER ROLE "${runtimeRole}" NOCREATEROLE`],
      [`ALTER ROLE "${runtimeRole}" REPLICATION`, `ALTER ROLE "${runtimeRole}" NOREPLICATION`],
      [`ALTER ROLE "${runtimeRole}" SUPERUSER`, `ALTER ROLE "${runtimeRole}" NOSUPERUSER`],
      [
        `ALTER TYPE "${namespace}".status OWNER TO "${runtimeRole}"`,
        `ALTER TYPE "${namespace}".status OWNER TO CURRENT_USER`,
      ],
      [
        `GRANT "${otherRole}" TO "${runtimeRole}" WITH INHERIT FALSE, SET FALSE`,
        `REVOKE "${otherRole}" FROM "${runtimeRole}"`,
      ],
      [
        `GRANT CREATE ON SCHEMA "${namespace}" TO "${runtimeRole}"`,
        `REVOKE CREATE ON SCHEMA "${namespace}" FROM "${runtimeRole}"`,
      ],
      [`GRANT CREATE ON SCHEMA "${namespace}" TO PUBLIC`, `REVOKE CREATE ON SCHEMA "${namespace}" FROM PUBLIC`],
      [
        `ALTER TABLE "${namespace}".items OWNER TO "${runtimeRole}"`,
        `ALTER TABLE "${namespace}".items OWNER TO CURRENT_USER`,
      ],
      [
        `GRANT SELECT (token) ON "${metadataNamespace}".deployment_secrets TO "${runtimeRole}"`,
        `REVOKE SELECT (token) ON "${metadataNamespace}".deployment_secrets FROM "${runtimeRole}"`,
      ],
      [
        `GRANT SELECT (key) ON "${metadataNamespace}".search_cursor_keys TO "${runtimeRole}"`,
        `REVOKE SELECT (key) ON "${metadataNamespace}".search_cursor_keys FROM "${runtimeRole}"`,
      ],
      [
        `GRANT SELECT (namespace) ON "${metadataNamespace}".runtime_scopes TO "${runtimeRole}"`,
        `REVOKE SELECT (namespace) ON "${metadataNamespace}".runtime_scopes FROM "${runtimeRole}"`,
      ],
      [
        `GRANT UPDATE (state) ON "${metadataNamespace}".deployment_activations TO "${runtimeRole}"`,
        `REVOKE UPDATE (state) ON "${metadataNamespace}".deployment_activations FROM "${runtimeRole}"`,
      ],
      [
        `GRANT INSERT ON "${metadataNamespace}".migration_history TO "${runtimeRole}"`,
        `REVOKE INSERT ON "${metadataNamespace}".migration_history FROM "${runtimeRole}"`,
      ],
      [
        `GRANT UPDATE (hash) ON "${metadataNamespace}".nontransactional_migrations TO "${runtimeRole}"`,
        `REVOKE UPDATE (hash) ON "${metadataNamespace}".nontransactional_migrations FROM "${runtimeRole}"`,
      ],
      [
        `GRANT UPDATE (processed) ON "${metadataNamespace}".backfills TO "${runtimeRole}"`,
        `REVOKE UPDATE (processed) ON "${metadataNamespace}".backfills FROM "${runtimeRole}"`,
      ],
      [
        `GRANT DELETE ON "${metadataNamespace}".backfill_rows TO "${runtimeRole}"`,
        `REVOKE DELETE ON "${metadataNamespace}".backfill_rows FROM "${runtimeRole}"`,
      ],
      [
        `REVOKE SELECT ON "${metadataNamespace}".release_ingress FROM "${runtimeRole}"`,
        `GRANT SELECT ON "${metadataNamespace}".release_ingress TO "${runtimeRole}"`,
      ],
      [
        `GRANT UPDATE (state) ON "${metadataNamespace}".release_ingress TO "${runtimeRole}"`,
        `REVOKE UPDATE (state) ON "${metadataNamespace}".release_ingress FROM "${runtimeRole}"`,
      ],
      [
        `GRANT UPDATE (version) ON "${metadataNamespace}".function_ownership TO "${runtimeRole}"`,
        `REVOKE UPDATE (version) ON "${metadataNamespace}".function_ownership FROM "${runtimeRole}"`,
      ],
      [
        `GRANT UPDATE (expires_at) ON "${metadataNamespace}".client_sessions TO "${runtimeRole}"`,
        `REVOKE UPDATE (expires_at) ON "${metadataNamespace}".client_sessions FROM "${runtimeRole}"`,
      ],
      [
        `GRANT DELETE ON "${metadataNamespace}".client_sessions TO "${runtimeRole}"`,
        `REVOKE DELETE ON "${metadataNamespace}".client_sessions FROM "${runtimeRole}"`,
      ],
      [
        `GRANT UPDATE (maximum_ordinal) ON "${metadataNamespace}".runtime_compatibility TO "${runtimeRole}"`,
        `REVOKE UPDATE (maximum_ordinal) ON "${metadataNamespace}".runtime_compatibility FROM "${runtimeRole}"`,
      ],
      [
        `REVOKE SELECT ON "${metadataNamespace}".deployment_activations FROM "${runtimeRole}"`,
        `GRANT SELECT ON "${metadataNamespace}".deployment_activations TO "${runtimeRole}"`,
      ],
      [
        `REVOKE USAGE ON SCHEMA "${namespace}" FROM "${runtimeRole}"`,
        `GRANT USAGE ON SCHEMA "${namespace}" TO "${runtimeRole}"`,
      ],
    ] as const) {
      await admin.query(grant);
      try {
        await assert.rejects(inspectRuntimeDatabase(options), refused);
      } finally {
        await admin.query(revoke);
      }
      await inspectRuntimeDatabase(options);
    }
    await admin.query(`REVOKE SELECT ON "${metadataNamespace}".deployment_activations FROM "${runtimeRole}"`);
    await admin.query(`GRANT SELECT (state) ON "${metadataNamespace}".deployment_activations TO "${runtimeRole}"`);
    try {
      await assert.rejects(inspectRuntimeDatabase(options), refused);
    } finally {
      await admin.query(`REVOKE SELECT (state) ON "${metadataNamespace}".deployment_activations FROM "${runtimeRole}"`);
      await admin.query(`GRANT SELECT ON "${metadataNamespace}".deployment_activations TO "${runtimeRole}"`);
    }
    await inspectRuntimeDatabase(options);
    await assert.rejects(inspectRuntimeDatabase({ ...options, connectionString }), refused);
    const invalidPassword = new URL(runtime);
    invalidPassword.password = "wrong-preflight-secret";
    await assert.rejects(inspectRuntimeDatabase({ ...options, connectionString: invalidPassword.href }), refused);
    await assert.rejects(inspectRuntimeDatabase({ ...options, runtimeRole: otherRole }), refused);
    await assert.rejects(
      inspectRuntimeDatabase({ ...options, connectionString: `${runtime.href}?options=-crole=postgres` }),
      refused,
    );
    await assert.rejects(
      inspectRuntimeDatabase({ ...options, database: { ...options.database, databaseName: "other" } }),
      refused,
    );
    await assert.rejects(
      inspectRuntimeDatabase({ ...options, connectionString: "postgres://invalid:secret@127.0.0.1:1/missing" }),
      refused,
    );
    const signal = AbortSignal.abort();
    await assert.rejects(inspectRuntimeDatabase({ ...options, signal }), refused);
    assert.equal(
      (await admin.query(`SELECT count(*) FROM "${metadataNamespace}".deployment_activations`)).rows[0].count,
      "0",
    );
  } finally {
    await admin.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
    await admin.query(`DROP SCHEMA IF EXISTS "${metadataNamespace}" CASCADE`);
    await admin.query(`DROP ROLE IF EXISTS "${runtimeRole}"`);
    await admin.query(`DROP ROLE IF EXISTS "${otherRole}"`);
    await admin.end();
  }
});
