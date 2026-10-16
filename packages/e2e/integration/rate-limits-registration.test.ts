import assert from "node:assert/strict";
import { afterAll, beforeAll, expect, test } from "bun:test";
import pg from "pg";
import { defineRateLimits } from "../../../apps/loom/src/core/server/rate-limits/policy";
import { bootstrapSession } from "../../../apps/loom/src/tooling/migrations/bootstrap";
import { quoteIdentifier } from "../../../apps/loom/src/tooling/migrations/connection";
import { registerRateLimitPolicies } from "../../../apps/loom/src/tooling/migrations/rate-limits";
import { componentNamespace } from "../../../apps/loom/src/tooling/project/component-namespace";

const connectionString = process.env.LOOM_TEST_DATABASE_URL;
if (!connectionString) throw new Error("Rate limit registration requires LOOM_TEST_DATABASE_URL (local PostgreSQL 18)");
const suffix = crypto.randomUUID().replaceAll("-", "");
const metadataNamespace = `rl_reg_${suffix}`;
const runtimeRole = `rl_role_${suffix}`;
const client = new pg.Client({ connectionString });
const table = `${quoteIdentifier(metadataNamespace)}.rate_limit_policies`;
const policy = { version: 1, mode: "quota", scope: "user", limit: 5, windowMs: 1000 } as const;
const definitions = defineRateLimits({ action: policy });
const input = { metadataNamespace, applicationNamespace: "app", scopes: [{ mountPath: "", definitions }] };

