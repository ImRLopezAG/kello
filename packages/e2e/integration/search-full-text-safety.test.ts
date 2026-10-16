import assert from "node:assert/strict";
import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api-postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { bigint, index, pgSchema, text, uuid } from "drizzle-orm/pg-core";
import pg from "pg";
import { fullTextLocalTarget } from "./full-text-local-target";
import * as v from "valibot";
import { emptySnapshot, inspectSnapshot, snapshotHash } from "../../../apps/kello/src/tooling/migrations/adapter";
import type { MigrationSnapshot } from "../../../apps/kello/src/tooling/migrations/adapter";
import { assessMigration } from "../../../apps/kello/src/tooling/migrations/assessment";
import { withMigrationConnection } from "../../../apps/kello/src/tooling/migrations/connection";
import { catalogFingerprint } from "../../../apps/kello/src/tooling/migrations/drift";
import { readMigrations, validateMigration, writeMigration } from "../../../apps/kello/src/tooling/migrations/history";
import { migrationHash, planMigration } from "../../../apps/kello/src/tooling/migrations/planner";
import type { MigrationPlan } from "../../../apps/kello/src/tooling/migrations/planner";
import { applyMigrationsOnConnection } from "../../../apps/kello/src/tooling/migrations/runner";
import { inspectHistory, ormHistoryTable } from "../../../apps/kello/src/tooling/migrations/state";

function fixture(
  namespace: string,
  {
    gin = false,
    btree = true,
    config = "simple",
    weight = "A",
    bodyOnly = false,
    historicalSpelling = false,
    method = "gin",
    bodyBtree = false,
  }: {
    gin?: boolean;
    btree?: boolean;
    config?: "simple" | "english";
    weight?: "A" | "B";
    bodyOnly?: boolean;
    historicalSpelling?: boolean;
    method?: "gin" | "btree";
    bodyBtree?: boolean;
  } = {},
) {
  const documents = pgSchema(namespace).table(
    "documents",
    {
      _id: uuid()
        .primaryKey()
        .default(sql`uuidv7()`),
      _createdAt: bigint({ mode: "number" })
        .notNull()
        .default(sql`floor((EXTRACT(epoch FROM clock_timestamp()) * (1000)::numeric))`),
      title: text(),
      body: text(),
    },
    (t) => {
      const titleInput = historicalSpelling ? sql`COALESCE(${t.title}, ''::text)` : sql`coalesce(${t.title}, '')`;
      const bodyInput = historicalSpelling ? sql`COALESCE(${t.body}, ''::text)` : sql`coalesce(${t.body}, '')`;
      const titleVector = sql`setweight(to_tsvector(${sql.raw(`'pg_catalog.${config}'::regconfig`)}, ${titleInput}), ${sql.raw(`'${weight}'::"char"`)})`;
      const bodyVector = sql`setweight(to_tsvector(${sql.raw(`'pg_catalog.${config}'::regconfig`)}, ${bodyInput}), 'D'::"char")`;
      return [
        ...(btree ? [index("documents_title_idx").on(t.title)] : []),
        ...(bodyBtree ? [index("documents_body_idx").on(t.body)] : []),
        ...(gin
          ? [
              index("documents_search_idx").using(
                method,
                bodyOnly ? bodyVector : sql`(${titleVector} || ${bodyVector})`,
              ),
            ]
          : []),
      ];
    },
  );
  return { namespace, tables: { documents } };
}

