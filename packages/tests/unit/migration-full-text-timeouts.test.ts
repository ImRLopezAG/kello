import { expect, test, vi } from "vite-plus/test";
import { sql } from "drizzle-orm";
import { index, pgSchema, text } from "drizzle-orm/pg-core";
import { assessMigration } from "../../../apps/kello/src/tooling/migrations/assessment";
import * as v from "valibot";
import type { MigrationPlan } from "../../../apps/kello/src/tooling/migrations/planner";
import pg from "pg";
import { withMigrationConnection } from "../../../apps/kello/src/tooling/migrations/connection";
import { classifyMigration } from "../../../apps/kello/src/tooling/migrations/classifier";
import { customSafety } from "../../../apps/kello/src/tooling/migrations/custom";
import { createSnapshot, emptySnapshot, snapshotHash } from "../../../apps/kello/src/tooling/migrations/adapter";
import { planMigration, migrationHash } from "../../../apps/kello/src/tooling/migrations/planner";
import { runnerOptions, applyMigrationsOnConnection } from "../../../apps/kello/src/tooling/migrations/runner";

function fixture(gin = false, weight = "A") {
  const documents = pgSchema("app").table("documents", { title: text() }, (t) =>
    gin
      ? [
          index("documents_search_idx").using(
            "gin",
            sql`setweight(to_tsvector('pg_catalog.simple'::regconfig, coalesce(${t.title}, '')), ${sql.raw(`'${weight}'::"char"`)})`,
          ),
        ]
      : [],
  );
  return { namespace: "app", tables: { documents } };
}

test("existing-table native GIN gains current review without changing historical artifact safety", async () => {
  const plan = await planMigration(await createSnapshot(fixture()), fixture(true));
  const bytes = JSON.stringify(plan);
  expect(plan.safety).toEqual({ automatic: true, transactional: true, issues: [] });
  const assessment = await assessMigration(plan);
  expect(assessment.artifactHash).toBe(plan.hash);
  expect(assessment.safety.automatic).toBe(false);
  expect(assessment.safety.issues).toContainEqual({
    entity: '["indexes","app","documents","documents_search_idx"]',
    reason: "review-required",
  });
  expect(assessment.blockingGinOperations).toEqual([
    {
      id: '["app","documents","documents_search_idx","create"]',
      schema: "app",
      table: "documents",
      index: "documents_search_idx",
      kind: "create",
    },
  ]);
  expect(assessment.blockingGinTimeout).toEqual({ eligible: true });
  expect(JSON.stringify(plan)).toBe(bytes);
});

const options = {
  connectionString: "postgres://localhost/db",
  root: ".",
  migrations: "migrations",
  namespace: "app",
  runtimeRole: "runtime",
};

test("runner timeout entries are strict finite bounded milliseconds with an empty default", () => {
  expect(v.parse(runnerOptions, options).blockingGinTimeouts).toEqual([]);
  for (const statementTimeoutMs of [0, -1, 1.5, NaN, Infinity, 900001, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() =>
      v.parse(runnerOptions, {
        ...options,
        blockingGinTimeouts: [{ artifactHash: "a".repeat(64), statementTimeoutMs }],
      }),
    ).toThrow();
  }
  for (const statementTimeoutMs of [1, 120000, 900000]) {
    expect(
      v.parse(runnerOptions, {
        ...options,
        blockingGinTimeouts: [{ artifactHash: "a".repeat(64), statementTimeoutMs }],
      }).blockingGinTimeouts,
    ).toHaveLength(1);
  }
  expect(() =>
    v.parse(runnerOptions, {
      ...options,
      blockingGinTimeouts: [{ artifactHash: "A".repeat(64), statementTimeoutMs: 1 }],
    }),
  ).toThrow();
  expect(() =>
    v.parse(runnerOptions, {
      ...options,
      blockingGinTimeouts: [{ artifactHash: "a".repeat(64), statementTimeoutMs: 1, extra: true }],
    }),
  ).toThrow();
  expect(() =>
    v.parse(runnerOptions, {
      ...options,
      blockingGinTimeouts: [
        { artifactHash: "a".repeat(64), statementTimeoutMs: 1 },
        { artifactHash: "a".repeat(64), statementTimeoutMs: 2 },
      ],
    }),
  ).toThrow();
});

