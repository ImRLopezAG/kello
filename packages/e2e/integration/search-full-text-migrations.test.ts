import { fromDrizzleSnapshot } from "../../../apps/kello-cli/src/tooling/migrations/snapshot";
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api-postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { bigint, index, pgSchema, text, uuid } from "drizzle-orm/pg-core";
import pg from "pg";
import {
  createNativeSnapshot,
  emptySnapshot,
  inspectSnapshot,
  migrationStatements,
  snapshotHash,
} from "../../../apps/kello-cli/src/tooling/migrations/adapter";
import { classifyMigration } from "../../../apps/kello-cli/src/tooling/migrations/classifier";
import { planMigration } from "../../../apps/kello-cli/src/tooling/migrations/planner";
import {
  readMigrations,
  validateMigration,
  writeMigration,
} from "../../../apps/kello-cli/src/tooling/migrations/history";
import { applyMigrations } from "../../../apps/kello-cli/src/tooling/migrations/runner";
import { migrationStatus } from "../../../apps/kello-cli/src/tooling/migrations/status";
import { migrationHash } from "../../../apps/kello-cli/src/tooling/migrations/planner";
import type { MigrationPlan } from "../../../apps/kello-cli/src/tooling/migrations/planner";
import type { MigrationSnapshot } from "../../../apps/kello-cli/src/tooling/migrations/adapter";
import { normalizeFullTextIndexes } from "../../../apps/kello-cli/src/tooling/migrations/expressions";

// Private native spike: deliberately independent of the rank worker's shared fixture.
function fixture(
  namespace: string,
  config: "simple" | "english" = "simple",
  weight: "A" | "B" = "A",
  document = "both",
  gin = true,
  historicalSpelling = false,
  method: "gin" | "btree" = "gin",
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
      const titleDocument = historicalSpelling ? sql`COALESCE(${t.title}, ''::text)` : sql`coalesce(${t.title}, '')`;
      const bodyDocument = historicalSpelling ? sql`COALESCE(${t.body}, ''::text)` : sql`coalesce(${t.body}, '')`;
      const title = sql`setweight(to_tsvector(${sql.raw(`'pg_catalog.${config}'::regconfig`)}, ${titleDocument}), ${sql.raw(`'${weight}'::"char"`)})`;
      const body = sql`setweight(to_tsvector(${sql.raw(`'pg_catalog.${config}'::regconfig`)}, ${bodyDocument}), 'D'::"char")`;
      return [
        index("documents_title_idx").on(t.title),
        ...(gin
          ? [index("documents_search_idx").using(method, document === "both" ? sql`(${title} || ${body})` : body)]
          : []),
      ];
    },
  );
  return { namespace, tables: { documents } };
}

// Pre-U1 adapter: native generator output, structural identity and append-only lineage.
async function historicalSnapshot(schema: ReturnType<typeof fixture>, before: MigrationSnapshot) {
  const snapshot = fromDrizzleSnapshot(
    await generateDrizzleJson({ ...schema.tables, __loomNamespace: pgSchema(schema.namespace) }, before.id, [
      schema.namespace,
    ]),
  );
  return { ...snapshot, id: snapshotHash(snapshot), prevIds: [before.id] };
}