async function nativeFixture(
  run: (context: {
    client: pg.Client;
    admin: pg.Client;
    connectionString: string;
    options: { root: string; migrations: string; namespace: string; metadataNamespace: string; runtimeRole: string };
  }) => Promise<void>,
) {
  const connectionString = fullTextLocalTarget(process.env.LOOM_TEST_DATABASE_URL);
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const root = await mkdtemp(join(tmpdir(), "kello-006-u2-native-"));
  const options = {
    root,
    migrations: "migrations",
    namespace: `fts_u2_${suffix}`,
    metadataNamespace: `loom_u2_${suffix}`,
    runtimeRole: `fts_u2_role_${suffix}`,
  };
  const admin = new pg.Client({ connectionString });
  await admin.connect();
  let ownedPid: number | undefined;
  let targetVerified = false;
  try {
    const version = (await admin.query("SHOW server_version")).rows[0].server_version;
    expect(Number((await admin.query("SHOW server_version_num")).rows[0].server_version_num)).toBe(180006);
    const database = (await admin.query("SELECT current_database() AS database")).rows[0].database;
    assert.equal(database, "kello_test");
    targetVerified = true;
    console.log("U2_NATIVE_TARGET", JSON.stringify({ version, database, namespace: options.namespace }));
    await withMigrationConnection(connectionString, async (client) => {
      ownedPid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      await run({ client, admin, connectionString, options });
    });
  } finally {
    try {
      if (targetVerified) {
        if (ownedPid !== undefined) {
          expect((await admin.query("SELECT locktype FROM pg_locks WHERE pid=$1", [ownedPid])).rows).toEqual([]);
          expect((await admin.query("SELECT pid FROM pg_stat_activity WHERE pid=$1", [ownedPid])).rows).toEqual([]);
        }
        await admin.query(`DROP SCHEMA IF EXISTS "${options.namespace}" CASCADE`);
        await admin.query(`DROP SCHEMA IF EXISTS "${options.metadataNamespace}" CASCADE`);
        await admin.query(`DROP ROLE IF EXISTS "${options.runtimeRole}"`);
        expect(
          (
            await admin.query("SELECT nspname FROM pg_namespace WHERE nspname=ANY($1::text[])", [
              [options.namespace, options.metadataNamespace],
            ])
          ).rows,
        ).toEqual([]);
        expect(
          (await admin.query("SELECT rolname FROM pg_roles WHERE rolname=$1", [options.runtimeRole])).rows,
        ).toEqual([]);
      }
    } finally {
      await admin.end();
      await rm(root, { recursive: true, force: true });
    }
  }
}

test("native runner denies historically automatic existing-table GIN without exact review", async () => {
  await nativeFixture(async ({ client, options }) => {
    const baseline = await planMigration(await emptySnapshot(options.namespace), fixture(options.namespace));
    await writeMigration(options.root, options.migrations, "baseline", baseline);
    expect((await applyMigrationsOnConnection(client, options)).applied).toEqual([baseline.hash]);
    await client.query(
      `INSERT INTO "${options.namespace}".documents (title, body) VALUES (NULL,NULL), ('title','body')`,
    );
    const addition = await planMigration(
      baseline.snapshot,
      fixture(options.namespace, { gin: true }),
      [],
      baseline.hash,
    );
    expect(addition.safety).toEqual({ automatic: true, transactional: true, issues: [] });
    await validateMigration(addition);
    const artifact = await writeMigration(options.root, options.migrations, "gin", addition);
    const saved = await artifactBytes(artifact.directory);
    const before = await catalogFingerprint(client, options.namespace);
    const assessment = await assessMigration(addition);
    expect(assessment.artifactHash).toBe(addition.hash);
    expect(assessment.safety.automatic).toBe(false);
    expect(assessment.safety.issues.map((issue) => issue.reason)).toContain("review-required");
    expect(assessment.blockingGinTimeout).toEqual({ eligible: true });
    expect(assessment.blockingGinOperations).toEqual([
      {
        id: JSON.stringify([options.namespace, "documents", "documents_search_idx", "create"]),
        schema: options.namespace,
        table: "documents",
        index: "documents_search_idx",
        kind: "create",
      },
    ]);
    await assert.rejects(applyMigrationsOnConnection(client, options), /requires review/);
    await assert.rejects(
      applyMigrationsOnConnection(client, { ...options, reviewedHashes: ["0".repeat(64)] }),
      /requires review/,
    );
    expect(await catalogFingerprint(client, options.namespace)).toBe(before);
    expect((await histories(client, options)).kello.map((row) => row.hash)).toEqual([baseline.hash]);
    expect(
      (await applyMigrationsOnConnection(client, { ...options, reviewedHashes: [addition.hash] })).applied,
    ).toEqual([addition.hash]);
    await assertGinCatalog(client, options.namespace);
    expect(
      (
        await planMigration(
          await inspectSnapshot(drizzle({ client }), options.namespace),
          fixture(options.namespace, { gin: true }),
          [],
          addition.hash,
        )
      ).statements,
    ).toEqual([]);
    expect((await applyMigrationsOnConnection(client, options)).applied).toEqual([]);
    expect(await artifactBytes(artifact.directory)).toEqual(saved);
    expect(migrationHash(addition)).toBe(addition.hash);
  });
}, 120_000);