function withStatements(plan: MigrationPlan, statements: readonly string[]): MigrationPlan {
  const content = { ...plan, statements };
  return { ...content, hash: migrationHash(content) };
}

test("replacement maps both drop and create; extra, missing, duplicate and mismatched SQL never authorize timeouts", async () => {
  const baseline = await createSnapshot(fixture(true));
  const replacement = await planMigration(baseline, fixture(true, "B"));
  expect((await assessMigration(replacement)).blockingGinOperations[0]?.kind).toBe("replace");
  expect((await assessMigration(replacement)).blockingGinTimeout).toEqual({ eligible: true });
  for (const statements of [
    [],
    replacement.statements.slice(1),
    [...replacement.statements, "SELECT 1;"],
    [...replacement.statements, replacement.statements[1]!],
    replacement.statements.map((sql) => sql.replace('ON "app"."documents"', 'ON "app"."other"')),
  ]) {
    expect((await assessMigration(withStatements(replacement, statements))).blockingGinTimeout.eligible).toBe(false);
  }
  await expect(assessMigration({ ...replacement, statements: ["SELECT 1;"] })).rejects.toThrow("hash mismatch");
});

test("new tables and unchanged GIN retain automatic safety while missing GIN SQL is unsupported evidence", async () => {
  const initial = await planMigration(await emptySnapshot("app"), fixture(true));
  expect((await assessMigration(initial)).safety.automatic).toBe(true);
  expect((await assessMigration(initial)).blockingGinTimeout.eligible).toBe(false);
  const noop = await planMigration(initial.snapshot, fixture(true));
  expect((await assessMigration(noop)).safety.automatic).toBe(true);
  expect((await assessMigration(noop)).blockingGinOperations).toEqual([]);
  expect(
    (
      await assessMigration(
        withStatements(
          initial,
          initial.statements.filter((sql) => !sql.startsWith("CREATE INDEX")),
        ),
      )
    ).safety.automatic,
  ).toBe(false);
});

test("unknown expressions, partial predicates, nontransactional and concurrent GIN stay outside timeout admission", async () => {
  const baseline = await createSnapshot(fixture());
  const arbitrary = pgSchema("app").table("documents", { title: text() }, (t) => [
    index("documents_search_idx").using("gin", sql`to_tsvector('pg_catalog.simple'::regconfig, ${t.title})`),
  ]);
  const unknown = await planMigration(baseline, { namespace: "app", tables: { documents: arbitrary } });
  expect((await assessMigration(unknown)).safety.automatic).toBe(false);
  expect((await assessMigration(unknown)).blockingGinTimeout.eligible).toBe(false);
  const normal = await planMigration(baseline, fixture(true));
  await expect(
    assessMigration(
      withStatements(
        normal,
        normal.statements.map((sql) => sql.replace("CREATE INDEX", "CREATE INDEX CONCURRENTLY")),
      ),
    ),
  ).rejects.toThrow("Concurrent GIN");
  const initialUnknown = await planMigration(await emptySnapshot("app"), {
    namespace: "app",
    tables: { documents: arbitrary },
  });
  expect((await assessMigration(initialUnknown)).safety.automatic).toBe(false);
  const unqualified = withStatements(
    normal,
    normal.statements.map((sql) => sql.replace("pg_catalog.simple", "simple")),
  );
  expect((await assessMigration(unqualified)).blockingGinTimeout.eligible).toBe(false);
  const partial = withStatements(
    normal,
    normal.statements.map((sql) => sql.replace(/;$/, ' WHERE "title" IS NOT NULL;')),
  );
  expect((await assessMigration(partial)).blockingGinTimeout.eligible).toBe(false);
});

