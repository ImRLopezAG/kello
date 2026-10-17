import { expect, test } from "bun:test";
import pg from "pg";
import { bootstrapSession, frameworkMigrations } from "../../../apps/kello/src/tooling/migrations/bootstrap";

// The integration runner supplies an admitted disposable PG18 target. Never create a local server.
const connectionString = process.env.LOOM_TEST_DATABASE_URL;

test("upgrade and fresh bootstrap retire only the selected metadata live engine", async () => {
  if (!connectionString) throw new Error("An admitted PostgreSQL integration target is required");
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const metadata = `loom_retire_${suffix}`;
  const fresh = `loom_fresh_${suffix}`;
  const application = `app_retire_${suffix}`;
  const role = `retire_${suffix}`;
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 5000 });
  await client.connect();
  try {
    await client.query("SET statement_timeout = '60s'");
    await client.query("SET lock_timeout = '5s'");
    await client.query(`CREATE SCHEMA "${metadata}"`);
    await client.query(`CREATE TABLE "${metadata}".framework_migrations (
      version integer PRIMARY KEY, hash text NOT NULL, applied_at timestamptz NOT NULL DEFAULT clock_timestamp())`);
    const history = frameworkMigrations(metadata).slice(0, 28);
    for (const migration of history) {
      await client.query(migration.statements.join(";\n"));
      await client.query(`INSERT INTO "${metadata}".framework_migrations(version,hash) VALUES($1,$2)`, [
        migration.version,
        migration.hash,
      ]);
    }
    await client.query(`CREATE SCHEMA "${application}"`);
    await client.query(`CREATE TABLE "${application}".tasks(id integer PRIMARY KEY, title text)`);
    await client.query(`INSERT INTO "${metadata}".table_revisions VALUES('${application}','tasks',1)`);
    await client.query(`CREATE TRIGGER loom_table_revision AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE
      ON "${application}".tasks FOR EACH STATEMENT EXECUTE FUNCTION "${metadata}".advance_table_revision()`);
    // Same historical name, different function: this trigger is not Kello's revision engine.
    await client.query(`CREATE TABLE "${application}".other(id integer)`);
    await client.query(`CREATE TABLE "${application}".audit(id integer)`);
    await client.query(`CREATE FUNCTION "${application}".audit_write() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN INSERT INTO "${application}".audit VALUES(NEW.id); RETURN NEW; END $$`);
    await client.query(`CREATE TRIGGER loom_table_revision AFTER INSERT ON "${application}".other
      FOR EACH ROW EXECUTE FUNCTION "${application}".audit_write()`);
    await client.query(`INSERT INTO "${application}".tasks VALUES(1,'before')`);
    const job = crypto.randomUUID();
    await client.query(
      `INSERT INTO "${metadata}".jobs
      (id,deployment,deduplication_key,fingerprint,call,identity,due_at,max_attempts,retry_delay_seconds,lease_version)
      VALUES($1,'preview','retained',$2,'{}','null',now(),1,0,$2)`,
      [job, "a".repeat(64)],
    );

    await bootstrapSession(client, metadata, role);
    await bootstrapSession(client, metadata, role);
    expect(
      (
        await client.query(`SELECT version,hash FROM "${metadata}".framework_migrations
      WHERE version <= 28 ORDER BY version`)
      ).rows,
    ).toEqual(history.map(({ version, hash }) => ({ version, hash })));
    expect(
      (await client.query(`SELECT max(version)::int AS version FROM "${metadata}".framework_migrations`)).rows,
    ).toEqual([{ version: 29 }]);
    for (const name of ["table_revisions", "connection_tickets"]) {
      expect((await client.query("SELECT to_regclass($1) AS object", [`${metadata}.${name}`])).rows).toEqual([
        { object: null },
      ]);
    }
    expect(
      (await client.query("SELECT to_regprocedure($1) AS object", [`${metadata}.advance_table_revision()`])).rows,
    ).toEqual([{ object: null }]);
    await client.query(`UPDATE "${application}".tasks SET title='after' WHERE id=1`);
    await client.query(`INSERT INTO "${application}".other VALUES(2)`);
    expect((await client.query(`SELECT * FROM "${application}".tasks`)).rows).toEqual([{ id: 1, title: "after" }]);
    expect((await client.query(`SELECT * FROM "${application}".audit`)).rows).toEqual([{ id: 2 }]);
    expect((await client.query(`SELECT id,state FROM "${metadata}".jobs WHERE id=$1`, [job])).rows).toEqual([
      { id: job, state: "pending" },
    ]);
    await bootstrapSession(client, fresh, role);
    expect((await client.query("SELECT to_regclass($1) AS object", [`${fresh}.table_revisions`])).rows).toEqual([
      { object: null },
    ]);
    expect((await client.query(`SELECT count(*)::int AS count FROM "${fresh}".framework_migrations`)).rows).toEqual([
      { count: 29 },
    ]);
  } finally {
    // Only this test's UUID scopes and role; do not touch other metadata or active deployments.
    try {
      await client.query("ROLLBACK");
      await client.query(`DROP SCHEMA IF EXISTS "${application}" CASCADE`);
      await client.query(`DROP SCHEMA IF EXISTS "${fresh}" CASCADE`);
      await client.query(`DROP SCHEMA IF EXISTS "${metadata}" CASCADE`);
      await client.query(`DROP ROLE IF EXISTS "${role}"`);
    } finally {
      await client.end();
    }
  }
}, 60000);