test("pre-U1 native historical artifacts stay immutable and regenerate unchanged GIN without review", async () => {
  const connectionString = process.env.LOOM_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("LOOM_TEST_DATABASE_URL is required for the PG18 historical proof");
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const namespace = `fts_history_${suffix}`;
  const metadataNamespace = `loom_history_${suffix}`;
  const runtimeRole = `fts_history_role_${suffix}`;
  const root = await mkdtemp(join(tmpdir(), "kello-fts-history-"));
  const client = new pg.Client({ connectionString });
  await client.connect();
  const options = { connectionString, root, migrations: "migrations", namespace, metadataNamespace, runtimeRole };
  const empty = await emptySnapshot(namespace);
  // Explicit pre-U1 safety outcomes, rather than expectations derived from the current classifier.
  const automatic = { automatic: true, transactional: true, issues: [] } as const;
  const review = {
    automatic: false,
    transactional: true,
    issues: [
      {
        entity: JSON.stringify(["indexes", namespace, "documents", "documents_search_idx"]),
        reason: "review-required",
      },
    ],
  } as const;
  let before = empty;
  let parent: string | null = null;
  const saved: { directory: string; plan: MigrationPlan; json: string; sql: string }[] = [];
  try {
    for (const [name, config, weight, document, gin, historicalSpelling, method] of [
      ["no_fts", "simple", "A", "both", false, true, "gin"],
      ["fts", "simple", "A", "both", true, true, "gin"],
      ["config", "english", "A", "both", true, true, "gin"],
      ["weight", "english", "B", "both", true, true, "gin"],
      ["document", "english", "B", "body", true, true, "gin"],
      // Historical formatting-only replacements still retain their old review classification.
      ["spelling", "english", "B", "body", true, false, "gin"],
      ["method", "english", "B", "body", true, false, "btree"],
    ] as const) {
      const schema = fixture(namespace, config, weight, document, gin, historicalSpelling, method);
      const snapshot = await historicalSnapshot(schema, before);
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
        safety: name === "no_fts" || name === "fts" ? automatic : review,
      } as const;
      const plan: MigrationPlan = { ...content, hash: migrationHash(content) };
      const standalone = await createNativeSnapshot(schema);
      expect(standalone.ddl).toEqual(snapshot.ddl);
      expect(snapshotHash(standalone)).toBe(plan.after);
      if (name !== "spelling") {
        const next = await planMigration(before, schema, [], parent);
        expect(next.statements).toEqual(plan.statements);
        expect(next.safety).toEqual(plan.safety);
        expect(next.hash).toBe(plan.hash);
      } else {
        const equivalent = await planMigration(before, schema, [], parent);
        expect(equivalent.statements).toEqual([]);
        expect(equivalent.safety).toEqual(automatic);
        expect(equivalent.after).toBe(snapshotHash(before));
        expect(plan.statements).toHaveLength(2);
        expect(await classifyMigration(before, snapshot)).toEqual(review);
        const downgraded = { ...plan, safety: automatic };
        await assert.rejects(
          validateMigration({ ...downgraded, hash: migrationHash(downgraded) }),
          /safety classification mismatch/,
        );
      }
      await validateMigration(plan);
      const artifact = await writeMigration(root, "migrations", name, plan);
      if (name === "fts") {
        const status = await migrationStatus({
          connectionString,
          root,
          migrations: "migrations",
          namespace,
          metadataNamespace,
        });
        expect(status.pending.find((entry) => entry.hash === plan.hash)).toMatchObject({
          hash: plan.hash,
          safety: { automatic: false, transactional: true },
          blockingGinOperations: [
            {
              id: JSON.stringify([namespace, "documents", "documents_search_idx", "create"]),
              schema: namespace,
              table: "documents",
              index: "documents_search_idx",
              kind: "create",
            },
          ],
          blockingGinTimeout: { eligible: true },
        });
        expect(plan.safety).toEqual(automatic);
        await assert.rejects(applyMigrations(options), /requires review/);
      }
      saved.push({
        directory: artifact.directory,
        plan,
        json: await readFile(join(artifact.directory, "plan.json"), "utf8"),
        sql: await readFile(join(artifact.directory, "migration.sql"), "utf8"),
      });
      console.log(
        "U1_HISTORICAL",
        JSON.stringify({
          name,
          hash: plan.hash,
          after: plan.after,
          expression: snapshot.ddl.find((e) => e.entityType === "indexes" && e.method === "gin"),
        }),
      );
      const regenerated = await planMigration(snapshot, schema, [], plan.hash);
      expect(regenerated.statements).toEqual([]);
      expect(regenerated.safety).toEqual(automatic);
      expect(regenerated.after).toBe(plan.after);
      expect(regenerated.snapshot.ddl).toEqual(snapshot.ddl);
      await assert.rejects(writeMigration(root, "migrations", "noop", regenerated), /no structural change/);
      if (!plan.safety.automatic) await assert.rejects(applyMigrations(options), /requires review/);
      expect((await applyMigrations({ ...options, reviewedHashes: [plan.hash] })).applied).toEqual([plan.hash]);
      expect((await applyMigrations(options)).applied).toEqual([]);
      const inspected = await inspectSnapshot(drizzle({ client }), namespace);
      if (method === "gin") {
        const liveRegenerated = await planMigration(inspected, schema, [], plan.hash);
        expect(liveRegenerated.statements).toEqual([]);
        expect(liveRegenerated.safety).toEqual(automatic);
      } else {
        // B-tree expression canonicalization is outside the bounded GIN vocabulary.
        const restoreGin = await planMigration(inspected, fixture(namespace, config, weight, document), [], plan.hash);
        expect(restoreGin.statements).toHaveLength(2);
        expect(restoreGin.statements[1]).toContain("USING gin");
        expect(restoreGin.safety).toEqual(review);
      }
      before = snapshot;
      parent = plan.hash;
    }
    expect((await readMigrations(root, "migrations")).map((artifact) => artifact.plan)).toEqual(
      saved.map((s) => s.plan),
    );
    for (const entry of saved) {
      await validateMigration(entry.plan);
      expect(snapshotHash(entry.plan.snapshot)).toBe(entry.plan.after);
      expect(migrationHash(entry.plan)).toBe(entry.plan.hash);
      expect(await readFile(join(entry.directory, "plan.json"), "utf8")).toBe(entry.json);
      expect(await readFile(join(entry.directory, "migration.sql"), "utf8")).toBe(entry.sql);
    }
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
    await client.query(`DROP SCHEMA IF EXISTS "${metadataNamespace}" CASCADE`);
    await client.query(`DROP ROLE IF EXISTS "${runtimeRole}"`);
    await client.end();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("native weighted expression GIN round-trips through Kello's migration lifecycle", async () => {
  const connectionString = process.env.LOOM_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("LOOM_TEST_DATABASE_URL is required for the PG18 migration proof");
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const namespace = `fts_${suffix}`;
  const renamedNamespace = `fts_renamed_${suffix}`;
  const metadataNamespace = `loom_fts_${suffix}`;
  const runtimeRole = `fts_role_${suffix}`;
  const root = await mkdtemp(join(tmpdir(), "kello-fts-u1-"));
  const client = new pg.Client({ connectionString });
  await client.connect();
  const options = { connectionString, root, migrations: "migrations", namespace, metadataNamespace, runtimeRole };
  try {
    const version = Number((await client.query("SHOW server_version_num")).rows[0].server_version_num);
    expect(version).toBeGreaterThanOrEqual(180000);
    expect(version).toBeLessThan(190000);
    const schema = fixture(namespace);
    const empty = await emptySnapshot(namespace);
    const native = await createNativeSnapshot(schema, empty);
    const initial = await planMigration(empty, schema);
    expect(initial.after).toBe(snapshotHash(native));
    expect(initial.statements).toEqual(await migrationStatements(empty, native));
    expect(initial.safety).toEqual(await classifyMigration(empty, native));
    expect(initial.safety).toEqual({ automatic: true, transactional: true, issues: [] });
    expect((await planMigration(empty, fixture(namespace))).hash).toBe(initial.hash);
    console.log(
      "U1_INITIAL",
      JSON.stringify({ version, hash: initial.hash, snapshotHash: initial.after, statements: initial.statements }),
    );
    await writeMigration(root, "migrations", "initial", initial);
    expect((await applyMigrations(options)).applied).toEqual([initial.hash]);
    expect((await applyMigrations(options)).applied).toEqual([]);
    const catalog = await client.query(
      `SELECT pg_get_indexdef(i.indexrelid) AS definition, i.indisvalid, i.indisready, am.amname FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_am am ON am.oid=c.relam WHERE n.nspname=$1 ORDER BY c.relname`,
      [namespace],
    );
    console.log("U1_CATALOG", JSON.stringify(catalog.rows));
    const gin = catalog.rows.find((row) => row.amname === "gin");
    expect(gin?.indisvalid).toBe(true);
    expect(gin?.indisready).toBe(true);
    expect(gin?.definition).toContain("'simple'::regconfig");
    expect(gin?.definition).toContain("'A'::\"char\"");
    expect(gin?.definition).toContain("'D'::\"char\"");
    expect(catalog.rows.filter((row) => row.amname === "btree")).toHaveLength(2);
    const live = await inspectSnapshot(drizzle({ client }), namespace);
    console.log(
      "U1_LIVE_INDEXES",
      JSON.stringify(live.ddl.filter((e) => e.entityType === "indexes").sort((a, b) => a.name.localeCompare(b.name))),
    );
    const regenerated = await planMigration(live, schema, [], initial.hash);
    console.log(
      "U1_REGENERATED",
      JSON.stringify({
        hash: regenerated.hash,
        before: regenerated.before,
        after: regenerated.after,
        statements: regenerated.statements,
        safety: regenerated.safety,
      }),
    );
    expect(regenerated.statements).toEqual([]);
    expect(regenerated.safety.automatic).toBe(true);
    expect(live.ddl.filter((e) => e.entityType === "indexes").sort((a, b) => a.name.localeCompare(b.name))).toEqual(
      initial.snapshot.ddl.filter((e) => e.entityType === "indexes").sort((a, b) => a.name.localeCompare(b.name)),
    );
    expect(snapshotHash(await inspectSnapshot(drizzle({ client }), namespace))).toBe(snapshotHash(live));
    expect(regenerated.hash).toBe(migrationHash(regenerated));
    console.log(
      "U1_SNAPSHOT_DIFFERENCES",
      JSON.stringify(initial.snapshot.ddl.filter((e) => !live.ddl.some((actual) => isDeepStrictEqual(actual, e)))),
    );
    expect((await planMigration(initial.snapshot, schema)).statements).toEqual([]);
    await assert.rejects(writeMigration(root, "migrations", "noop", regenerated), /no structural change/);

    // Characterize the existing-table GIN classifier gap; U2 owns changing this result.
    const withoutGin = await createNativeSnapshot(fixture(namespace, "simple", "A", "both", false));
    const existingTableGin = await classifyMigration(withoutGin, initial.snapshot);
    console.log("U1_EXISTING_TABLE_GIN_CLASSIFICATION", JSON.stringify(existingTableGin));
    expect(existingTableGin).toEqual({ automatic: true, transactional: true, issues: [] });

    await client.query(
      `INSERT INTO "${namespace}".documents (title, body) VALUES (NULL, NULL), ('running title', NULL), (NULL, 'body text')`,
    );
    const btreeOid = (
      await client.query(
        "SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname='documents_title_idx'",
        [namespace],
      )
    ).rows[0].oid;
    let head = initial;
    for (const [name, config, weight, document] of [
      ["config", "english", "A", "both"],
      ["weight", "english", "B", "both"],
      ["document", "english", "B", "body"],
    ] as const) {
      const target = fixture(namespace, config, weight, document);
      const plan = await planMigration(head.snapshot, target, [], head.hash);
      expect(plan.hash).not.toBe(head.hash);
      expect(plan.after).not.toBe(head.after);
      expect(plan.safety.automatic).toBe(false);
      expect(plan.safety.issues.map((issue) => issue.reason)).toContain("review-required");
      expect(plan.statements).toHaveLength(2);
      expect(plan.statements.join("\n")).not.toContain("documents_title_idx");
      console.log(
        "U1_CHANGE",
        JSON.stringify({
          name,
          hash: plan.hash,
          snapshotHash: plan.after,
          statements: plan.statements,
          safety: plan.safety,
        }),
      );
      await writeMigration(root, "migrations", name, plan);
      await assert.rejects(applyMigrations(options), /requires review/);
      expect((await applyMigrations({ ...options, reviewedHashes: [plan.hash] })).applied).toEqual([plan.hash]);
      expect((await applyMigrations(options)).applied).toEqual([]);
      const inspected = await inspectSnapshot(drizzle({ client }), namespace);
      expect((await planMigration(inspected, target)).statements).toEqual([]);
      expect(
        inspected.ddl.filter((e) => e.entityType === "indexes").sort((a, b) => a.name.localeCompare(b.name)),
      ).toEqual(
        plan.snapshot.ddl.filter((e) => e.entityType === "indexes").sort((a, b) => a.name.localeCompare(b.name)),
      );
      head = plan;
    }
    expect(
      (
        await client.query(
          "SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname='documents_title_idx'",
          [namespace],
        )
      ).rows[0].oid,
    ).toBe(btreeOid);
    expect((await client.query(`SELECT count(*)::int AS count FROM "${namespace}".documents`)).rows[0].count).toBe(3);
    await client.query(`UPDATE "${namespace}".documents SET body='updated searchable' WHERE title='running title'`);
    expect(
      (
        await client.query(
          `SELECT count(*)::int AS count FROM "${namespace}".documents WHERE setweight(to_tsvector('pg_catalog.english'::regconfig, coalesce(body, '')), 'D'::"char") @@ plainto_tsquery('pg_catalog.english', 'updated')`,
        )
      ).rows[0].count,
    ).toBe(1);

    // A same-name wrong configuration is real catalog drift, not a spelling difference.
    await client.query(`DROP INDEX "${namespace}".documents_search_idx`);
    await client.query(
      `CREATE INDEX documents_search_idx ON "${namespace}".documents USING gin (setweight(to_tsvector('pg_catalog.simple'::regconfig, coalesce(body, '')), 'B'::"char"))`,
    );
    const wrong = await inspectSnapshot(drizzle({ client }), namespace);
    const correction = await planMigration(wrong, fixture(namespace, "english", "B", "body"));
    expect(correction.statements).toHaveLength(2);
    expect(correction.safety.automatic).toBe(false);
    console.log("U1_WRONG_DEFINITION", JSON.stringify({ statements: correction.statements, hash: correction.hash }));
    await assert.rejects(applyMigrations(options), /drift/);
    await client.query(`CREATE TEXT SEARCH CONFIGURATION "${namespace}".simple (COPY = pg_catalog.english)`);
    await client.query(`DROP INDEX "${namespace}".documents_search_idx`);
    await client.query(
      `CREATE INDEX documents_search_idx ON "${namespace}".documents USING gin (setweight(to_tsvector('${namespace}.simple'::regconfig, coalesce(body, '')), 'D'::"char"))`,
    );
    await client.query(`SET search_path = "${namespace}", pg_catalog`);
    const shadowed = await inspectSnapshot(drizzle({ client }), namespace);
    const shadowedIndex = shadowed.ddl.find((e) => e.entityType === "indexes" && e.name === "documents_search_idx");
    assert(shadowedIndex?.entityType === "indexes");
    expect(shadowedIndex.columns[0]?.value).toContain(`${namespace}.simple`);
    expect((await client.query("SHOW search_path")).rows[0].search_path).toBe(`${namespace}, pg_catalog`);
    await drizzle({ client }).transaction(async (tx) => {
      await inspectSnapshot(tx, namespace);
      const restored = await tx.execute<{ search_path: string }>(sql`SHOW search_path`);
      expect(restored.rows[0]?.search_path).toBe(`${namespace}, pg_catalog`);
    });
    console.log(
      "U1_SHADOW_CONFIG",
      JSON.stringify(shadowed.ddl.filter((e) => e.entityType === "indexes" && e.name === "documents_search_idx")),
    );
    await client.query("SET search_path = pg_catalog");
    // Restore only our fixture index before testing a namespace rename through native planning.
    for (const statement of correction.statements) await client.query(statement);
    expect((await applyMigrations(options)).applied).toEqual([]);
    await client.query(`DROP INDEX "${namespace}".documents_search_idx`);
    await client.query(
      `CREATE INDEX documents_search_idx ON "${namespace}".documents USING btree (setweight(to_tsvector('pg_catalog.english'::regconfig, coalesce(body, '')), 'D'::"char"))`,
    );
    const wrongMethod = await planMigration(
      await inspectSnapshot(drizzle({ client }), namespace),
      fixture(namespace, "english", "B", "body"),
    );
    expect(wrongMethod.statements).toHaveLength(2);
    expect(wrongMethod.statements[1]).toContain("USING gin");
    await assert.rejects(applyMigrations(options), /drift/);
    console.log("U1_WRONG_METHOD", JSON.stringify({ statements: wrongMethod.statements, hash: wrongMethod.hash }));
    for (const statement of wrongMethod.statements) await client.query(statement);
    // Exercise native namespace rebinding without inventing a public schema-rename hint.
    // Kello's pinned public rename contract supports table/column hints only.
    await client.query(`ALTER SCHEMA "${namespace}" RENAME TO "${renamedNamespace}"`);
    expect(
      (
        await planMigration(
          await inspectSnapshot(drizzle({ client }), renamedNamespace),
          fixture(renamedNamespace, "english", "B", "body"),
        )
      ).statements,
    ).toEqual([]);
    expect(
      (await client.query(`SELECT count(*)::int AS count FROM "${renamedNamespace}".documents`)).rows[0].count,
    ).toBe(3);
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS "${renamedNamespace}" CASCADE`);
    await client.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
    await client.query(`DROP SCHEMA IF EXISTS "${metadataNamespace}" CASCADE`);
    await client.query(`DROP ROLE IF EXISTS "${runtimeRole}"`);
    expect(
      (
        await client.query("SELECT nspname FROM pg_namespace WHERE nspname = ANY($1::text[])", [
          [namespace, renamedNamespace, metadataNamespace],
        ])
      ).rows,
    ).toEqual([]);
    expect((await client.query("SELECT rolname FROM pg_roles WHERE rolname = $1", [runtimeRole])).rows).toEqual([]);
    await client.end();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("bounded normalization preserves definitions outside the proved vocabulary", async () => {
  const snapshot = await createNativeSnapshot(fixture("fts_ast_proof"));
  const gin = snapshot.ddl.find((e) => e.entityType === "indexes" && e.method === "gin");
  assert(gin?.entityType === "indexes");
  const original = gin.columns[0]!.value;
  for (const value of [
    original.replace("pg_catalog.simple", "custom.simple"),
    original.replace("coalesce(\"title\", '')", "coalesce(\"title\", 'fallback')"),
    original.replace("'A'::\"char\"", "'Z'::\"char\""),
    original.replace("setweight", "custom.setweight"),
    original.replaceAll("pg_catalog.simple", "simple"),
    `${original}, 1`,
  ]) {
    const altered = {
      ...snapshot,
      ddl: snapshot.ddl.map((entity) =>
        entity === gin ? { ...gin, columns: [{ ...gin.columns[0]!, value }] } : entity,
      ),
    };
    expect((await normalizeFullTextIndexes(altered)).ddl).toEqual(altered.ddl);
  }
});