async function artifactBytes(directory: string) {
  return Promise.all([
    readFile(join(directory, "plan.json"), "utf8"),
    readFile(join(directory, "migration.sql"), "utf8"),
  ]);
}

async function histories(client: pg.Client, options: { namespace: string; metadataNamespace: string }) {
  return {
    kello: (
      await client.query(
        `SELECT ordinal, name, hash, before_hash, after_hash, catalog_hash FROM "${options.metadataNamespace}".migration_history WHERE namespace=$1 ORDER BY ordinal`,
        [options.namespace],
      )
    ).rows,
    orm: (
      await client.query(
        `SELECT id, name, hash, created_at FROM "${options.metadataNamespace}"."${ormHistoryTable(options.namespace)}" ORDER BY id`,
      )
    ).rows,
  };
}

async function assertGinCatalog(client: pg.Client, namespace: string) {
  const rows = (
    await client.query(
      `SELECT c.relname, pg_get_indexdef(c.oid) AS definition, i.indisvalid, i.indisready, am.amname,
      pg_get_userbyid(c.relowner) AS owner, current_user AS expected_owner
     FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace
     JOIN pg_am am ON am.oid=c.relam WHERE n.nspname=$1 AND c.relname='documents_search_idx'`,
      [namespace],
    )
  ).rows;
  expect(rows).toHaveLength(1);
  expect(rows[0].amname).toBe("gin");
  expect(rows[0].indisvalid).toBe(true);
  expect(rows[0].indisready).toBe(true);
  expect(rows[0].owner).toBe(rows[0].expected_owner);
  expect(rows[0].definition).toContain("to_tsvector");
  console.log("U2_NATIVE_GIN_CATALOG", JSON.stringify(rows));
}