const { connectionString: _connectionString, ...connectionOptions } = options;
const routing = vi.hoisted(() => ({
  artifacts: new Array<{ name: string; directory: string; plan: MigrationPlan }>(),
  applied: 0,
}));
vi.mock("../../../apps/kello/src/tooling/migrations/history", async (original) => ({
  ...(await original<typeof import("../../../apps/kello/src/tooling/migrations/history")>()),
  readMigrations: async () => routing.artifacts,
}));
vi.mock("../../../apps/kello/src/tooling/migrations/state", () => ({
  inspectHistory: async () => ({
    applied: Array.from({ length: routing.applied }),
    issues: [],
    expectedCatalog: "catalog",
    framework: { state: "current" },
  }),
  ormHistoryTable: () => "orm_history",
}));
vi.mock("../../../apps/kello/src/tooling/migrations/bootstrap", () => ({ bootstrapSession: async () => undefined }));
vi.mock("../../../apps/kello/src/tooling/migrations/runtime-compatibility", () => ({
  assertRuntimeCompatibility: async () => undefined,
}));
vi.mock("../../../apps/kello/src/tooling/migrations/drift", () => ({ catalogFingerprint: async () => "catalog" }));
vi.mock("../../../apps/kello/src/tooling/migrations/application", () => ({
  protectApplication: async () => undefined,
}));
vi.mock("../../../apps/kello/src/tooling/migrations/status", () => ({
  databaseIdentity: async () => ({ database: "fixture" }),
}));

async function runnerFixture(
  operation: (client: pg.Client, queries: { sql: string; timeout: string }[]) => Promise<void>,
  failBuild = false,
  failRollback = false,
) {
  const queries: { sql: string; timeout: string }[] = [];
  let timeout = "60s";
  const connect = vi.spyOn(pg.Client.prototype, "connect").mockResolvedValue(undefined);
  const end = vi.spyOn(pg.Client.prototype, "end").mockResolvedValue(undefined);
  const buildFailure = new Error("build fixture failed");
  // SAFETY: The native runner uses only awaited SQL strings/text configs and scalar bindings; the mock returns complete pg results.
  const query = vi.spyOn(pg.Client.prototype, "query").mockImplementation((async (
    input: string | { text: string },
    values?: readonly (string | number | boolean | null)[],
  ) => {
    const sql = v.parse(
      v.union([
        v.pipe(
          v.string(),
          v.transform((text) => ({ text })),
        ),
        v.object({ text: v.string() }),
      ]),
      input,
    ).text;
    queries.push({ sql, timeout });
    if (sql.includes("set_config('statement_timeout'")) timeout = v.parse(v.string(), values?.[0]);
    if (failBuild && sql.startsWith("CREATE INDEX")) throw buildFailure;
    if (failRollback && sql.startsWith("rollback")) throw new Error("rollback fixture failed");
    return {
      command: "SELECT",
      rowCount: 0,
      oid: 0,
      fields: [],
      rows:
        sql === "SHOW server_version_num"
          ? [{ server_version_num: "180006" }]
          : sql.includes("pg_try_advisory_lock")
            ? [{ acquired: true }]
            : sql.includes("current_setting")
              ? [{ timeout }]
              : [],
    };
  }) as pg.Client["query"]);
  try {
    await withMigrationConnection("postgres://localhost/db", (client) => operation(client, queries));
  } finally {
    connect.mockRestore();
    end.mockRestore();
    query.mockRestore();
    routing.applied = 0;
  }
  return buildFailure;
}

test("runner independently denies unreviewed current GIN and stale, unknown, unreviewed or mixed overrides before writes", async () => {
  const plan = await planMigration(await createSnapshot(fixture()), fixture(true));
  routing.artifacts = [{ name: "gin", directory: ".", plan }];
  await runnerFixture(async (client, queries) => {
    await expect(applyMigrationsOnConnection(client, connectionOptions)).rejects.toThrow("requires review");
    const entry = { artifactHash: plan.hash, statementTimeoutMs: 120000 };
    await expect(
      applyMigrationsOnConnection(client, { ...connectionOptions, blockingGinTimeouts: [entry] }),
    ).rejects.toThrow("exact artifact review");
    await expect(
      applyMigrationsOnConnection(client, {
        ...connectionOptions,
        reviewedHashes: [plan.hash],
        blockingGinTimeouts: [{ ...entry, artifactHash: "a".repeat(64) }],
      }),
    ).rejects.toThrow("pending artifact");
    routing.applied = 1;
    await expect(
      applyMigrationsOnConnection(client, {
        ...connectionOptions,
        reviewedHashes: [plan.hash],
        blockingGinTimeouts: [entry],
      }),
    ).rejects.toThrow("pending artifact");
    routing.applied = 0;
    const mixed = withStatements(plan, [...plan.statements, "SELECT 1;"]);
    routing.artifacts = [{ name: "mixed", directory: ".", plan: mixed }];
    await expect(
      applyMigrationsOnConnection(client, {
        ...connectionOptions,
        reviewedHashes: [mixed.hash],
        blockingGinTimeouts: [{ ...entry, artifactHash: mixed.hash }],
      }),
    ).rejects.toThrow("ineligible");
    expect(queries.some(({ sql }) => sql === "begin" || sql.includes("set_config"))).toBe(false);
  });
});

