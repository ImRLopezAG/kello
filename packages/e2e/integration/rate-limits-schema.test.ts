import assert from "node:assert/strict";
import { test } from "bun:test";
import pg from "pg";
import { bootstrapDatabase, frameworkMigrations } from "../../../apps/kello/src/tooling/migrations/bootstrap";

const connectionString = process.env.LOOM_TEST_DATABASE_URL;
if (!connectionString) throw new Error("Rate-limit schema acceptance requires disposable PostgreSQL 18");

test("rate-limit metadata appends once, upgrades without rewriting history, and restricts runtime grants", async () => {
  const namespace = `loom_limit_schema_${crypto.randomUUID().replaceAll("-", "")}`;
  const runtimeRole = `${namespace}_rt`;
  const owner = new pg.Client({ connectionString });
  await owner.connect();
  let runtime: pg.Client | undefined;
  try {
    assert.equal(
      Math.floor(Number((await owner.query("SHOW server_version_num")).rows[0].server_version_num) / 10000),
      18,
    );
    const options = { connectionString: connectionString!, metadataNamespace: namespace, runtimeRole };
    await bootstrapDatabase(options);
    assert.equal(frameworkMigrations("loom_meta").length, 29);
    assert.equal(
      frameworkMigrations("loom_meta")[26]!.hash,
      "f50a24458564feb24a4db10d1bebd0414c583f6b7d1f4cfc689623bf675bc9f3",
    );
    const history = (
      await owner.query(`SELECT version,hash,applied_at FROM "${namespace}".framework_migrations ORDER BY version`)
    ).rows;
    await bootstrapDatabase(options);
    assert.deepEqual(
      (await owner.query(`SELECT version,hash,applied_at FROM "${namespace}".framework_migrations ORDER BY version`))
        .rows,
      history,
    );
    await owner.query(`DROP TABLE "${namespace}".rate_limit_buckets, "${namespace}".rate_limit_policies`);
    // Reconstruct the immutable pre-rate-limit prefix; later migrations must replay too.
    await owner.query(`DELETE FROM "${namespace}".framework_migrations WHERE version>=28`);
    await owner.query(`CREATE TABLE "${namespace}".business_sentinel (value text NOT NULL)`);
    await owner.query(`INSERT INTO "${namespace}".business_sentinel VALUES ('preserve')`);
    await bootstrapDatabase(options);
    assert.deepEqual(
      (await owner.query(`SELECT version,hash FROM "${namespace}".framework_migrations ORDER BY version`)).rows,
      history.map(({ version, hash }) => ({ version, hash })),
    );
    assert.deepEqual(
      (
        await owner.query(
          `SELECT version,hash,applied_at FROM "${namespace}".framework_migrations WHERE version<=27 ORDER BY version`,
        )
      ).rows,
      history.slice(0, 27),
    );
    assert.deepEqual((await owner.query(`SELECT value FROM "${namespace}".business_sentinel`)).rows, [
      { value: "preserve" },
    ]);
    const policy = `"${namespace}".rate_limit_policies`;
    const buckets = `"${namespace}".rate_limit_buckets`;
    const values = ["app", "", "write", 1, "quota", "user", 10, 1000, "a".repeat(64)];
    const insert = `INSERT INTO ${policy} (application_namespace,mount_path,policy_name,version,mode,scope,limit_count,window_ms,fingerprint) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`;
    await owner.query(insert, values);
    for (const [index, value] of [
      [0, ""],
      [1, "x".repeat(257)],
      [2, "bad name"],
      [3, 0],
      [4, "other"],
      [5, "anonymous"],
      [6, 0],
      [7, 999],
      [8, "invalid"],
    ] as const) {
      const invalid = [...values];
      invalid[index] = value;
      await assert.rejects(owner.query(insert, invalid), { code: "23514" });
    }
    await assert.rejects(owner.query(`INSERT INTO ${policy} DEFAULT VALUES`), { code: "23502" });
    for (let index = 0; index < values.length; index++) {
      const invalid: (string | number | null)[] = [...values];
      invalid[index] = null;
      await assert.rejects(owner.query(insert, invalid), { code: "23502" });
    }
    await owner.query(`ALTER ROLE "${runtimeRole}" LOGIN PASSWORD 'disposable-schema-only'`);
    const url = new URL(connectionString!);
    url.username = runtimeRole;
    url.password = "disposable-schema-only";
    runtime = new pg.Client({ connectionString: url.href });
    await runtime.connect();
    assert.equal((await runtime.query(`SELECT * FROM ${policy}`)).rowCount, 1);
    await runtime.query(
      `INSERT INTO ${buckets} (application_namespace,mount_path,policy_name,version,key_digest,count,window_start_ms,window_end_ms,last_observed_ms,cleanup_after_ms) VALUES ('app','','write',1,$1,1,1000,2000,1000,86402000)`,
      [Buffer.alloc(32)],
    );
    await runtime.query(`UPDATE ${buckets} SET count=2,last_observed_ms=1001`);
    assert.equal((await runtime.query(`SELECT count FROM ${buckets}`)).rows[0].count, 2);
    for (const statement of [
      `DELETE FROM ${buckets}`,
      `TRUNCATE ${buckets}`,
      `UPDATE ${buckets} SET policy_name='other'`,
      `UPDATE ${policy} SET limit_count=100`,
      `DELETE FROM ${policy}`,
      `INSERT INTO ${policy} SELECT * FROM ${policy}`,
      `UPDATE "${namespace}".framework_migrations SET hash='x'`,
      `CREATE TABLE "${namespace}".forbidden (id integer)`,
    ]) {
      await assert.rejects(runtime.query(statement), { code: "42501" });
    }
    await assert.rejects(owner.query(`UPDATE ${buckets} SET count=-1`), { code: "23514" });
    await assert.rejects(owner.query(`UPDATE ${buckets} SET key_digest=$1`, [Buffer.alloc(31)]), { code: "23514" });
    await assert.rejects(owner.query(`UPDATE ${buckets} SET window_end_ms=999`), { code: "23514" });
    await assert.rejects(owner.query(`UPDATE ${buckets} SET cleanup_after_ms=1999`), { code: "23514" });
    for (const column of [
      "key_digest",
      "count",
      "window_start_ms",
      "window_end_ms",
      "last_observed_ms",
      "cleanup_after_ms",
    ]) {
      await assert.rejects(owner.query(`UPDATE ${buckets} SET ${column}=NULL`), { code: "23502" });
    }
    await assert.rejects(owner.query(`UPDATE ${buckets} SET policy_name='missing'`), { code: "23503" });
    const indexes = (
      await owner.query("SELECT indexdef FROM pg_indexes WHERE schemaname=$1 AND tablename='rate_limit_buckets'", [
        namespace,
      ])
    ).rows;
    assert.ok(indexes.some((row) => /\(cleanup_after_ms\)/.test(row.indexdef)));
  } finally {
    await runtime?.end();
    await owner.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
    await owner.query(`DROP ROLE IF EXISTS "${runtimeRole}"`);
    await owner.end();
  }
});