test("seven pre-U1 format-2 artifacts retain bytes and historical safety under current native admission", async () => {
  await nativeFixture(async ({ client, options }) => {
    let before: MigrationSnapshot = await emptySnapshot(options.namespace);
    let parent: string | null = null;
    const saved: { directory: string; plan: MigrationPlan; bytes: Awaited<ReturnType<typeof artifactBytes>> }[] = [];
    for (const [name, gin, config, weight, bodyOnly, historicalSpelling, method] of [
      ["no_fts", false, "simple", "A", false, true, "gin"],
      ["fts", true, "simple", "A", false, true, "gin"],
      ["config", true, "english", "A", false, true, "gin"],
      ["weight", true, "english", "B", false, true, "gin"],
      ["document", true, "english", "B", true, true, "gin"],
      ["spelling", true, "english", "B", true, false, "gin"],
      ["method", true, "english", "B", true, false, "btree"],
    ] as const) {
      const schema = fixture(options.namespace, { gin, config, weight, bodyOnly, historicalSpelling, method });
      const native = await generateDrizzleJson(
        { ...schema.tables, __loomNamespace: pgSchema(options.namespace) },
        before.id,
        [options.namespace],
      );
      const snapshot = { ...native, id: snapshotHash(native), prevIds: [before.id] };
      const automatic = { automatic: true, transactional: true, issues: [] } as const;
      const historicalSafety =
        name === "no_fts" || name === "fts"
          ? automatic
          : {
              automatic: false,
              transactional: true,
              issues: [
                {
                  entity: JSON.stringify(["indexes", options.namespace, "documents", "documents_search_idx"]),
                  reason: "review-required" as const,
                },
              ],
            };
      const content = {
        format: 2,
        parent,
        kind: "generated",
        before: snapshotHash(before),
        after: snapshotHash(snapshot),
        baseline: before,
        snapshot,
        statements: await generateMigration(before, snapshot),
        renames: [],
        safety: historicalSafety,
      } as const;
      const plan: MigrationPlan = { ...content, hash: migrationHash(content) };
      await validateMigration(plan);
      const artifact = await writeMigration(options.root, options.migrations, name, plan);
      saved.push({ directory: artifact.directory, plan, bytes: await artifactBytes(artifact.directory) });
      const assessment = await assessMigration(plan);
      expect(assessment.artifactHash).toBe(plan.hash);
      expect(plan.safety).toEqual(historicalSafety);
      expect(assessment.safety.automatic).toBe(name === "no_fts");
      if (!assessment.safety.automatic)
        await assert.rejects(applyMigrationsOnConnection(client, options), /requires review/);
      expect((await applyMigrationsOnConnection(client, { ...options, reviewedHashes: [plan.hash] })).applied).toEqual([
        plan.hash,
      ]);
      expect((await applyMigrationsOnConnection(client, options)).applied).toEqual([]);
      if (method === "gin") {
        const regenerated = await planMigration(
          await inspectSnapshot(drizzle({ client }), options.namespace),
          schema,
          [],
          plan.hash,
        );
        expect(regenerated.statements).toEqual([]);
        expect((await assessMigration(regenerated)).safety.automatic).toBe(true);
        expect((await assessMigration(regenerated)).blockingGinTimeout.eligible).toBe(false);
      }
      console.log(
        "U2_NATIVE_HISTORICAL",
        JSON.stringify({ name, hash: plan.hash, historical: plan.safety, effective: assessment.safety }),
      );
      before = snapshot;
      parent = plan.hash;
    }
    expect((await readMigrations(options.root, options.migrations)).map((artifact) => artifact.plan)).toEqual(
      saved.map((entry) => entry.plan),
    );
    for (const entry of saved) {
      await validateMigration(entry.plan);
      expect(migrationHash(entry.plan)).toBe(entry.plan.hash);
      expect(await artifactBytes(entry.directory)).toEqual(entry.bytes);
    }
    expect((await histories(client, options)).kello).toHaveLength(7);
    expect((await histories(client, options)).orm).toHaveLength(7);
  });
}, 120_000);

test("new-table GIN and unrelated B-tree retain automatic native admission", async () => {
  await nativeFixture(async ({ client, options }) => {
    const schema = fixture(options.namespace, { gin: true, btree: false });
    const initial = await planMigration(await emptySnapshot(options.namespace), schema);
    expect((await assessMigration(initial)).safety.automatic).toBe(true);
    expect((await assessMigration(initial)).blockingGinTimeout.eligible).toBe(false);
    await writeMigration(options.root, options.migrations, "initial", initial);
    expect((await applyMigrationsOnConnection(client, options)).applied).toEqual([initial.hash]);
    await assertGinCatalog(client, options.namespace);
    const btreeSchema = fixture(options.namespace, { gin: true, btree: true });
    const btree = await planMigration(initial.snapshot, btreeSchema, [], initial.hash);
    expect(btree.statements).toHaveLength(1);
    expect(btree.statements[0]).toContain('CREATE INDEX "documents_title_idx"');
    expect((await assessMigration(btree)).safety).toEqual(btree.safety);
    expect(btree.safety.automatic).toBe(true);
    expect((await assessMigration(btree)).blockingGinTimeout.eligible).toBe(false);
    await writeMigration(options.root, options.migrations, "btree", btree);
    expect((await applyMigrationsOnConnection(client, options)).applied).toEqual([btree.hash]);
    expect(
      (
        await client.query(
          `SELECT am.amname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_am am ON am.oid=c.relam WHERE n.nspname=$1 AND c.relname='documents_title_idx'`,
          [options.namespace],
        )
      ).rows,
    ).toEqual([{ amname: "btree" }]);
    const regenerated = await planMigration(
      await inspectSnapshot(drizzle({ client }), options.namespace),
      btreeSchema,
      [],
      btree.hash,
    );
    expect(regenerated.statements).toEqual([]);
    await assert.rejects(writeMigration(options.root, options.migrations, "noop", regenerated), /no structural change/);
    expect((await applyMigrationsOnConnection(client, options)).applied).toEqual([]);
  });
}, 120_000);