test("runner routes only the selected artifact's whole native migrator through the local timeout", async () => {
  const first = await planMigration(await createSnapshot(fixture()), fixture(true));
  const second = await planMigration(first.snapshot, fixture(true, "B"));
  routing.artifacts = [
    { name: "first", directory: ".", plan: first },
    { name: "second", directory: ".", plan: second },
  ];
  await runnerFixture(async (client, queries) => {
    const receipt = await applyMigrationsOnConnection(client, {
      ...connectionOptions,
      reviewedHashes: [first.hash, second.hash],
      blockingGinTimeouts: [{ artifactHash: first.hash, statementTimeoutMs: 120000 }],
    });
    expect(receipt.applied).toEqual([first.hash, second.hash]);
    const builds = queries.filter(({ sql }) => sql.startsWith("CREATE INDEX"));
    expect(builds.map(({ timeout }) => timeout)).toEqual(["120000ms", "60s"]);
    const nativeInserts = queries.filter(({ sql }) => sql.startsWith('insert into "loom_meta"."orm_history"'));
    expect(nativeInserts.map(({ timeout }) => timeout)).toEqual(["120000ms", "60s"]);
    const nativeSetup = queries.filter(({ sql }) => sql.startsWith("CREATE SCHEMA IF NOT EXISTS"));
    expect(nativeSetup.map(({ timeout }) => timeout)).toEqual(["120000ms", "60s"]);
    const outerHistory = queries.filter(({ sql }) => sql.includes(".migration_history"));
    expect(outerHistory.map(({ timeout }) => timeout)).toEqual(["60s", "60s"]);
    expect(queries.filter(({ sql }) => sql.includes("set_config"))).toHaveLength(2);
  });
});

test("native build errors survive both nested and outer rollback failures", async () => {
  const plan = await planMigration(await createSnapshot(fixture()), fixture(true));
  routing.artifacts = [{ name: "gin", directory: ".", plan }];
  await runnerFixture(
    async (client, queries) => {
      const failure = await applyMigrationsOnConnection(client, {
        ...connectionOptions,
        reviewedHashes: [plan.hash],
        blockingGinTimeouts: [{ artifactHash: plan.hash, statementTimeoutMs: 1 }],
      }).catch((error: Error) => error);
      expect(failure).toBeInstanceOf(Error);
      if (!(failure instanceof Error)) throw new Error("Expected the native migration error");
      expect(failure.cause).toBeInstanceOf(Error);
      if (!(failure.cause instanceof Error)) throw new Error("Expected the native build cause");
      expect(failure.cause.message).toBe("build fixture failed");
      expect(queries.filter(({ sql }) => sql.includes("set_config"))).toHaveLength(1);
    },
    true,
    true,
  );
});

test("ambiguous snapshot identities never admit a timeout", async () => {
  const plan = await planMigration(await createSnapshot(fixture()), fixture(true));
  const gin = plan.snapshot.ddl.find((entity) => entity.entityType === "indexes" && entity.method === "gin")!;
  const duplicated = { ...plan.snapshot, ddl: [...plan.snapshot.ddl, gin] };
  const after = snapshotHash(duplicated);
  const snapshot = { ...duplicated, id: after };
  const content = { ...plan, after, snapshot, safety: await classifyMigration(plan.baseline, snapshot) };
  const ambiguous = { ...content, hash: migrationHash(content) };
  expect((await assessMigration(ambiguous)).safety.automatic).toBe(false);
  expect((await assessMigration(ambiguous)).blockingGinTimeout.eligible).toBe(false);
});