beforeAll(async () => {
  const url = new URL(connectionString);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new Error("Local database required");
  await client.connect();
  const version = await client.query("SHOW server_version_num");
  expect(Math.floor(Number(version.rows[0].server_version_num) / 10000)).toBe(18);
  await bootstrapSession(client, metadataNamespace, runtimeRole);
});
afterAll(async () => {
  await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(metadataNamespace)} CASCADE`);
  await client.query(`DROP ROLE IF EXISTS ${quoteIdentifier(runtimeRole)}`);
  await client.end();
});

test("two releases agree; version bumps and component mounts register independent identities", async () => {
  await registerRateLimitPolicies(client, input);
  await registerRateLimitPolicies(client, {
    ...input,
    scopes: [{ mountPath: "", definitions: defineRateLimits({ action: policy }) }],
  });
  await registerRateLimitPolicies(client, {
    ...input,
    scopes: [
      { mountPath: "", definitions: defineRateLimits({ action: { ...policy, version: 2 } }) },
      { mountPath: "one", definitions },
      { mountPath: "two", definitions },
    ],
  });
  expect((await client.query(`SELECT mount_path,version FROM ${table} ORDER BY mount_path,version`)).rows).toEqual([
    { mount_path: "", version: 1 },
    { mount_path: "", version: 2 },
    { mount_path: "one", version: 1 },
    { mount_path: "two", version: 1 },
  ]);
});

test("same version conflict is safe and rolls back every earlier new row", async () => {
  await registerRateLimitPolicies(client, input);
  await assert.rejects(
    registerRateLimitPolicies(client, {
      ...input,
      scopes: [
        {
          mountPath: "",
          definitions: defineRateLimits({
            earlier: policy,
            action: { ...policy, limit: 6 },
          }),
        },
      ],
    }),
    { message: "Rate limit policy configuration conflict" },
  );
  expect((await client.query(`SELECT * FROM ${table} WHERE policy_name='earlier'`)).rows).toHaveLength(0);
  expect(client.getTransactionStatus()).toBe("I");
});

test("all input validates before writes, including bounds and canonical definitions", async () => {
  const invalid = ["\0", "\uD800", "é".repeat(129)];
  for (const applicationNamespace of invalid) {
    await assert.rejects(registerRateLimitPolicies(client, { ...input, applicationNamespace }), {
      message: "Invalid rate limit registration input",
    });
  }
  await assert.rejects(
    registerRateLimitPolicies(client, {
      ...input,
      scopes: [
        { mountPath: "fresh", definitions },
        { mountPath: "broken", definitions: { ...definitions, fingerprint: "0".repeat(64) } },
      ],
    }),
    { message: "Invalid rate limit registration input" },
  );
  expect((await client.query(`SELECT * FROM ${table} WHERE mount_path='fresh'`)).rows).toHaveLength(0);
  for (const mountPath of invalid) {
    await assert.rejects(registerRateLimitPolicies(client, { ...input, scopes: [{ mountPath, definitions }] }), {
      message: "Invalid rate limit registration input",
    });
  }
  await assert.rejects(registerRateLimitPolicies(client, { ...input, metadataNamespace: 'bad"schema' }), {
    message: "Invalid rate limit registration input",
  });
});

test("128 policies and valid Unicode namespace boundaries remain supported", async () => {
  const policies = Object.fromEntries(Array.from({ length: 128 }, (_, index) => [`p${index}`, policy]));
  const bounded = defineRateLimits(policies);
  const applicationNamespace = "😀".repeat(64);
  await registerRateLimitPolicies(client, {
    ...input,
    applicationNamespace,
    scopes: [{ mountPath: "", definitions: bounded }],
  });
  expect(
    (
      await client.query(`SELECT count(*)::int AS count FROM ${table} WHERE application_namespace=$1`, [
        applicationNamespace,
      ])
    ).rows[0].count,
  ).toBe(128);
  await assert.rejects(
    registerRateLimitPolicies(client, {
      ...input,
      scopes: [
        {
          mountPath: "",
          definitions: {
            ...bounded,
            policies: { ...policies, excess: policy },
          },
        },
      ],
    }),
    { message: "Invalid rate limit registration input" },
  );
});

test("registration preserves existing buckets and removed policy rows", async () => {
  await registerRateLimitPolicies(client, input);
  const buckets = `${quoteIdentifier(metadataNamespace)}.rate_limit_buckets`;
  await client.query(
    `INSERT INTO ${buckets}
    (application_namespace,mount_path,policy_name,version,key_digest,count,window_start_ms,window_end_ms,last_observed_ms,cleanup_after_ms)
    VALUES ('app','','action',1,$1,3,1000,2000,1000,86402000)`,
    [Buffer.alloc(32)],
  );
  const before = (await client.query(`SELECT * FROM ${buckets}`)).rows;
  await registerRateLimitPolicies(client, { ...input, scopes: [{ mountPath: "", definitions: defineRateLimits({}) }] });
  await registerRateLimitPolicies(client, input);
  expect((await client.query(`SELECT * FROM ${buckets}`)).rows).toEqual(before);
});

test("stricter statement timeout survives registration and bounds a blocked insert", async () => {
  const blocker = new pg.Client({ connectionString });
  await blocker.connect();
  await client.query("SET statement_timeout='50ms'");
  await client.query("SET lock_timeout='25ms'");
  try {
    await blocker.query("BEGIN");
    await blocker.query(
      `INSERT INTO ${table}
      (application_namespace,mount_path,policy_name,version,mode,scope,limit_count,window_ms,fingerprint)
      VALUES ('app','','blocked',1,'quota','user',5,1000,$1)`,
      ["0".repeat(64)],
    );
    await assert.rejects(
      registerRateLimitPolicies(client, {
        ...input,
        scopes: [{ mountPath: "", definitions: defineRateLimits({ blocked: policy }) }],
      }),
      { code: "55P03" },
    );
    expect(client.getTransactionStatus()).toBe("I");
    expect((await client.query("SHOW statement_timeout")).rows[0].statement_timeout).toBe("50ms");
    expect((await client.query("SHOW lock_timeout")).rows[0].lock_timeout).toBe("25ms");
  } finally {
    await blocker.query("ROLLBACK");
    await blocker.end();
    await client.query("RESET statement_timeout");
    await client.query("RESET lock_timeout");
  }
});

test("active and aborted caller transactions are rejected without committing or rolling them back", async () => {
  await client.query("BEGIN");
  try {
    await assert.rejects(registerRateLimitPolicies(client, input), {
      message: "Rate limit registration requires an idle connection",
    });
    expect(client.getTransactionStatus()).toBe("T");
    await assert.rejects(client.query("SELECT 1/0"));
    await assert.rejects(registerRateLimitPolicies(client, input), {
      message: "Rate limit registration requires an idle connection",
    });
    // ErrorResponse may reject before ReadyForQuery updates pg's status. A
    // queued query proves the caller's aborted transaction remains intact.
    await assert.rejects(client.query("SELECT 1"), { code: "25P02" });
    expect(client.getTransactionStatus()).toBe("E");
  } finally {
    await client.query("ROLLBACK");
  }
});

test("cancellation while waiting for ownership rolls back and pooled clients retain no locks", async () => {
  const blocker = new pg.Client({ connectionString });
  const pool = new pg.Pool({ connectionString, max: 1 });
  await blocker.connect();
  const pooled = await pool.connect();
  const controller = new AbortController();
  try {
    await blocker.query("SELECT pg_advisory_lock(hashtextextended('loom:component-ownership',0))");
    const pending = registerRateLimitPolicies(pooled, { ...input, signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(pending);
    expect(pooled.getTransactionStatus()).toBe("I");
    await blocker.query("SELECT pg_advisory_unlock_all()");
    await registerRateLimitPolicies(pooled, input);
    expect(
      (
        await pooled.query(
          "SELECT count(*)::int AS count FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory'",
        )
      ).rows[0].count,
    ).toBe(0);
  } finally {
    await blocker.end();
    pooled.release();
    await pool.end();
  }
});

test("caller session locks are reentrant and mounted namespace locks serialize registration", async () => {
  const blocker = new pg.Client({ connectionString });
  await blocker.connect();
  const namespaceKey = `loom:migrations:${componentNamespace("locked")}`;
  try {
    await client.query("SELECT pg_advisory_lock(hashtextextended($1,0))", ["loom:component-ownership"]);
    await client.query("SELECT pg_advisory_lock(hashtextextended($1,0))", ["loom:migrations:app"]);
    await registerRateLimitPolicies(client, input);
    expect(
      (
        await client.query(
          "SELECT count(*)::int AS count FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory'",
        )
      ).rows[0].count,
    ).toBe(2);
    await blocker.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [namespaceKey]);
    const controller = new AbortController();
    const pending = registerRateLimitPolicies(client, {
      ...input,
      scopes: [{ mountPath: "locked", definitions }],
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(pending);
    expect((await client.query(`SELECT * FROM ${table} WHERE mount_path='locked'`)).rows).toHaveLength(0);
  } finally {
    await client.query("SELECT pg_advisory_unlock_all()");
    await blocker.end();
  }
});