interface Settings {
  statement: string;
  lock: string;
}
interface QueryObservation {
  text: string;
  before: Settings | null;
  after: Settings | null;
  elapsedMs: number;
  code: string | undefined;
}

async function settings(client: pg.Client): Promise<Settings> {
  return (
    await client.query<Settings>(
      "SELECT current_setting('statement_timeout') AS statement, current_setting('lock_timeout') AS lock",
    )
  ).rows[0]!;
}

// Observe the real driver's promise queries; forward the original query config/parameters unchanged.
// Probes use the original driver method, never a replacement ORM/migrator. No probe runs in an
// aborted transaction until PostgreSQL has executed the real rollback/savepoint recovery.
function observeQueries(client: pg.Client) {
  const original = client.query.bind(client);
  const send = original;
  const observations: QueryObservation[] = [];
  let aborted = false;
  const probe = async (): Promise<Settings> => {
    const result = await send<Settings>(
      "SELECT current_setting('statement_timeout') AS statement, current_setting('lock_timeout') AS lock",
    );
    return result.rows[0]!;
  };
  // SAFETY: the owned native runner uses only promise query overloads; arguments and driver results are forwarded unchanged.
  client.query = (async (query: string | pg.QueryConfig, values?: unknown[]) => {
    const text = v.is(v.string(), query) ? query : query.text;
    const before = aborted ? null : await probe();
    const start = performance.now();
    let result;
    try {
      result = await send(query, values);
    } catch (cause) {
      aborted = true;
      observations.push({
        text,
        before,
        after: null,
        elapsedMs: performance.now() - start,
        code: cause instanceof Error && "code" in cause ? String(cause.code) : undefined,
      });
      throw cause;
    }
    const elapsedMs = performance.now() - start;
    aborted = false;
    observations.push({ text, before, after: await probe(), elapsedMs, code: undefined });
    return result;
  }) as pg.Client["query"];
  return {
    observations,
    restore: () => {
      client.query = original;
    },
  };
}

function postgresError(cause: unknown): { code: string; message: string } | undefined {
  if (!(cause instanceof Error)) return;
  if ("code" in cause && v.is(v.string(), cause.code)) return { code: cause.code, message: cause.message };
  return postgresError(cause.cause);
}

async function assertReleased(client: pg.Client, admin: pg.Client) {
  expect(await settings(client)).toEqual({ statement: "1min", lock: "5s" });
  const pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
  // Owned-session advisory locks intentionally live until the callback closes. Relation and
  // transaction locks from the aborted migration must already be gone on the still-owned client.
  expect(
    (await admin.query("SELECT locktype, mode FROM pg_locks WHERE pid=$1 AND locktype <> 'advisory'", [pid])).rows,
  ).toEqual([]);
  expect((await admin.query("SELECT state, xact_start FROM pg_stat_activity WHERE pid=$1", [pid])).rows).toEqual([
    { state: "idle", xact_start: null },
  ]);
}