test("undeclared GIN drops are nonautomatic even when historical structure is unchanged", async () => {
  const baseline = await createSnapshot(fixture(true));
  const noop = await planMigration(baseline, fixture(true));
  const undeclaredDrop = withStatements(noop, ['DROP INDEX "app"."documents_search_idx";']);
  expect((await assessMigration(undeclaredDrop)).safety.automatic).toBe(false);
  await expect(
    assessMigration(withStatements(noop, ['DROP INDEX CONCURRENTLY "app"."documents_search_idx";'])),
  ).rejects.toThrow("Concurrent GIN");
});

test("nontransactional artifacts cannot receive blocking GIN timeout approval", async () => {
  const generated = await planMigration(await createSnapshot(fixture()), fixture(true));
  const content = {
    ...generated,
    kind: "custom" as const,
    safety: await customSafety(generated.baseline, generated.snapshot, "nontransactional"),
  };
  const plan = { ...content, hash: migrationHash(content) };
  expect((await assessMigration(plan)).blockingGinTimeout.eligible).toBe(false);
});

test("selected document evidence rejects duplicate sources and mixed configurations", async () => {
  const documents = pgSchema("app").table("documents", { title: text(), body: text() });
  const baseline = await createSnapshot({ namespace: "app", tables: { documents } });
  for (const expression of [
    sql`setweight(to_tsvector('pg_catalog.simple'::regconfig, coalesce("title", '')), 'A'::"char") || setweight(to_tsvector('pg_catalog.simple'::regconfig, coalesce("title", '')), 'B'::"char")`,
    sql`setweight(to_tsvector('pg_catalog.simple'::regconfig, coalesce("title", '')), 'A'::"char") || setweight(to_tsvector('pg_catalog.english'::regconfig, coalesce("body", '')), 'B'::"char")`,
  ]) {
    const documents = pgSchema("app").table("documents", { title: text(), body: text() }, () => [
      index("documents_search_idx").using("gin", sql`(${expression})`),
    ]);
    const plan = await planMigration(baseline, { namespace: "app", tables: { documents } });
    expect((await assessMigration(plan)).blockingGinTimeout.eligible).toBe(false);
  }
});

test("unrelated native structural changes make a GIN artifact mixed while B-tree additions stay automatic", async () => {
  const baseline = await createSnapshot(fixture());
  const btreeTable = pgSchema("app").table("documents", { title: text() }, (t) => [index("title_idx").on(t.title)]);
  const btree = await planMigration(baseline, { namespace: "app", tables: { documents: btreeTable } });
  expect((await assessMigration(btree)).safety).toEqual(btree.safety);
  expect((await assessMigration(btree)).safety.automatic).toBe(true);
  const mixedTable = pgSchema("app").table("documents", { title: text(), body: text() }, (t) => [
    index("documents_search_idx").using(
      "gin",
      sql`setweight(to_tsvector('pg_catalog.simple'::regconfig, coalesce(${t.title}, '')), 'A'::"char")`,
    ),
  ]);
  const mixed = await planMigration(baseline, { namespace: "app", tables: { documents: mixedTable } });
  expect((await assessMigration(mixed)).blockingGinTimeout.eligible).toBe(false);
});

test("qualified operation identities are deterministic and sorted across multiple native indexes", async () => {
  function multi(gin: boolean) {
    const tables = Object.fromEntries(
      ["z", "a"].map((name) => [
        name,
        pgSchema("app").table(name, { title: text() }, (t) =>
          gin
            ? [
                index(`${name}_search`).using(
                  "gin",
                  sql`setweight(to_tsvector('pg_catalog.simple'::regconfig, coalesce(${t.title}, '')), 'A'::"char")`,
                ),
              ]
            : [],
        ),
      ]),
    );
    return { namespace: "app", tables };
  }
  const plan = await planMigration(await createSnapshot(multi(false)), multi(true));
  const assessment = await assessMigration(plan);
  expect(assessment.blockingGinOperations.map((operation) => operation.id)).toEqual([
    '["app","a","a_search","create"]',
    '["app","z","z_search","create"]',
  ]);
  expect(assessment.blockingGinTimeout.eligible).toBe(true);
});