function assertMigratorScope(
  observations: QueryObservation[],
  metadataNamespace: string,
  namespace: string,
  expected: Settings,
) {
  const setup = observations.findIndex((entry) =>
    entry.text.includes(`CREATE SCHEMA IF NOT EXISTS "${metadataNamespace}"`),
  );
  assert(setup >= 0, "Real native migrator schema setup was observed");
  const release = observations.findIndex((entry, index) => index > setup && /^release savepoint /i.test(entry.text));
  assert(release > setup, "Real native migrator nested savepoint release was observed");
  const scoped = observations.slice(setup, release + 1);
  for (const entry of scoped) {
    expect(entry.before).toEqual(expected);
    expect(entry.after).toEqual(expected);
  }
  const orm = ormHistoryTable(namespace);
  assert(
    scoped.some((entry) => /^select id, hash, created_at, name/i.test(entry.text) && entry.text.includes(orm)),
    "Native ORM history read shares the allowance",
  );
  assert(
    scoped.some((entry) => /^insert into /i.test(entry.text) && entry.text.includes(orm)),
    "Native ORM history insert shares the allowance",
  );
  assert(
    scoped.some((entry) => /^savepoint /i.test(entry.text)),
    "Allowance persists before native savepoint",
  );
  assert(
    scoped.some((entry) => /CREATE INDEX.*USING gin/is.test(entry.text)),
    "Real GIN creation shares the allowance",
  );
  const outer = observations.slice(release + 1);
  const firstRestored = outer.findIndex((entry) => entry.after?.statement === "1min");
  expect(firstRestored).toBe(0);
  expect(outer[0]?.before).toEqual(expected);
  assert(
    outer[0]?.text.includes("set_config('statement_timeout'"),
    "Restore is the first query after native migrator return",
  );
  for (const entry of outer.slice(firstRestored + 1)) {
    expect(entry.before).toEqual({ statement: "1min", lock: "5s" });
    expect(entry.after).toEqual({ statement: "1min", lock: "5s" });
  }
  assert(
    outer.some((entry) => /GRANT|CREATE TRIGGER|ALTER TABLE/i.test(entry.text)),
    "Real outer application protection executes",
  );
  assert(
    outer.some((entry) => /pg_catalog\.pg_class|pg_class/.test(entry.text)),
    "Real outer catalog inspection executes",
  );
  assert(
    outer.some((entry) => entry.text.includes("INSERT INTO") && entry.text.includes(".migration_history")),
    "Real outer Kello history insertion executes",
  );
}

test("real native GIN timeout rolls back, keeps the 5s lock limit, restores migrator scope and retries the same artifact", async () => {
  await nativeFixture(async ({ client, admin, options }) => {
    expect(await settings(client)).toEqual({ statement: "1min", lock: "5s" });
    const baselineSchema = fixture(options.namespace);
    const baseline = await planMigration(await emptySnapshot(options.namespace), baselineSchema);
    await writeMigration(options.root, options.migrations, "baseline", baseline);
    await applyMigrationsOnConnection(client, options);
    // Bounded real expression work: 6,000 rows, 128 body tokens/row. The short limit must
    // cancel CREATE INDEX itself, not a setup statement, lock wait, injected sleep or mock.
    await client.query(`INSERT INTO "${options.namespace}".documents (title, body)
      SELECT 'native document ' || g, repeat('bounded native expression rollback search title body token catalog proof artifact transaction postgres index vector document ', 8)
      FROM generate_series(1,6000) g`);
    await client.query(
      `INSERT INTO "${options.namespace}".documents (title, body) VALUES (NULL,NULL), ('nullable title',NULL), (NULL,'nullable body')`,
    );
    const targetSchema = fixture(options.namespace, { gin: true });
    const addition = await planMigration(baseline.snapshot, targetSchema, [], baseline.hash);
    expect(addition.statements).toHaveLength(1);
    expect((await assessMigration(addition)).blockingGinTimeout).toEqual({ eligible: true });
    const artifact = await writeMigration(options.root, options.migrations, "gin", addition);
    const bytes = await artifactBytes(artifact.directory);
    const beforeCatalog = await catalogFingerprint(client, options.namespace);
    const beforeHistory = await histories(client, options);
    const btreeOid = (
      await client.query("SELECT to_regclass($1)::oid AS oid", [`${options.namespace}.documents_title_idx`])
    ).rows[0].oid;
    const reviewed = { ...options, reviewedHashes: [addition.hash] };
    const override = (statementTimeoutMs: number) => ({
      ...reviewed,
      blockingGinTimeouts: [{ artifactHash: addition.hash, statementTimeoutMs }],
    });
    const assertBaseline = async () => {
      expect(await catalogFingerprint(client, options.namespace)).toBe(beforeCatalog);
      expect(await histories(client, options)).toEqual(beforeHistory);
      expect(
        (await client.query("SELECT to_regclass($1) AS index", [`${options.namespace}.documents_search_idx`])).rows[0]
          .index,
      ).toBeNull();
      expect(
        (await client.query("SELECT to_regclass($1)::oid AS oid", [`${options.namespace}.documents_title_idx`])).rows[0]
          .oid,
      ).toBe(btreeOid);
      expect(
        (await client.query(`SELECT count(*)::int AS count FROM "${options.namespace}".documents`)).rows[0].count,
      ).toBe(6003);
      expect(
        (await inspectHistory(client, options, await readMigrations(options.root, options.migrations))).issues,
      ).toEqual([]);
      expect(
        (await planMigration(await inspectSnapshot(drizzle({ client }), options.namespace), baselineSchema)).statements,
      ).toEqual([]);
      await assertReleased(client, admin);
    };

    const shortMs = 50;
    const finiteMs = 20_000;
    const observed = observeQueries(client);
    try {
      await assert.rejects(applyMigrationsOnConnection(client, override(shortMs)), (cause: unknown) => {
        const error = postgresError(cause);
        return error?.code === "57014" && /statement timeout/.test(error.message);
      });
      const failedBuild = observed.observations.find(
        (entry) => /CREATE INDEX.*USING gin/is.test(entry.text) && entry.code === "57014",
      );
      assert(failedBuild, "The actual GIN build, not setup or an artificial sleep, hit statement_timeout");
      expect(failedBuild.before).toEqual({ statement: "50ms", lock: "5s" });
      expect(failedBuild.elapsedMs).toBeGreaterThanOrEqual(shortMs - 5);
      const savepointRollback = observed.observations.find((entry) => /^rollback to savepoint /i.test(entry.text));
      expect(savepointRollback?.after).toEqual({ statement: "50ms", lock: "5s" });
      const outerRollback = observed.observations.find((entry) => /^rollback$/i.test(entry.text));
      expect(outerRollback?.after).toEqual({ statement: "1min", lock: "5s" });
      console.log("U2_NATIVE_STATEMENT_TIMEOUT", JSON.stringify(failedBuild));
      await assertBaseline();

      // Independent native connection owns a conflicting table lock. Keep it held through
      // the complete runner rejection; the 20s statement allowance cannot shorten the 5s cause.
      observed.observations.length = 0;
      await admin.query("BEGIN");
      try {
        await admin.query(`LOCK TABLE "${options.namespace}".documents IN SHARE ROW EXCLUSIVE MODE`);
        const started = performance.now();
        await assert.rejects(applyMigrationsOnConnection(client, override(finiteMs)), (cause: unknown) => {
          const error = postgresError(cause);
          return error?.code === "55P03" && /lock timeout/.test(error.message);
        });
        const elapsedMs = performance.now() - started;
        expect(elapsedMs).toBeGreaterThanOrEqual(4800);
        expect(elapsedMs).toBeLessThan(15_000);
        const failedLock = observed.observations.find(
          (entry) => /CREATE INDEX.*USING gin/is.test(entry.text) && entry.code === "55P03",
        );
        assert(failedLock, "Actual GIN creation must reach the conflicting relation lock");
        expect(failedLock.before).toEqual({ statement: "20s", lock: "5s" });
        expect(failedLock.elapsedMs).toBeGreaterThanOrEqual(4800);
        console.log("U2_NATIVE_LOCK_TIMEOUT", JSON.stringify({ ...failedLock, runnerElapsedMs: elapsedMs }));
      } finally {
        await admin.query("ROLLBACK");
      }
      await assertBaseline();

      observed.observations.length = 0;
      expect((await applyMigrationsOnConnection(client, override(finiteMs))).applied).toEqual([addition.hash]);
      assertMigratorScope(observed.observations, options.metadataNamespace, options.namespace, {
        statement: "20s",
        lock: "5s",
      });
      const build = observed.observations.find((entry) => /CREATE INDEX.*USING gin/is.test(entry.text));
      assert(build);
      expect(build.elapsedMs).toBeGreaterThan(shortMs);
      expect(build.elapsedMs).toBeLessThan(finiteMs);
      console.log(
        "U2_NATIVE_SUCCESS_SCOPE",
        JSON.stringify({
          hash: addition.hash,
          buildMs: build.elapsedMs,
          statementTimeoutMs: finiteMs,
          lockTimeoutMs: 5000,
          boundaries: observed.observations.filter((entry) =>
            /CREATE SCHEMA IF NOT EXISTS|savepoint|CREATE INDEX|select id, hash, created_at, name|insert into|INSERT INTO.*migration_history|set_config\('statement_timeout'/i.test(
              entry.text,
            ),
          ),
        }),
      );
      await assertReleased(client, admin);
      await assertGinCatalog(client, options.namespace);
      expect(
        (await client.query("SELECT to_regclass($1)::oid AS oid", [`${options.namespace}.documents_title_idx`])).rows[0]
          .oid,
      ).toBe(btreeOid);
      await client.query(
        `UPDATE "${options.namespace}".documents SET body='updated uniquelysearchable' WHERE title='nullable title'`,
      );
      expect(
        (
          await client.query(`SELECT count(*)::int AS count FROM "${options.namespace}".documents
        WHERE (setweight(to_tsvector('pg_catalog.simple'::regconfig, coalesce(title, '')), 'A'::"char") ||
        setweight(to_tsvector('pg_catalog.simple'::regconfig, coalesce(body, '')), 'D'::"char"))
        @@ plainto_tsquery('pg_catalog.simple'::regconfig, 'uniquelysearchable')`)
        ).rows[0].count,
      ).toBe(1);
      const afterHistory = await histories(client, options);
      expect(afterHistory.kello.map((row) => row.hash)).toEqual([baseline.hash, addition.hash]);
      expect(afterHistory.orm.map((row) => row.hash)).toEqual([baseline.hash, addition.hash]);
      expect(afterHistory.kello[1].catalog_hash).toBe(await catalogFingerprint(client, options.namespace));
      expect(
        (await inspectHistory(client, options, await readMigrations(options.root, options.migrations))).issues,
      ).toEqual([]);
      expect(
        (
          await planMigration(
            await inspectSnapshot(drizzle({ client }), options.namespace),
            targetSchema,
            [],
            addition.hash,
          )
        ).statements,
      ).toEqual([]);
      expect(await artifactBytes(artifact.directory)).toEqual(bytes);
      await assert.rejects(applyMigrationsOnConnection(client, override(finiteMs)), /pending|applied|unknown/i);

      // Subsequent unrelated native migration uses unchanged defaults on this same client.
      const subsequent = await planMigration(
        addition.snapshot,
        fixture(options.namespace, { gin: true, bodyBtree: true }),
        [],
        addition.hash,
      );
      expect((await assessMigration(subsequent)).safety.automatic).toBe(true);
      await writeMigration(options.root, options.migrations, "body_btree", subsequent);
      observed.observations.length = 0;
      expect((await applyMigrationsOnConnection(client, options)).applied).toEqual([subsequent.hash]);
      const btreeBuild = observed.observations.find((entry) =>
        entry.text.startsWith('CREATE INDEX "documents_body_idx"'),
      );
      expect(btreeBuild?.before).toEqual({ statement: "1min", lock: "5s" });
      expect(btreeBuild?.after).toEqual({ statement: "1min", lock: "5s" });
      await assertReleased(client, admin);
      expect((await applyMigrationsOnConnection(client, options)).applied).toEqual([]);
    } finally {
      observed.restore();
    }
  });
}, 180_000);
