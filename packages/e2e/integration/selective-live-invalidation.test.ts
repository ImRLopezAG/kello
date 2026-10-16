import assert from "node:assert/strict";
import { test, expect } from "bun:test";
import pg from "pg";
import type { AnyRelations } from "drizzle-orm";
import { defineRelations, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { pgSchema } from "drizzle-orm/pg-core";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api-postgres";
import { call, Procedure, ORPCError } from "@orpc/server";
import type { AnyProcedure, InferSchemaInput } from "@orpc/server";
import * as v from "valibot";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { Context, Layer } from "effect";
import {
  defineSchema,
  createProjectProcedures,
  withLiveDependencies,
  connectDatabase,
  createDatabaseMiddleware,
  createRevisionReader,
  createRpcRuntime,
  defineApplication,
  defineComponent,
  defineRpcAuth,
  runFunctionTransaction,
} from "../../../apps/loom/src/core/server/index";
import { createDependencyRegistry } from "../../../apps/loom/src/core/server/realtime/dependencies";
import { listenForRevisions } from "../../../apps/loom/src/core/server/realtime/notifications";
import { createRevisionCoordinator } from "../../../apps/loom/src/core/server/realtime/coordinator";
import {
  acceptSnapshotAttempt,
  evaluateSnapshot,
  registerSnapshotSegment,
  runSnapshotAttempt,
} from "../../../apps/loom/src/core/server/rpc/snapshot";
import { bindRuntimeGraph } from "../../../apps/loom/src/core/server/rpc/runtime-graph";
import { getDatabasePolicy } from "../../../apps/loom/src/core/server/rpc/database";
import { searchContractDescriptor } from "../../../apps/loom/src/core/search/metadata";
import { evaluateLiveSnapshot } from "../../../apps/loom/src/core/server/rpc/live-context";
import { createEffectRuntime, Invocation } from "../../../apps/loom/src/core/server/effect/runtime";
import { bootstrapDatabase } from "../../../apps/loom/src/tooling/migrations/bootstrap";
import { installRevisionTracking } from "../../../apps/loom/src/tooling/migrations/revisions";

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Selective live acceptance timed out")), 10000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const iteratorSchema = v.custom<AsyncIteratorObject<unknown, unknown>>((value) =>
  v.is(v.object({ next: v.function() }), value),
);

for (const mode of ["polling", "notify"] as const) {
  test(`U3 ${mode}: assembled runtime defaults complete generated searches to selective and keeps fallbacks broad`, async () => {
    const connectionString = process.env.LOOM_TEST_DATABASE_URL;
    assert(connectionString, "LOOM_TEST_DATABASE_URL is required");
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const namespace = `u3_${suffix}`;
    const metadataNamespace = `loom_u3_${suffix}`;
    const role = `u3_role_${suffix}`;
    const schema = defineSchema(
      (f) => ({
        tasks: { title: f.text().notNull(), owner: f.text().notNull() },
        permissions: { subject: f.text().notNull(), allowed: f.boolean().notNull() },
        policyPermissions: { subject: f.text().notNull(), allowed: f.boolean().notNull() },
        unrelated: { title: f.text().notNull() },
      }),
      { namespace },
    );
    const relations = defineRelations(schema.tables);
    const owner = new pg.Pool({ connectionString });
    let runtime: Awaited<ReturnType<typeof createRpcRuntime<typeof relations>>> | undefined;
    try {
      expect((await owner.query("SHOW server_version")).rows[0].server_version).toMatch(/^18\b/);
      await bootstrapDatabase({ connectionString, metadataNamespace, runtimeRole: role });
      const empty = await generateDrizzleJson({}, undefined, [namespace]);
      const installed = await generateDrizzleJson({ namespace: pgSchema(namespace), ...schema.tables }, empty.id, [
        namespace,
      ]);
      await owner.query((await generateMigration(empty, installed)).join("\n"));
      const admin = await owner.connect();
      try {
        await admin.query("BEGIN");
        await installRevisionTracking(
          admin,
          namespace,
          metadataNamespace,
          schema.metadata.entities.map((entity) => entity.sqlName),
        );
        await admin.query("COMMIT");
      } finally {
        admin.release();
      }
      const db = drizzle({ client: owner, relations });
      await db.insert(schema.tables.tasks).values([
        { title: "Alice only", owner: "alice" },
        { title: "Bob only", owner: "bob" },
      ]);
      for (const table of [schema.tables.permissions, schema.tables.policyPermissions]) {
        await db.insert(table).values([
          { subject: "alice", allowed: true },
          { subject: "bob", allowed: true },
        ]);
      }
      await db.insert(schema.tables.unrelated).values({ title: "unrelated" });
      await owner.query(`GRANT USAGE ON SCHEMA "${namespace}" TO "${role}"`);
      await owner.query(`GRANT SELECT ON ALL TABLES IN SCHEMA "${namespace}" TO "${role}"`);
      await owner.query(`ALTER ROLE "${role}" LOGIN PASSWORD 'u3-local-test'`);
      const address = new URL(connectionString);
      address.username = role;
      address.password = "u3-local-test";
      const project = createProjectProcedures(schema, relations);
      const key = (table: string) => JSON.stringify([namespace, table]);
      const broadKeys = schema.metadata.entities.map((entity) => key(entity.sqlName)).sort();
      const input = { columns: { title: true }, count: true };
      for (const variant of ["complete", "disabled", "procedure", "authorization", "policy"] as const) {
        const evaluations = { alice: 0, bob: 0 };
        const transactionalAuthorizations: string[] = [];
        const baseScope = {
          name: "principal",
          version: "1",
          where: ({ table, identity }: { table: typeof schema.tables.tasks; identity: { subject: string } | null }) =>
            sql`${table.owner} = ${identity?.subject ?? "anonymous"} AND EXISTS (
            SELECT 1 FROM ${schema.tables.policyPermissions}
            WHERE ${schema.tables.policyPermissions.subject} = ${identity?.subject ?? "anonymous"}
              AND ${schema.tables.policyPermissions.allowed})`,
        };
        const scope = variant === "policy" ? baseScope : { ...baseScope, dependencies: ["policyPermissions"] as const };
        const live = project.validators.tables.tasks.liveSearch({ columns: ["title"], scope });
        const authored = project.procedure
          .input(live.input)
          .output(live.output)
          .handler(({ context, input }) => {
            const principal = context.identity?.subject;
            assert(principal === "alice" || principal === "bob");
            if (context.operation === "live") evaluations[principal]++;
            return context.search.tasks.watch(input);
          });
        const watch = variant === "procedure" ? authored : withLiveDependencies(relations, [], authored);
        // A declaration does not make arbitrary native SQL a generated-search segment.
        const nativeRead = withLiveDependencies(
          relations,
          [],
          project.procedure
            .use(createDatabaseMiddleware(relations, "read", schema))
            .output(v.array(v.string()))
            .handler(async ({ context }) => {
              const result = await context.db.execute<{ title: string }>(sql`SELECT title FROM ${schema.tables.tasks}`);
              return result.rows.map((row) => row.title);
            }),
        );
        const authorization: Partial<Record<"dependencies", readonly string[]>> = {};
        if (variant !== "authorization") authorization.dependencies = ["permissions"];
        const selection: Partial<Record<"selectiveInvalidation", false>> = {};
        if (variant === "disabled") selection.selectiveInvalidation = false;
        runtime = await createRpcRuntime({
          schema,
          relations,
          connectionString: address.href,
          metadataNamespace,
          version: "03".repeat(32),
          deployment: "selective-u3",
          branchId: "local-disposable",
          environment: { LOOM_SEARCH_CURSOR_KEY: "03".repeat(32) },
          directConnectionString: address.href,
          config: { realtime: { mode, pollIntervalMs: 60000 } },
          assertActive: async () => {},
          auth: defineRpcAuth({
            ...authorization,
            authorize: async ({ db: current, identity, requestId }) => {
              // Subscription ingress has no DB; each snapshot authorizes inside its transaction.
              if (!current) return;
              transactionalAuthorizations.push(requestId);
              const result = await current.execute(sql`SELECT allowed FROM ${schema.tables.permissions}
              WHERE subject = ${identity?.subject ?? "anonymous"}`);
              if (!result.rows[0]?.allowed) throw new ORPCError("FORBIDDEN");
            },
          }),
          ...selection,
          procedures: [
            { path: ["watch"], visibility: "public", procedure: watch },
            { path: ["nativeRead"], visibility: "public", procedure: nativeRead },
          ],
        });
        const current = runtime;
        const contextFor = (subject: string) => {
          const invocation = {
            identity: { issuer: "u3-test", subject },
            requestId: crypto.randomUUID(),
            signal: new AbortController().signal,
          };
          return {
            ...invocation,
            expiresAt: Math.floor(Date.now() / 1000) + 120,
            "effect/context": Context.make(Invocation, invocation),
          };
        };
        const contexts = [contextFor("alice"), contextFor("bob")];
        const route = current.router.watch;
        const native = current.snapshots.nativeRead;
        assert(route instanceof Procedure && native instanceof Procedure);
        const nativeResult = await evaluateSnapshot(() => call(native, undefined, { context: contexts[0]! }));
        expect(nativeResult.value).toEqual(["Alice only", "Bob only"]);
        expect(Object.keys(nativeResult.revisions).sort()).toEqual(broadKeys);
        const streams = await Promise.all(
          contexts.map(async (context) =>
            v.parse(iteratorSchema, await call(route, input, { context, path: ["watch"] })),
          ),
        );
        try {
          const initial = streams.map((stream) => bounded(stream.next()));
          await current.realtime.coordinator.poll();
          const [alice, bob] = await Promise.all(initial);
          expect(alice?.value).toMatchObject({ pages: [[{ title: "Alice only" }]], count: "1" });
          expect(bob?.value).toMatchObject({ pages: [[{ title: "Bob only" }]], count: "1" });
          const before = { ...evaluations };
          await db.update(schema.tables.unrelated).set({ title: crypto.randomUUID() });
          await current.realtime.coordinator.poll();
          const reruns = variant === "complete" ? 0 : 1;
          expect(evaluations).toEqual({ alice: before.alice + reruns, bob: before.bob + reruns });
          if (reruns) {
            const updates = await Promise.all(streams.map((stream) => bounded(stream.next())));
            expect(updates[0]?.value).toMatchObject({ pages: [[{ title: "Alice only" }]] });
            expect(updates[1]?.value).toMatchObject({ pages: [[{ title: "Bob only" }]] });
          }
          {
            // Revoke on the existing two streams, with no reconnect or new principal context.
            await db
              .update(schema.tables.permissions)
              .set({ allowed: false })
              .where(sql`subject = 'alice'`);
            const rejection = assert.rejects(bounded(streams[0]!.next()), { code: "FORBIDDEN" });
            const bobUpdate = bounded(streams[1]!.next());
            await current.realtime.coordinator.poll();
            await rejection;
            expect((await bobUpdate).value).toMatchObject({ pages: [[{ title: "Bob only" }]], count: "1" });
            expect(
              transactionalAuthorizations.filter((id) => id === contexts[0]!.requestId).length,
            ).toBeGreaterThanOrEqual(3);
            // Bob remains live after Alice's native authorization error.
            await db
              .update(schema.tables.tasks)
              .set({ title: "Bob updated" })
              .where(sql`owner = 'bob'`);
            const updated = bounded(streams[1]!.next());
            await current.realtime.coordinator.poll();
            expect((await updated).value).toMatchObject({ pages: [[{ title: "Bob updated" }]], count: "1" });
            await db.update(schema.tables.permissions).set({ allowed: true });
            await db
              .update(schema.tables.tasks)
              .set({ title: "Bob only" })
              .where(sql`owner = 'bob'`);
          }
        } finally {
          await Promise.all(streams.map(async (stream) => stream.return?.()));
          await current.stop();
          runtime = undefined;
        }
      }
    } finally {
      await runtime?.stop();
      await owner.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
      await owner.query(`DROP SCHEMA IF EXISTS "${metadataNamespace}" CASCADE`);
      await owner.query(`DROP ROLE IF EXISTS "${role}"`);
      await owner.end();
    }
  }, 60000);

  // Required acceptance: a missing database is a failure, never a skip.
  test(`U0 ${mode}: native selective live snapshots capture permissions and preserve broad omissions`, async () => {
    const connectionString = process.env.LOOM_TEST_DATABASE_URL;
    assert(connectionString, "LOOM_TEST_DATABASE_URL is required");
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const namespace = `sel_${suffix}`;
    const metadataNamespace = `loom_${suffix}`;
    const role = `sel_role_${suffix}`;
    const schema = defineSchema(
      (f) => ({
        tasks: { title: f.text().notNull() },
        permissions: { allowed: f.boolean().notNull() },
        policyPermissions: { allowed: f.boolean().notNull() },
        unrelated: { title: f.text().notNull() },
      }),
      { namespace },
    );
    const relations = defineRelations(schema.tables);
    const owner = new pg.Pool({ connectionString });
    const effects = createEffectRuntime(Layer.empty);
    let connection: Awaited<ReturnType<typeof connectDatabase<typeof relations>>> | undefined;
    try {
      expect(
        Math.floor(Number((await owner.query("SHOW server_version_num")).rows[0].server_version_num) / 10000),
      ).toBe(18);
      await bootstrapDatabase({ connectionString, metadataNamespace, runtimeRole: role });
      const empty = await generateDrizzleJson({}, undefined, [namespace]);
      const installed = await generateDrizzleJson({ namespace: pgSchema(namespace), ...schema.tables }, empty.id, [
        namespace,
      ]);
      await owner.query((await generateMigration(empty, installed)).join("\n"));
      const admin = await owner.connect();
      try {
        await admin.query("BEGIN");
        await installRevisionTracking(
          admin,
          namespace,
          metadataNamespace,
          schema.metadata.entities.map((entity) => entity.sqlName),
        );
        await admin.query("COMMIT");
      } finally {
        admin.release();
      }
      const db = drizzle({ client: owner, relations });
      await db.insert(schema.tables.tasks).values({ title: "visible" });
      await db.insert(schema.tables.permissions).values({ allowed: true });
      await db.insert(schema.tables.policyPermissions).values({ allowed: true });
      await db.insert(schema.tables.unrelated).values({ title: "unrelated" });
      await owner.query(`GRANT USAGE ON SCHEMA "${namespace}" TO "${role}"`);
      await owner.query(`GRANT SELECT ON ALL TABLES IN SCHEMA "${namespace}" TO "${role}"`);
      await owner.query(`ALTER ROLE "${role}" LOGIN PASSWORD 'selective-local-test'`);
      const address = new URL(connectionString);
      address.username = role;
      address.password = "selective-local-test";
      connection = await connectDatabase({ schema, relations, connectionString: address.href });
      const registry = createDependencyRegistry(metadataNamespace, [{ scope: "", schema }]);
      const project = createProjectProcedures(schema, relations);
      for (const omitted of [
        "none",
        "final-wrapper",
        "derived-undeclared",
        "nested",
        "nested-authorization",
        "procedure",
        "authorization",
        "policy",
      ] as const) {
        let evaluations = 0;
        let policyCalls = 0;
        let middlewareCalls = 0;
        let nestedAuthorizations = 0;
        const invokesNested = omitted === "nested" || omitted === "nested-authorization";
        const captured: string[][] = [];
        const policyCallsAtCapture: number[] = [];
        const basePolicyScope = {
          name: "permitted",
          version: "1",
          where: () => {
            policyCalls++;
            return sql`EXISTS (SELECT 1 FROM ${schema.tables.policyPermissions} WHERE ${schema.tables.policyPermissions.allowed})`;
          },
        };
        const policyScope =
          omitted === "policy" ? basePolicyScope : { ...basePolicyScope, dependencies: ["policyPermissions"] as const };
        const live = project.validators.tables.tasks.liveSearch({ columns: ["title"], scope: policyScope });
        let nestedRoute: AnyProcedure | undefined;
        let nestedReads = 0;
        const nested = withLiveDependencies(
          relations,
          [],
          project.procedure
            .input(live.input)
            .output(live.output)
            .handler(({ context, input }) => {
              nestedReads++;
              return context.search.tasks.watch(input);
            }),
        );
        const authored = project.procedure
          .input(live.input)
          .output(live.output)
          .handler(async ({ context, input }) => {
            evaluations++;
            if (invokesNested && context.operation === "live") {
              assert(nestedRoute);
              const child = v.parse(iteratorSchema, await call(nestedRoute, input, { context, path: ["nested"] }));
              try {
                expect((await child.next()).done).toBe(false);
              } finally {
                await child.return?.();
              }
            }
            return context.search.tasks.watch(input);
          });
        const wrapped = omitted === "procedure" ? authored : withLiveDependencies(relations, [], authored);
        const derived = wrapped.use(({ next }) => {
          middlewareCalls++;
          return next();
        });
        const procedure =
          omitted === "derived-undeclared"
            ? derived
            : omitted === "final-wrapper"
              ? withLiveDependencies(relations, [], derived)
              : wrapped;
        const selective = omitted === "none" || omitted === "nested" || omitted === "final-wrapper";
        const observedRegistry = {
          ...registry,
          read: async (database: Parameters<typeof registry.read>[0], keys: Iterable<string> = registry.keys) => {
            const selected = [...keys];
            captured.push(selected.sort());
            policyCallsAtCapture.push(policyCalls);
            return registry.read(database, selected);
          },
        };
        const coordinatorOptions = {
          intervalMs: 60000,
          readRevisions: () => registry.read(connection!.db),
        };
        const coordinator = createRevisionCoordinator(
          mode === "notify"
            ? {
                ...coordinatorOptions,
                wakeups: (wake) =>
                  listenForRevisions(
                    { connectionString: address.href, runtimeRole: role, metadataNamespace, namespace },
                    wake,
                  ),
              }
            : coordinatorOptions,
        );
        const authorize = async ({ db: current, path }: { db: NodePgDatabase; path: readonly string[] }) => {
          if (path.at(-1) === "nested") nestedAuthorizations++;
          const result = await current.select().from(schema.tables.permissions);
          if (!result[0]?.allowed) throw new ORPCError("FORBIDDEN");
        };
        const baseDependencies = { registry: observedRegistry, selective: true };
        const dependencies =
          omitted === "authorization" ? baseDependencies : { ...baseDependencies, authorization: ["permissions"] };
        const runtimeOptions = {
          database: {
            connection,
            replay: { metadataNamespace, deployment: "selective-test" },
            revisions: registry.read,
            dependencies,
            search: { branchId: "local-disposable", key: "03".repeat(32) },
            authorize,
          },
          effects,
          coordinator,
          activate: async () => {},
          authorize: async () => {},
        };
        const graph = bindRuntimeGraph({
          ...runtimeOptions,
          entries: [{ path: ["watch"], visibility: "public", procedure }],
        });
        // The parent stays fully declared. Only the nested binding omits auth
        // evidence, so its segment must broaden the owning outer attempt.
        const childGraph = bindRuntimeGraph({
          ...runtimeOptions,
          database: {
            ...runtimeOptions.database,
            dependencies: omitted === "nested-authorization" ? baseDependencies : dependencies,
          },
          entries: [{ path: ["nested"], visibility: "internal", procedure: nested }],
        });
        nestedRoute = childGraph.internal[0]?.procedure;
        const invocation = { identity: null, requestId: crypto.randomUUID(), signal: new AbortController().signal };
        const context = {
          ...invocation,
          expiresAt: Math.floor(Date.now() / 1000) + 120,
          "effect/context": Context.make(Invocation, invocation),
        };
        const route = graph.router.watch;
        assert(route instanceof Procedure);
        if (omitted === "none") {
          // Client fields cannot author server completeness declarations or enter a transaction.
          for (const forged of [
            { dependencies: [] },
            { dependencies: ["unrelated"] },
            { liveDependencies: { graph: "client", tables: [] } },
            { scope: { dependencies: [] } },
          ]) {
            await assert.rejects(
              call(route, { columns: { title: true }, count: true, ...forged }, { context, path: ["watch"] }),
              { code: "BAD_REQUEST" },
            );
            expect(evaluations).toBe(0);
            expect(policyCalls).toBe(0);
            expect(captured).toEqual([]);
          }
        }
        const stream = v.parse(
          iteratorSchema,
          await call(route, { columns: { title: true }, count: true }, { context, path: ["watch"] }),
        );
        try {
          const first = stream.next();
          await coordinator.poll();
          const initial = await bounded(first);
          expect(initial.done).toBe(false);
          expect(initial.value).toMatchObject({ pages: [[{ title: "visible" }]], count: "1" });
          // Native RQB builds RAW lazily; count executes the same policy separately.
          // The captured union must be finalized after both callbacks, including their policy dependency.
          const expectedPolicyCalls = invokesNested ? 4 : 2;
          if (invokesNested) expect(nestedAuthorizations).toBe(1);
          expect(policyCalls).toBe(expectedPolicyCalls);
          expect(policyCallsAtCapture).toEqual([expectedPolicyCalls]);
          // Subscription setup and its initial snapshot each run authored middleware.
          if (omitted === "final-wrapper" || omitted === "derived-undeclared") expect(middlewareCalls).toBe(2);
          expect(captured.at(-1)).toEqual(
            selective
              ? ["permissions", "policy_permissions", "tasks"].map((name) => JSON.stringify([namespace, name])).sort()
              : [...registry.keys],
          );
          const before = evaluations;
          await db.update(schema.tables.unrelated).set({ title: crypto.randomUUID() });
          await coordinator.poll();
          expect(evaluations - before).toBe(selective ? 0 : 1);
          if (invokesNested) {
            expect(nestedReads).toBe(selective ? 1 : 2);
            expect(nestedAuthorizations).toBe(selective ? 1 : 2);
          }
          if (omitted === "nested-authorization") expect(captured.at(-1)).toEqual([...registry.keys]);
          if (!selective) await bounded(stream.next());
          {
            await db.update(schema.tables.policyPermissions).set({ allowed: false });
            const policyUpdate = stream.next();
            await coordinator.poll();
            const filtered = await bounded(policyUpdate);
            expect(filtered.value).toMatchObject({ pages: [], count: "0" });
            await db.update(schema.tables.policyPermissions).set({ allowed: true });
            const restored = stream.next();
            await coordinator.poll();
            await bounded(restored);
            await db.update(schema.tables.permissions).set({ allowed: false });
            const revoked = stream.next();
            const rejection = assert.rejects(bounded(revoked), { code: "FORBIDDEN" });
            await coordinator.poll();
            await rejection;
            await db.update(schema.tables.permissions).set({ allowed: true });
          }
        } finally {
          await stream.return?.();
          await graph.stop();
          await childGraph.stop();
          await coordinator.stop();
        }
      }
    } finally {
      await effects.stop();
      await connection?.close();
      await owner.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
      await owner.query(`DROP SCHEMA IF EXISTS "${metadataNamespace}" CASCADE`);
      await owner.query(`DROP ROLE IF EXISTS "${role}"`);
      await owner.end();
    }
  }, 60000);

  // Missing infrastructure must fail this acceptance gate, never turn it into a skip.
  test(`U1 ${mode}: PG18 qualified registry covers root and sibling mounts and isolates transaction attempts`, async () => {
    const connectionString = process.env.LOOM_TEST_DATABASE_URL;
    assert(connectionString, "LOOM_TEST_DATABASE_URL is required");
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const metadataNamespace = `loom_registry_${suffix}`;
    const role = `registry_${suffix}`;
    const namespaces = ["root", "first", "second"].map((name) => `reg_${name}_${suffix}`);
    const [rootNamespace, firstNamespace, secondNamespace] = namespaces;
    assert(rootNamespace && firstNamespace && secondNamespace);
    const makeSchema = (namespace: string) =>
      defineSchema((f) => ({ sharedEvents: { title: f.text().notNull() } }), { namespace });
    const root = makeSchema(rootNamespace);
    const first = makeSchema(firstNamespace);
    const second = makeSchema(secondNamespace);
    const empty = defineSchema(() => ({}), { namespace: `reg_empty_${suffix}` });
    const relations = defineRelations(root.tables);
    const firstRelations = defineRelations(first.tables);
    const emptyRelations = defineRelations(empty.tables);
    const registry = createDependencyRegistry(metadataNamespace, [
      { scope: "", schema: root },
      { scope: "first", schema: first },
      { scope: "second", schema: second },
      { scope: "empty", schema: empty },
    ]);
    const key = (namespace: string) => JSON.stringify([namespace, "shared_events"]);
    const expectedKeys = namespaces.map(key).sort();
    const decimal = "9007199254740993";
    const expected = Object.fromEntries(
      namespaces.map((namespace, index) => [key(namespace), index ? String(index + 1) : decimal]),
    );
    const owner = new pg.Client({ connectionString });
    await owner.connect();
    let connection: Awaited<ReturnType<typeof connectDatabase<typeof relations>>> | undefined;
    let runtime: Awaited<ReturnType<typeof createRpcRuntime<typeof relations>>> | undefined;
    try {
      expect(
        Math.floor(Number((await owner.query("SHOW server_version_num")).rows[0].server_version_num) / 10000),
      ).toBe(18);
      await bootstrapDatabase({ connectionString, metadataNamespace, runtimeRole: role });
      for (const [index, namespace] of namespaces.entries()) {
        await owner.query(`CREATE SCHEMA "${namespace}"`);
        await owner.query(`CREATE TABLE "${namespace}".shared_events (
        "_id" uuid PRIMARY KEY DEFAULT uuidv7(),
        "_createdAt" bigint NOT NULL DEFAULT 1,
        title text NOT NULL
      )`);
        await owner.query(`INSERT INTO "${namespace}".shared_events (title) VALUES ($1)`, [String(index)]);
        await owner.query("BEGIN");
        await installRevisionTracking(owner, namespace, metadataNamespace, ["shared_events"]);
        await owner.query("COMMIT");
        await owner.query(`UPDATE "${metadataNamespace}".table_revisions SET revision = $1 WHERE namespace = $2`, [
          index ? String(index + 1) : decimal,
          namespace,
        ]);
        await owner.query(`GRANT USAGE ON SCHEMA "${namespace}" TO "${role}"`);
        await owner.query(`GRANT SELECT ON ALL TABLES IN SCHEMA "${namespace}" TO "${role}"`);
      }
      await owner.query(`ALTER ROLE "${role}" LOGIN PASSWORD 'registry-local-test'`);
      const address = new URL(connectionString);
      address.username = role;
      address.password = "registry-local-test";
      connection = await connectDatabase({ schema: root, relations, connectionString: address.href });
      const database = connection;
      expect(root.metadata.entities[0]?.name).toBe("sharedEvents");
      expect(root.metadata.entities[0]?.sqlName).toBe("shared_events");
      expect(registry.keys).toEqual(expectedKeys);
      expect(registry.resolve("first", firstRelations, ["sharedEvents", "sharedEvents"])).toEqual([
        key(firstNamespace),
      ]);
      expect(() => registry.resolve("first", undefined, ["shared_events"])).toThrow(/Unknown live dependency/);
      expect(() => registry.resolve("missing", undefined, [])).toThrow(/Unknown dependency scope/);
      expect(registry.resolve("empty", emptyRelations, [])).toEqual([]);
      expect(await registry.read(database.db, [])).toEqual({});
      expect(await registry.read(database.db)).toEqual(expected);
      const emptyRegistry = createDependencyRegistry(metadataNamespace, [{ scope: "empty", schema: empty }]);
      expect(await emptyRegistry.read(database.db)).toEqual({});
      // The public reader retains bare SQL names and exact decimal strings.
      expect(
        await createRevisionReader({ namespace: rootNamespace, metadataNamespace, tables: ["shared_events"] })(
          database.db,
        ),
      ).toEqual({ shared_events: decimal });

      const childCaller = v.object({
        rpc: v.custom<{ read: () => Promise<string[]> }>((value) => {
          if (!v.is(v.object({}), value)) return false;
          // SAFETY: value is an object; its optional property remains unknown until the function schema checks it.
          const caller = value as { read?: unknown };
          return v.is(v.function(), caller.read);
        }),
      });
      const componentsSchema = v.object({
        components: v.object({ first: v.optional(childCaller), second: v.optional(childCaller) }),
      });
      const read = (schema: typeof root) => {
        const graph = defineRelations(schema.tables);
        return createProjectProcedures(schema)
          .procedure.use(({ context, next }) => next({ context: v.parse(componentsSchema, context) }))
          .use(createDatabaseMiddleware(graph, "read", schema))
          .output(v.array(v.string()));
      };
      const secondRead = read(second).handler(async ({ context }) =>
        (await context.db.query.sharedEvents.findMany({ columns: { title: true } })).map((row) => row.title),
      );
      const firstRead = read(first).handler(async ({ context }) => [
        ...(await context.db.query.sharedEvents.findMany({ columns: { title: true } })).map((row) => row.title),
        ...(await context.components.second!.rpc.read()),
      ]);
      const rootRead = read(root)
        .input(v.boolean())
        .handler(async ({ context, input }) => [
          ...(await context.db.query.sharedEvents.findMany({ columns: { title: true } })).map((row) => row.title),
          ...(input ? await context.components.first!.rpc.read() : []),
        ]);
      const firstProject = createProjectProcedures(first, firstRelations);
      const live = firstProject.validators.tables.sharedEvents.liveSearch({ columns: ["title"], scope: "public" });
      const reusedWatch = withLiveDependencies(
        firstRelations,
        [],
        firstProject.procedure
          .input(live.input)
          .output(live.output)
          .handler(({ context, input }) => context.search.sharedEvents.watch(input)),
      );
      const application = defineApplication({ rpc: ({ os }) => ({ os }) });
      const secondMount = application.use(defineComponent({ name: "second" }));
      application.use(defineComponent({ name: "first" }), { dependencies: { second: secondMount } });
      application.use(defineComponent({ name: "empty" }));
      application.use(defineComponent({ name: "firstAlias" }));
      runtime = await createRpcRuntime({
        application,
        directConnectionString: address.href,
        config: { realtime: { mode, pollIntervalMs: 60000 } },
        schema: root,
        relations,
        connectionString: address.href,
        metadataNamespace,
        version: "03".repeat(32),
        deployment: "registry-u1",
        auth: defineRpcAuth({ allowAnonymous: true, dependencies: [], authorize: () => {} }),
        // Explicit enablement remains supported alongside the assembled U3 default fixture.
        selectiveInvalidation: true,
        branchId: "local-disposable",
        environment: { LOOM_SEARCH_CURSOR_KEY: "03".repeat(32) },
        assertActive: async () => {},
        procedures: [
          { path: ["read"], visibility: "public", procedure: rootRead },
          { scope: "first", path: ["read"], visibility: "exported", procedure: firstRead },
          { scope: "second", path: ["read"], visibility: "exported", procedure: secondRead },
          { scope: "first", path: ["watch"], visibility: "exported", procedure: reusedWatch },
          { scope: "firstAlias", path: ["watch"], visibility: "exported", procedure: reusedWatch },
        ],
        scopes: [
          { name: "", dependencies: { first: "first" } },
          { name: "first", schema: first, dependencies: { second: "second" } },
          { name: "second", schema: second, dependencies: {} },
          { name: "empty", schema: empty, dependencies: {} },
          { name: "firstAlias", schema: first, dependencies: {} },
        ],
        exposures: [
          { scope: "first", prefix: "first" },
          { scope: "second", prefix: "second" },
          { scope: "firstAlias", prefix: "firstAlias" },
        ],
      });
      const route = runtime.snapshots.read;
      assert(route instanceof Procedure);
      const invocation = { identity: null, requestId: crypto.randomUUID(), signal: new AbortController().signal };
      const context = { ...invocation, "effect/context": Context.make(Invocation, invocation) };
      for (const nested of [false, true]) {
        const captured = await evaluateSnapshot(() => call(route, nested, { context }));
        expect(captured).toEqual({ value: nested ? ["0", "1", "2"] : ["0"], revisions: expected });
        expect(captured).not.toHaveProperty("confirmationEvidence");
      }
      // The same authored object is bound twice. These mounts deliberately share
      // the exact compiled graph; distinct-namespace graph remapping is not an API.
      for (const scope of ["first", "firstAlias"]) {
        const router = runtime.snapshots[scope];
        assert(router && !(router instanceof Procedure));
        const watch = v.parse(
          v.object({ watch: v.custom<AnyProcedure>((value) => value instanceof Procedure) }),
          router,
        ).watch;
        assert(watch instanceof Procedure);
        const captured = await evaluateLiveSnapshot(Symbol(scope), () =>
          evaluateSnapshot(async () => {
            const stream = v.parse(
              iteratorSchema,
              await call(watch, { columns: { title: true }, count: true }, { context, path: [scope, "watch"] }),
            );
            try {
              const result = await bounded(stream.next());
              expect(result.done).toBe(false);
              return result.value;
            } finally {
              await stream.return?.();
            }
          }),
        );
        expect(captured.value).toMatchObject({ pages: [[{ title: "1" }]], count: "1" });
        expect(captured.revisions).toEqual({ [key(firstNamespace)]: "2" });
      }
      await owner.query(`DELETE FROM "${metadataNamespace}".table_revisions WHERE namespace = $1`, [secondNamespace]);
      await assert.rejects(
        runFunctionTransaction(database, "query", (tx) => registry.read(tx)),
        /Missing tracked table revision/,
      );
      await assert.rejects(evaluateSnapshot(() => call(route, false, { context })));
      await owner.query(`INSERT INTO "${metadataNamespace}".table_revisions VALUES ($1, 'shared_events', 3)`, [
        secondNamespace,
      ]);

      // Separate complete segments must union their qualified keys, including repeated SQL names.
      const union = await evaluateSnapshot(async () => {
        const candidate = await runFunctionTransaction(database, "query", (tx) =>
          runSnapshotAttempt(tx, registry, true, async () => {
            for (const namespace of [secondNamespace, firstNamespace, secondNamespace]) {
              registerSnapshotSegment({ registry, keys: [key(namespace)] })([], true);
              await tx.execute(sql`SELECT title FROM ${sql.identifier(namespace)}.shared_events`);
            }
            return "union";
          }),
        );
        acceptSnapshotAttempt(candidate);
        return candidate.value;
      });
      expect(union).toEqual({ value: "union", revisions: { [key(firstNamespace)]: "2", [key(secondNamespace)]: "3" } });

      // A deferred PG constraint raises a real serialization error at COMMIT, after finalization.
      await owner.query(`CREATE TABLE "${rootNamespace}".retry_gate (fail boolean NOT NULL)`);
      await owner.query(`CREATE FUNCTION "${rootNamespace}".reject_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.fail THEN RAISE EXCEPTION 'retry gate' USING ERRCODE = '40001'; END IF; RETURN NEW; END $$`);
      await owner.query(`CREATE CONSTRAINT TRIGGER retry_gate AFTER INSERT ON "${rootNamespace}".retry_gate
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "${rootNamespace}".reject_attempt()`);
      await owner.query(`GRANT SELECT, INSERT ON "${rootNamespace}".retry_gate TO "${role}"`);
      let attempts = 0;
      const finalized: Record<string, string>[] = [];
      let rejectedCandidate: Awaited<ReturnType<typeof runSnapshotAttempt<string>>> | undefined;
      const retried = await evaluateSnapshot(async () => {
        const candidate = await runFunctionTransaction(
          database,
          "mutation",
          async (tx) => {
            const fail = ++attempts === 1;
            const candidate = await runSnapshotAttempt(tx, registry, true, async () => {
              registerSnapshotSegment({ registry, keys: [key(fail ? secondNamespace : firstNamespace)] })([], true);
              await tx.execute(sql`INSERT INTO ${sql.identifier(rootNamespace)}.retry_gate VALUES (${fail})`);
              return fail ? "discarded" : "accepted";
            });
            finalized.push({ ...candidate.revisions });
            if (fail) rejectedCandidate = candidate;
            return candidate;
          },
          { maxAttempts: 2 },
        );
        const stale = rejectedCandidate;
        assert(stale);
        expect(() => acceptSnapshotAttempt(stale)).toThrow(/owning attempt/);
        acceptSnapshotAttempt(candidate);
        return candidate.value;
      });
      expect(attempts).toBe(2);
      expect(finalized).toEqual([{ [key(secondNamespace)]: "3" }, { [key(firstNamespace)]: "2" }]);
      expect(retried).toEqual({ value: "accepted", revisions: { [key(firstNamespace)]: "2" } });
      expect((await owner.query(`SELECT fail FROM "${rootNamespace}".retry_gate`)).rows).toEqual([{ fail: false }]);

      await assert.rejects(
        evaluateSnapshot(() =>
          runFunctionTransaction(database, "query", (tx) =>
            runSnapshotAttempt(tx, registry, false, async () => {
              await runFunctionTransaction(database, "query", (foreign) =>
                runSnapshotAttempt(foreign, registry, false, async () => "foreign"),
              );
              return "foreign";
            }),
          ),
        ),
        /second transaction/,
      );
    } finally {
      await runtime?.stop();
      await connection?.close();
      for (const namespace of namespaces) await owner.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
      await owner.query(`DROP SCHEMA IF EXISTS "${metadataNamespace}" CASCADE`);
      await owner.query(`DROP ROLE IF EXISTS "${role}"`);
      await owner.end();
    }
  }, 60000);
}

for (const mode of ["polling", "notify"] as const) {
  test(`U4 ${mode}: native graph, SQL commits, dynamic dependencies and lifecycle`, async () => {
    const connectionString = process.env.LOOM_TEST_DATABASE_URL;
    assert(connectionString, "LOOM_TEST_DATABASE_URL is required");
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const namespace = `matrix_${suffix}`;
    const metadataNamespace = `loom_matrix_${suffix}`;
    const role = `matrix_role_${suffix}`;
    const schema = defineSchema(
      (f) => ({
        tasks: { title: f.text().notNull() },
        labels: { name: f.text().notNull(), active: f.boolean().notNull() },
        taskLabels: { taskId: f.reference("tasks").notNull(), labelId: f.reference("labels").notNull() },
        selector: { expanded: f.boolean().notNull(), fail: f.boolean().notNull() },
        middlewarePermissions: { allowed: f.boolean().notNull() },
        permissions: { allowed: f.boolean().notNull() },
        unrelated: { title: f.text().notNull() },
      }),
      { namespace },
    );
    const relations = defineRelations(schema.tables, (r) => ({
      tasks: {
        labels: r.many.labels({
          from: r.tasks._id.through(r.taskLabels.taskId),
          to: r.labels._id.through(r.taskLabels.labelId),
          where: { active: true },
        }),
      },
      labels: {
        tasks: r.many.tasks({
          from: r.labels._id.through(r.taskLabels.labelId),
          to: r.tasks._id.through(r.taskLabels.taskId),
        }),
      },
    }));
    const registry = createDependencyRegistry(metadataNamespace, [{ scope: "", schema }]);
    const key = (table: string) => JSON.stringify([namespace, table]);
    const owner = new pg.Pool({ connectionString });
    const effects = createEffectRuntime(Layer.empty);
    let connection: Awaited<ReturnType<typeof connectDatabase<typeof relations>>> | undefined;
    let graph: ReturnType<typeof bindRuntimeGraph<typeof relations>> | undefined;
    let coordinator: ReturnType<typeof createRevisionCoordinator> | undefined;
    const streams: AsyncIteratorObject<unknown, unknown>[] = [];
    const releaseStartup = Promise.withResolvers<void>();
    try {
      expect((await owner.query("SHOW server_version")).rows[0].server_version).toMatch(/^18\b/);
      await bootstrapDatabase({ connectionString, metadataNamespace, runtimeRole: role });
      const empty = await generateDrizzleJson({}, undefined, [namespace]);
      const installed = await generateDrizzleJson({ namespace: pgSchema(namespace), ...schema.tables }, empty.id, [
        namespace,
      ]);
      await owner.query((await generateMigration(empty, installed)).join("\n"));
      const admin = await owner.connect();
      try {
        await admin.query("BEGIN");
        await installRevisionTracking(
          admin,
          namespace,
          metadataNamespace,
          schema.metadata.entities.map((entity) => entity.sqlName),
        );
        await admin.query("COMMIT");
      } finally {
        admin.release();
      }
      // Deliberately outside the registered schema and trigger set.
      await owner.query(`CREATE TABLE "${namespace}".external_state (allowed boolean NOT NULL)`);
      await owner.query(`INSERT INTO "${namespace}".external_state VALUES (true)`);
      const db = drizzle({ client: owner, relations });
      const [task] = await db.insert(schema.tables.tasks).values({ title: "root" }).returning();
      const [label] = await db.insert(schema.tables.labels).values({ name: "child", active: true }).returning();
      assert(task && label);
      await db.insert(schema.tables.taskLabels).values({ taskId: task._id, labelId: label._id });
      await db.insert(schema.tables.selector).values({ expanded: false, fail: false });
      await db.insert(schema.tables.permissions).values({ allowed: true });
      await db.insert(schema.tables.middlewarePermissions).values({ allowed: true });
      await db.insert(schema.tables.unrelated).values({ title: "unrelated" });
      await owner.query(`GRANT USAGE ON SCHEMA "${namespace}" TO "${role}"`);
      await owner.query(`GRANT SELECT ON ALL TABLES IN SCHEMA "${namespace}" TO "${role}"`);
      await owner.query(`ALTER ROLE "${role}" LOGIN PASSWORD 'matrix-local-test'`);
      const address = new URL(connectionString);
      address.username = role;
      address.password = "matrix-local-test";
      connection = await connectDatabase({ schema, relations, connectionString: address.href });
      const database = connection;
      const captured: string[][] = [];
      const observedRegistry = {
        ...registry,
        read: async (current: NodePgDatabase, selected: Iterable<string> = registry.keys) => {
          const keys = [...selected].sort();
          const revisions = await registry.read(current, keys);
          captured.push(keys);
          return revisions;
        },
      };
      let evaluations = 0;
      let authorizations = 0;
      let middlewareReads = 0;
      let wakeCount = 0;
      const listenerStarted = Promise.withResolvers<void>();
      let startup = true;
      let missingPolledKey = false;
      const options = {
        intervalMs: 60000,
        readRevisions: async () => {
          const revisions = await registry.read(database.db);
          // Fault injection follows the actual PG read, after native snapshot capture.
          return missingPolledKey
            ? Object.fromEntries(Object.entries(revisions).filter(([name]) => name !== key("tasks")))
            : revisions;
        },
      };
      coordinator = createRevisionCoordinator(
        mode === "notify"
          ? {
              ...options,
              wakeups: (wake) => {
                let listener: ReturnType<typeof listenForRevisions> | undefined;
                listenerStarted.resolve();
                const ready = (async () => {
                  // Commit after listener startup is requested but before any LISTEN exists.
                  if (startup) await releaseStartup.promise;
                  listener = listenForRevisions(
                    { connectionString: address.href, runtimeRole: role, metadataNamespace, namespace },
                    () => {
                      wakeCount++;
                      wake();
                    },
                  );
                  await listener.ready;
                })();
                return {
                  ready,
                  stop: async () => {
                    await ready;
                    await listener?.stop();
                  },
                };
              },
            }
          : options,
      );
      const current = coordinator;
      const project = createProjectProcedures(schema, relations);
      const live = project.validators.tables.tasks.liveSearch({
        scope: "public",
        columns: ["title"],
        through: { taskLabels: "public" },
        relations: { labels: { scope: "public", columns: ["name"], filter: ["name"] } },
      });
      let externalEvaluations = 0;
      const externalLive = project.validators.tables.tasks.liveSearch({
        columns: ["title"],
        scope: {
          name: "external-exclusion",
          version: "1",
          dependencies: [],
          where: () => sql`EXISTS (SELECT 1 FROM ${sql.identifier(namespace)}.external_state WHERE allowed)`,
        },
      });
      const externalWatch = withLiveDependencies(
        relations,
        [],
        project.procedure
          .input(externalLive.input)
          .output(externalLive.output)
          .handler(({ context, input }) => {
            if (context.operation === "live") externalEvaluations++;
            return context.search.tasks.watch(input);
          }),
      );
      const childLive = project.validators.tables.labels.liveSearch({
        scope: "public",
        columns: ["name"],
        through: { taskLabels: "public" },
        relations: { tasks: { scope: "public", columns: ["title"] } },
      });
      const childWatch = withLiveDependencies(
        relations,
        [],
        project.procedure
          .input(childLive.input)
          .output(childLive.output)
          .handler(({ context, input }) => context.search.labels.watch(input)),
      );
      let childRoute: AnyProcedure | undefined;
      let pause:
        | {
            entered: ReturnType<typeof Promise.withResolvers<void>>;
            release: ReturnType<typeof Promise.withResolvers<void>>;
          }
        | undefined;
      const authored = project.procedure
        .errors({ BAD_REQUEST: {} })
        .use(createDatabaseMiddleware(relations, "read", schema))
        .use(async ({ context, next }) => {
          if (context.operation === "live") {
            middlewareReads++;
            const rows = await context.db.select().from(schema.tables.middlewarePermissions);
            if (!rows[0]?.allowed) throw new ORPCError("FORBIDDEN");
          }
          return next();
        })
        .input(live.input)
        .output(live.output)
        .handler(async ({ context, input }) => {
          if (context.operation !== "live") return context.search.tasks.watch(input);
          evaluations++;
          const [selection] = await context.db.select().from(schema.tables.selector);
          assert(selection);
          const barrier = pause;
          if (barrier) {
            pause = undefined;
            barrier.entered.resolve();
            await barrier.release.promise;
          }
          if (selection.expanded) {
            assert(childRoute);
            const child = v.parse(
              iteratorSchema,
              await call(
                childRoute,
                { columns: { name: true }, with: { tasks: { columns: { title: true } } }, count: true },
                { context, path: ["child"] },
              ),
            );
            try {
              expect((await child.next()).done).toBe(false);
            } finally {
              await child.return?.();
            }
          }
          const result = await context.search.tasks.watch(input);
          if (selection.fail) throw new ORPCError("BAD_REQUEST");
          return result;
        });
      const watch = withLiveDependencies(relations, ["selector", "middlewarePermissions"], authored);
      graph = bindRuntimeGraph({
        entries: [
          { path: ["watch"], visibility: "public", procedure: watch },
          { path: ["child"], visibility: "internal", procedure: childWatch },
          { path: ["external"], visibility: "public", procedure: externalWatch },
        ],
        database: {
          connection: database,
          replay: { metadataNamespace, deployment: "matrix" },
          revisions: registry.read,
          dependencies: { registry: observedRegistry, selective: true, authorization: ["permissions"] },
          search: { branchId: "local-disposable", key: "03".repeat(32) },
          authorize: async ({ db: current }) => {
            if (!current) return;
            authorizations++;
            const result = await current.select().from(schema.tables.permissions);
            if (!result[0]?.allowed) throw new ORPCError("FORBIDDEN");
          },
        },
        effects,
        coordinator: current,
        activate: async () => {},
        authorize: async () => {},
      });
      childRoute = graph.internal[0]?.procedure;
      const route = graph.router.watch;
      assert(route instanceof Procedure);
      const open = async (
        input: InferSchemaInput<typeof live.input> = {
          columns: { title: true },
          with: { labels: { columns: { name: true } } },
          count: true,
        },
        expiresAt = Math.floor(Date.now() / 1000) + 120,
        target: AnyProcedure = route,
      ) => {
        const controller = new AbortController();
        const invocation = { identity: null, requestId: crypto.randomUUID(), signal: controller.signal };
        const stream = v.parse(
          iteratorSchema,
          await call(target, input, {
            context: { ...invocation, expiresAt, "effect/context": Context.make(Invocation, invocation) },
            path: [target === route ? "watch" : "external"],
          }),
        );
        streams.push(stream);
        return { stream, controller };
      };
      const { stream } = await open();
      const initial = bounded(stream.next());
      const initialPoll = current.poll();
      if (mode === "notify") {
        await bounded(listenerStarted.promise);
        await owner.query(`UPDATE "${namespace}".tasks SET title = 'startup'`);
        releaseStartup.resolve();
      }
      await initialPoll;
      expect((await initial).value).toMatchObject({
        pages: [[{ title: mode === "notify" ? "startup" : "root" }]],
        count: "1",
      });
      startup = false;
      if (mode === "notify") {
        expect(wakeCount).toBeGreaterThan(0);
        // Prove a native notification causes evaluation without an explicit poll.
        const update = bounded(stream.next());
        await owner.query(`UPDATE "${namespace}".tasks SET title = 'notified'`);
        expect((await update).value).toMatchObject({ pages: [[{ title: "notified" }]] });
        await current.poll();
      }
      if (mode === "notify") {
        const listenerPid = async () => {
          const result = await owner.query<{ pid: number }>(
            "SELECT pid FROM pg_stat_activity WHERE usename = $1 AND query LIKE 'LISTEN %' AND state = 'idle'",
            [role],
          );
          return result.rows[0]?.pid;
        };
        const originalPid = await listenerPid();
        assert(originalPid, "Native listener must have completed LISTEN");
        const termination = await owner.query<{ terminated: boolean }>(
          "SELECT pg_terminate_backend($1) AS terminated",
          [originalPid],
        );
        expect(termination.rows[0]?.terminated).toBe(true);
        const duringDisconnect = bounded(stream.next());
        await owner.query(`UPDATE "${namespace}".tasks SET title = 'listener disconnected'`);
        await current.poll();
        expect((await duringDisconnect).value).toMatchObject({ pages: [[{ title: "listener disconnected" }]] });
        // Positive readiness barrier: wait for a new backend whose LISTEN completed.
        const deadline = Date.now() + 10000;
        let reconnectedPid = await listenerPid();
        while ((!reconnectedPid || reconnectedPid === originalPid) && Date.now() < deadline) {
          await owner.query("SELECT pg_sleep(0.01)");
          reconnectedPid = await listenerPid();
        }
        assert(reconnectedPid && reconnectedPid !== originalPid, "Native listener must reconnect");
        const notifiedAgain = bounded(stream.next());
        await owner.query(`UPDATE "${namespace}".tasks SET title = 'listener reconnected'`);
        expect((await notifiedAgain).value).toMatchObject({ pages: [[{ title: "listener reconnected" }]] });
        await current.poll();
      }
      const narrow = ["tasks", "selector", "middleware_permissions", "permissions"].map(key).sort();
      const expanded = [...narrow, key("labels"), key("task_labels")].sort();
      expect(captured.at(-1)).toEqual(expanded);
      const unchanged = async (statement: string) => {
        const before = { evaluations, authorizations, middlewareReads };
        await owner.query(statement);
        await current.poll();
        await current.poll();
        expect({ evaluations, authorizations, middlewareReads }).toEqual(before);
      };
      await unchanged(`UPDATE "${namespace}".unrelated SET title = 'ignored'`);
      // External state is not tracked, even though the restricted reader can read it.
      await unchanged(`UPDATE "${namespace}".external_state SET allowed = false`);
      expect(registry.keys).not.toContain(key("external_state"));
      interface ExpectedWindow {
        pages?: { title?: string; labels?: { name: string }[] }[][];
        count?: string;
      }
      const update = async (statement: string, value: ExpectedWindow) => {
        const next = bounded(stream.next());
        await owner.query(statement);
        await current.poll();
        expect((await next).value).toMatchObject(value);
      };
      await update(`UPDATE "${namespace}".selector SET expanded = true`, {
        pages: [[{ labels: [{ name: "child" }] }]],
        count: "1",
      });
      expect(captured.at(-1)).toEqual(expanded);
      await update(`UPDATE "${namespace}".labels SET name = 'child updated'`, {
        pages: [[{ labels: [{ name: "child updated" }] }]],
      });
      await update(`DELETE FROM "${namespace}".task_labels`, { pages: [[{ labels: [] }]], count: "1" });
      await update(
        `INSERT INTO "${namespace}".task_labels (task_id, label_id) VALUES ('${task._id}', '${label._id}')`,
        { pages: [[{ labels: [{ name: "child updated" }] }]] },
      );
      // Native relation-level predicates participate even without a projected predicate column.
      await update(`UPDATE "${namespace}".labels SET active = false`, { pages: [[{ labels: [] }]] });
      await update(`UPDATE "${namespace}".labels SET active = true`, {
        pages: [[{ labels: [{ name: "child updated" }] }]],
      });
      await stream.return?.();
      await owner.query(`UPDATE "${namespace}".selector SET expanded = false`);
      // Relation predicate without projection still captures both child and junction.
      const predicate = await open({
        columns: { title: true },
        count: true,
        where: { relations: { labels: { some: { name: { eq: "child updated" } } } } },
      });
      const predicateFirst = bounded(predicate.stream.next());
      await current.poll();
      expect((await predicateFirst).value).toMatchObject({ count: "1" });
      expect(captured.at(-1)).toEqual(expanded);
      const predicateNext = bounded(predicate.stream.next());
      await owner.query(`UPDATE "${namespace}".labels SET name = 'excluded'`);
      await current.poll();
      expect((await predicateNext).value).toMatchObject({ pages: [], count: "0" });
      await predicate.stream.return?.();
      const resumed = await open({ columns: { title: true }, count: true });
      const first = bounded(resumed.stream.next());
      await current.poll();
      await first;
      expect(captured.at(-1)).toEqual(narrow);
      const dynamicGrowth = bounded(resumed.stream.next());
      await owner.query(`UPDATE "${namespace}".selector SET expanded = true`);
      await current.poll();
      await dynamicGrowth;
      expect(captured.at(-1)).toEqual(expanded);
      const dynamicChild = bounded(resumed.stream.next());
      await owner.query(`UPDATE "${namespace}".labels SET name = 'tracked dynamic child'`);
      await current.poll();
      await dynamicChild;
      const sqlUpdate = async (statement: string, value: ExpectedWindow) => {
        const revisions = await registry.read(database.db);
        const next = bounded(resumed.stream.next());
        await owner.query(statement);
        const after = await registry.read(database.db);
        const beforeRevision = revisions[key("tasks")];
        const afterRevision = after[key("tasks")];
        assert(beforeRevision && afterRevision);
        expect(BigInt(afterRevision)).toBe(BigInt(beforeRevision) + 1n);
        await current.poll();
        expect((await next).value).toMatchObject(value);
      };
      await sqlUpdate(`INSERT INTO "${namespace}".tasks (title) VALUES ('inserted')`, { count: "2" });
      await sqlUpdate(`UPDATE "${namespace}".tasks SET title = 'updated'`, { count: "2" });
      await sqlUpdate(`DELETE FROM "${namespace}".tasks WHERE "_id" <> '${task._id}'`, {
        pages: [[{ title: "updated" }]],
        count: "1",
      });
      const writer = await owner.connect();
      try {
        const revisions = await registry.read(database.db);
        const before = evaluations;
        await writer.query("BEGIN");
        await writer.query(`UPDATE "${namespace}".tasks SET title = 'rolled back'`);
        await current.poll();
        expect(evaluations).toBe(before);
        expect(await registry.read(database.db)).toEqual(revisions);
        await writer.query("ROLLBACK");
        await current.poll();
        expect(evaluations).toBe(before);
        expect(await registry.read(database.db)).toEqual(revisions);
      } finally {
        await writer.query("ROLLBACK");
        writer.release();
      }
      // Pause after the selector established the repeatable-read snapshot, then commit another writer.
      const barrier = { entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
      pause = barrier;
      await owner.query(`UPDATE "${namespace}".selector SET expanded = false`);
      const oldSnapshot = bounded(resumed.stream.next());
      const evaluating = current.poll();
      await bounded(barrier.entered.promise);
      await owner.query(`UPDATE "${namespace}".tasks SET title = 'committed during evaluation'`);
      barrier.release.resolve();
      await evaluating;
      expect((await oldSnapshot).value).toMatchObject({ pages: [[{ title: "updated" }]] });
      const reconciled = bounded(resumed.stream.next());
      await current.poll();
      expect((await reconciled).value).toMatchObject({ pages: [[{ title: "committed during evaluation" }]] });
      expect(captured.at(-1)).toEqual(narrow);
      const beforeShrunk = evaluations;
      await owner.query(`UPDATE "${namespace}".labels SET name = 'no longer read'`);
      await current.poll();
      expect(evaluations).toBe(beforeShrunk);
      // A failing attempt reads a smaller graph but cannot donate a new revision vector.
      const growth = bounded(resumed.stream.next());
      await owner.query(`UPDATE "${namespace}".selector SET expanded = true`);
      await current.poll();
      await growth;
      expect(captured.at(-1)).toEqual(expanded);
      const capturesBeforeFailure = captured.length;
      const failure = assert.rejects(bounded(resumed.stream.next()), { code: "BAD_REQUEST" });
      await owner.query(`UPDATE "${namespace}".selector SET expanded = false, fail = true`);
      await current.poll();
      await failure;
      expect(captured.length).toBe(capturesBeforeFailure);
      expect(captured.at(-1)).toEqual(expanded);
      await owner.query(`UPDATE "${namespace}".selector SET fail = false`);
      // A reconnect must run fresh authorization and rebuild its selection.
      const beforeReconnect = authorizations;
      const reconnected = await open({ columns: { title: true }, count: true });
      const reconnectedFirst = bounded(reconnected.stream.next());
      await current.poll();
      expect((await reconnectedFirst).value).toMatchObject({ count: "1" });
      expect(authorizations).toBe(beforeReconnect + 2);
      expect(captured.at(-1)).toEqual(narrow);
      // Permission-only middleware revocation terminates this same selectively proven subscription.
      const beforeMiddleware = evaluations;
      await unchanged(`UPDATE "${namespace}".unrelated SET title = 'still ignored'`);
      const revoked = assert.rejects(bounded(reconnected.stream.next()), { code: "FORBIDDEN" });
      await owner.query(`UPDATE "${namespace}".middleware_permissions SET allowed = false`);
      await current.poll();
      await revoked;
      expect(evaluations).toBe(beforeMiddleware);
      await owner.query(`UPDATE "${namespace}".middleware_permissions SET allowed = true`);
      const truncated = await open();
      const truncationFirst = bounded(truncated.stream.next());
      await current.poll();
      await truncationFirst;
      const beforeTruncate = await registry.read(database.db);
      const truncationNext = bounded(truncated.stream.next());
      await owner.query(`TRUNCATE "${namespace}".tasks, "${namespace}".task_labels`);
      const afterTruncate = await registry.read(database.db);
      const beforeTruncateRevision = beforeTruncate[key("tasks")];
      const afterTruncateRevision = afterTruncate[key("tasks")];
      assert(beforeTruncateRevision && afterTruncateRevision);
      expect(BigInt(afterTruncateRevision)).toBe(BigInt(beforeTruncateRevision) + 1n);
      await current.poll();
      expect((await truncationNext).value).toMatchObject({ pages: [], count: "0" });
      await truncated.stream.return?.();
      // Cancellation is a completed ownership barrier: subsequent commits cannot run this invocation.
      const cancelled = await open();
      const cancelledFirst = bounded(cancelled.stream.next());
      await current.poll();
      await cancelledFirst;
      cancelled.controller.abort();
      await cancelled.stream.return?.();
      const cancelledCount = evaluations;
      await owner.query(`INSERT INTO "${namespace}".tasks (title) VALUES ('after cancellation')`);
      await current.poll();
      expect(evaluations).toBe(cancelledCount);
      const expiry = await open(undefined, Math.floor(Date.now() / 1000) + 2);
      const expiryFirst = bounded(expiry.stream.next());
      await current.poll();
      await expiryFirst;
      await assert.rejects(bounded(expiry.stream.next()), { code: "UNAUTHORIZED" });
      const expiredCount = evaluations;
      await owner.query(`UPDATE "${namespace}".tasks SET title = 'after expiry'`);
      await current.poll();
      expect(evaluations).toBe(expiredCount);
      // Missing real registry row closes with resync, never unchanged; restored row supports reconnect.
      const missing = await open();
      const missingFirst = bounded(missing.stream.next());
      await current.poll();
      await missingFirst;
      const revision = (await registry.read(database.db))[key("tasks")];
      const resync = assert.rejects(bounded(missing.stream.next()), { code: "INTERNAL_SERVER_ERROR" });
      await owner.query(
        `DELETE FROM "${metadataNamespace}".table_revisions WHERE namespace = $1 AND table_name = 'tasks'`,
        [namespace],
      );
      await current.poll();
      await resync;
      await owner.query(`INSERT INTO "${metadataNamespace}".table_revisions VALUES ($1, 'tasks', $2)`, [
        namespace,
        revision,
      ]);
      const missingKey = await open({ columns: { title: true }, count: true });
      const missingKeyFirst = bounded(missingKey.stream.next());
      await current.poll();
      await missingKeyFirst;
      const beforeMissingKey = evaluations;
      const missingKeyError = assert.rejects(bounded(missingKey.stream.next()), { code: "INTERNAL_SERVER_ERROR" });
      missingPolledKey = true;
      await current.poll();
      await missingKeyError;
      expect(evaluations).toBe(beforeMissingKey);
      missingPolledKey = false;
      // An actual external policy read illustrates the excluded guarantee: external-only changes do not rerun.
      await owner.query(`UPDATE "${namespace}".external_state SET allowed = true`);
      const externalRoute = graph.router.external;
      assert(externalRoute instanceof Procedure);
      const external = await open(
        { columns: { title: true }, count: true },
        Math.floor(Date.now() / 1000) + 120,
        externalRoute,
      );
      const externalFirst = bounded(external.stream.next());
      await current.poll();
      expect((await externalFirst).value).toMatchObject({ count: "1" });
      expect(captured.at(-1)).toEqual([key("permissions"), key("tasks")].sort());
      const externalBefore = externalEvaluations;
      await owner.query(`UPDATE "${namespace}".external_state SET allowed = false`);
      await current.poll();
      await current.poll();
      expect(externalEvaluations).toBe(externalBefore);
      const externalRefresh = bounded(external.stream.next());
      await owner.query(`UPDATE "${namespace}".tasks SET title = 'external policy rechecked'`);
      await current.poll();
      expect((await externalRefresh).value).toMatchObject({ pages: [], count: "0" });
      expect(externalEvaluations).toBe(externalBefore + 1);
      await external.stream.return?.();
      // Cancel while a transaction is in flight; return waits for owned work to finish.
      const inFlight = await open({ columns: { title: true }, count: true });
      const inFlightFirst = bounded(inFlight.stream.next());
      await current.poll();
      await inFlightFirst;
      const cancellationBarrier = { entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
      pause = cancellationBarrier;
      await owner.query(`UPDATE "${namespace}".selector SET expanded = true`);
      const waiting = bounded(inFlight.stream.next());
      const pendingPoll = current.poll();
      await bounded(cancellationBarrier.entered.promise);
      inFlight.controller.abort();
      const returned = inFlight.stream.return?.();
      cancellationBarrier.release.resolve();
      await pendingPoll;
      await returned;
      expect((await waiting).done).toBe(true);
      const drained = evaluations;
      await owner.query(`UPDATE "${namespace}".tasks SET title = 'after drained cancellation'`);
      await current.poll();
      expect(evaluations).toBe(drained);
      await assert.rejects(registry.read(database.db, [key("missing")]), /Unknown qualified live dependency/);
      const foreignSchema = defineSchema((f) => ({ tasks: { title: f.text() } }), { namespace: `foreign_${suffix}` });
      const foreignGraph = defineRelations(foreignSchema.tables);
      expect(() => registry.resolve("", foreignGraph, ["tasks"])).toThrow();
      const foreignProcedure = withLiveDependencies(
        foreignGraph,
        ["tasks"],
        project.procedure
          .input(live.input)
          .output(live.output)
          .handler(({ context, input }) => context.search.tasks.watch(input)),
      );
      expect(() =>
        bindRuntimeGraph({
          entries: [{ path: ["foreign"], visibility: "public", procedure: foreignProcedure }],
          database: {
            connection: database,
            replay: { metadataNamespace, deployment: "foreign" },
            revisions: registry.read,
            dependencies: { registry, selective: true, authorization: [] },
            search: { branchId: "local-disposable", key: "03".repeat(32) },
            authorize: async () => {},
          },
          effects,
          coordinator: current,
          activate: async () => {},
          authorize: async () => {},
        }),
      ).toThrow(/Live dependency graph differs/);
      const uncheckedGraph: AnyRelations = relations;
      expect(() => withLiveDependencies(uncheckedGraph, ["missing"], authored)).toThrow(/Unknown live dependency/);
    } finally {
      releaseStartup.resolve();
      await Promise.all(streams.map(async (stream) => stream.return?.()));
      await graph?.stop();
      await coordinator?.stop();
      await effects.stop();
      await connection?.close();
      await owner.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
      await owner.query(`DROP SCHEMA IF EXISTS "${metadataNamespace}" CASCADE`);
      await owner.query(`DROP ROLE IF EXISTS "${role}"`);
      await owner.end();
    }
  }, 60000);
}

for (const mode of ["polling", "notify"] as const) {
  test(`U4 ${mode}: separately compiled root → A → B snapshots and all-scope authorization fallbacks`, async () => {
    const connectionString = process.env.LOOM_TEST_DATABASE_URL;
    assert(connectionString, "LOOM_TEST_DATABASE_URL is required");
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const metadataNamespace = `loom_nested_${suffix}`;
    const role = `nested_role_${suffix}`;
    const makeSchema = (name: string) =>
      defineSchema(
        (f) => ({
          tasks: { title: f.text().notNull() },
          permissions: { allowed: f.boolean().notNull() },
          unrelated: { title: f.text().notNull() },
        }),
        { namespace: `nested_${name}_${suffix}` },
      );
    const root = makeSchema("root");
    const first = makeSchema("a");
    const second = makeSchema("b");
    const rootRelations = defineRelations(root.tables);
    const firstRelations = defineRelations(first.tables);
    const secondRelations = defineRelations(second.tables);
    const scopes = [
      { scope: "", schema: root },
      { scope: "a", schema: first },
      { scope: "b", schema: second },
    ];
    const registry = createDependencyRegistry(metadataNamespace, scopes);
    const owner = new pg.Pool({ connectionString });
    const effects = createEffectRuntime(Layer.empty);
    let connection: Awaited<ReturnType<typeof connectDatabase<typeof rootRelations>>> | undefined;
    try {
      expect((await owner.query("SHOW server_version")).rows[0].server_version).toMatch(/^18\b/);
      await bootstrapDatabase({ connectionString, metadataNamespace, runtimeRole: role });
      for (const { scope, schema } of scopes) {
        const namespace = schema.metadata.namespace;
        const empty = await generateDrizzleJson({}, undefined, [namespace]);
        const installed = await generateDrizzleJson({ namespace: pgSchema(namespace), ...schema.tables }, empty.id, [
          namespace,
        ]);
        await owner.query((await generateMigration(empty, installed)).join("\n"));
        const admin = await owner.connect();
        try {
          await admin.query("BEGIN");
          await installRevisionTracking(
            admin,
            namespace,
            metadataNamespace,
            schema.metadata.entities.map((entity) => entity.sqlName),
          );
          await admin.query("COMMIT");
        } finally {
          admin.release();
        }
        await owner.query(`INSERT INTO "${namespace}".tasks (title) VALUES ($1)`, [scope || "root"]);
        await owner.query(`INSERT INTO "${namespace}".permissions (allowed) VALUES (true)`);
        await owner.query(`INSERT INTO "${namespace}".unrelated (title) VALUES ('unrelated')`);
        await owner.query(`GRANT USAGE ON SCHEMA "${namespace}" TO "${role}"`);
        await owner.query(`GRANT SELECT ON ALL TABLES IN SCHEMA "${namespace}" TO "${role}"`);
      }
      await owner.query(`ALTER ROLE "${role}" LOGIN PASSWORD 'nested-local-test'`);
      const address = new URL(connectionString);
      address.username = role;
      address.password = "nested-local-test";
      connection = await connectDatabase({ schema: root, relations: rootRelations, connectionString: address.href });
      const database = connection;
      const caller = v.object({
        rpc: v.custom<{
          watch: (input: {
            columns: { title: true };
            count: true;
          }) => Promise<v.InferOutput<typeof iteratorSchema> | string>;
        }>((value) => {
          if (!v.is(v.object({}), value)) return false;
          // SAFETY: the native proxy resolves properties through get; validate that result before invoking it.
          const nested = value as { watch?: unknown };
          return v.is(v.function(), nested.watch);
        }),
      });
      const components = v.object({ components: v.object({ a: v.optional(caller), b: v.optional(caller) }) });
      for (const variant of [
        "complete",
        "unknown-child",
        "no-policy-child",
        "procedure",
        "authorization",
        "policy",
        "root-direct-b",
        "a-direct-b",
      ] as const) {
        let evaluations = 0;
        let childReads = 0;
        let finiteChildCalls = 0;
        let finiteChildAuthorizations = 0;
        const captures: string[][] = [];
        const capturedSnapshotKeys: string[][] = [];
        const databases: NodePgDatabase[] = [];
        const snapshots: string[] = [];
        const registryObserved = {
          ...registry,
          read: async (db: NodePgDatabase, selected: Iterable<string> = registry.keys) => {
            const keys = [...selected].sort();
            const value = await registry.read(db, keys);
            captures.push(keys);
            capturedSnapshotKeys.push(Object.keys(value).sort());
            return value;
          },
        };
        let wakeCount = 0;
        const coordinatorOptions = { intervalMs: 60000, readRevisions: () => registry.read(database.db) };
        const coordinator = createRevisionCoordinator(
          mode === "notify"
            ? {
                ...coordinatorOptions,
                wakeups: (wake) =>
                  listenForRevisions(
                    {
                      connectionString: address.href,
                      runtimeRole: role,
                      metadataNamespace,
                      namespace: root.metadata.namespace,
                      componentNamespaces: [first.metadata.namespace, second.metadata.namespace],
                    },
                    () => {
                      wakeCount++;
                      wake();
                    },
                  ),
              }
            : coordinatorOptions,
        );
        const makeWatch = (schema: typeof root, relations: typeof rootRelations, scope: string) => {
          const project = createProjectProcedures(schema, relations);
          if (variant === "no-policy-child" && scope === "a") {
            // A finite native child has neither generated-search metadata nor database middleware.
            // Even its explicit procedure declaration cannot make this dispatch segment complete.
            return withLiveDependencies(
              relations,
              [],
              project.procedure
                .input(v.object({ columns: v.object({ title: v.literal(true) }), count: v.literal(true) }))
                .output(v.literal("non-generated child"))
                .handler(() => {
                  finiteChildCalls++;
                  return "non-generated child" as const;
                }),
            );
          }
          const policy = { name: "undeclared", version: "1", where: () => sql`true` };
          const live = project.validators.tables.tasks.liveSearch({
            columns: ["title"],
            scope: variant === "policy" && !scope ? policy : "public",
          });
          const procedure = project.procedure
            .use(({ context, next }) => next({ context: v.parse(components, context) }))
            .input(live.input)
            .output(live.output)
            .handler(async ({ context, input }) => {
              if (context.operation === "live") {
                if (!scope) evaluations++;
                if (scope === "b") childReads++;
                const nextScope = !scope
                  ? context.components.a
                  : scope === "a" && variant !== "root-direct-b" && variant !== "a-direct-b"
                    ? context.components.b
                    : undefined;
                if (nextScope) {
                  if (variant === "no-policy-child") {
                    expect(await nextScope.rpc.watch({ columns: { title: true }, count: true })).toBe(
                      "non-generated child",
                    );
                    return context.search.tasks.watch(input);
                  }
                  const nested = v.parse(
                    iteratorSchema,
                    await nextScope.rpc.watch({ columns: { title: true }, count: true }),
                  );
                  try {
                    expect((await nested.next()).value).toMatchObject({ count: "1" });
                  } finally {
                    await nested.return?.();
                  }
                }
              }
              return context.search.tasks.watch(input);
            });
          return (variant === "procedure" && !scope) || (variant === "unknown-child" && scope === "b")
            ? procedure
            : withLiveDependencies(relations, [], procedure);
        };
        const rootWatch = makeWatch(root, rootRelations, "");
        const firstWatch = makeWatch(first, firstRelations, "a");
        const secondWatch = makeWatch(second, secondRelations, "b");
        if (variant === "no-policy-child") {
          expect(searchContractDescriptor(rootWatch)).toBeDefined();
          expect(searchContractDescriptor(firstWatch)).toBeUndefined();
          expect(getDatabasePolicy(firstWatch)).toBeUndefined();
        }
        const databaseForScope = (scope: string) => {
          const schema = scopes.find((entry) => entry.scope === scope)?.schema;
          assert(schema);
          const unknownAuthorization =
            (variant === "authorization" && !scope) ||
            (variant === "root-direct-b" && !scope) ||
            (variant === "a-direct-b" && scope === "a");
          const dependencyOptions = { registry: registryObserved, selective: true };
          return {
            connection: database,
            scope,
            replay: { metadataNamespace, deployment: "nested-matrix" },
            revisions: registry.read,
            dependencies: unknownAuthorization
              ? dependencyOptions
              : { ...dependencyOptions, authorization: ["permissions"] },
            search: { branchId: "local-disposable", key: "03".repeat(32) },
            authorize: async ({ db }: { db: NodePgDatabase }) => {
              databases.push(db);
              const result = await db.execute<{ snapshot: string }>(
                sql`SELECT pg_current_snapshot()::text || ':' || pg_backend_pid()::text AS snapshot`,
              );
              assert(result.rows[0]);
              snapshots.push(result.rows[0].snapshot);
              const local = await db.select().from(schema.tables.permissions);
              if (!local[0]?.allowed) throw new ORPCError("FORBIDDEN");
              if ((variant === "root-direct-b" && !scope) || (variant === "a-direct-b" && scope === "a")) {
                // Local declarations cannot describe this sibling read: omitted authorization must capture every scope.
                const sibling = await db.select().from(second.tables.permissions);
                if (!sibling[0]?.allowed) throw new ORPCError("FORBIDDEN");
              }
            },
          };
        };
        const graph = bindRuntimeGraph({
          entries: [
            { path: ["watch"], visibility: "public", procedure: rootWatch },
            { scope: "a", path: ["watch"], visibility: "exported", procedure: firstWatch },
            { scope: "b", path: ["watch"], visibility: "exported", procedure: secondWatch },
          ],
          scopes: [
            { name: "", dependencies: { a: "a" } },
            { name: "a", dependencies: { b: "b" } },
            { name: "b", dependencies: {} },
          ],
          application: { run: (work) => work(), runComponent: (_scope, work) => work() },
          database: databaseForScope(""),
          databaseForScope,
          effects,
          coordinator,
          activate: async () => {},
          authorize: async () => {
            if (variant === "no-policy-child") finiteChildAuthorizations++;
          },
        });
        const invocation = { identity: null, requestId: crypto.randomUUID(), signal: new AbortController().signal };
        const context = {
          ...invocation,
          expiresAt: Math.floor(Date.now() / 1000) + 120,
          "effect/context": Context.make(Invocation, invocation),
        };
        const route = graph.router.watch;
        assert(route instanceof Procedure);
        const stream = v.parse(
          iteratorSchema,
          await call(route, { columns: { title: true }, count: true }, { context, path: ["watch"] }),
        );
        databases.length = 0;
        snapshots.length = 0;
        try {
          const initial = bounded(stream.next());
          await coordinator.poll();
          const initialResult = await initial;
          expect(initialResult.value).toMatchObject({ pages: [[{ title: "root" }]], count: "1" });
          if (variant === "no-policy-child") {
            expect(initialResult.done).toBe(false);
            expect(evaluations).toBe(1);
            expect(finiteChildCalls).toBe(1);
            expect(finiteChildAuthorizations).toBe(1);
            expect(childReads).toBe(0);
          }
          expect(new Set(databases).size).toBe(1);
          expect(new Set(snapshots).size).toBe(1);
          expect(databases).toHaveLength(
            variant === "no-policy-child" ? 1 : variant === "root-direct-b" || variant === "a-direct-b" ? 2 : 3,
          );
          const expected =
            variant === "complete"
              ? scopes
                  .flatMap(({ schema }) =>
                    ["tasks", "permissions"].map((table) => JSON.stringify([schema.metadata.namespace, table])),
                  )
                  .sort()
              : [...registry.keys];
          expect(captures).toEqual([expected]);
          const allSiblingKeys = scopes
            .flatMap(({ schema }) =>
              schema.metadata.entities.map((entity) => JSON.stringify([schema.metadata.namespace, entity.sqlName])),
            )
            .sort();
          if (variant === "no-policy-child") expect(capturedSnapshotKeys).toEqual([allSiblingKeys]);
          if (mode === "notify") expect(wakeCount).toBeGreaterThan(0);
          const before = evaluations;
          await owner.query(`UPDATE "${second.metadata.namespace}".unrelated SET title = $1`, [crypto.randomUUID()]);
          await coordinator.poll();
          await coordinator.poll();
          expect(evaluations).toBe(before + (variant === "complete" ? 0 : 1));
          if (variant !== "complete") {
            const update = await bounded(stream.next());
            if (variant === "no-policy-child") {
              expect(update.done).toBe(false);
              expect(update.value).toMatchObject({ pages: [[{ title: "root" }]], count: "1" });
              expect(evaluations).toBe(2);
              expect(finiteChildCalls).toBe(2);
              expect(finiteChildAuthorizations).toBe(2);
              expect(childReads).toBe(0);
              expect(capturedSnapshotKeys).toEqual([allSiblingKeys, allSiblingKeys]);
            }
          }
          if (variant === "root-direct-b" || variant === "a-direct-b") expect(childReads).toBe(0);
          if (variant !== "no-policy-child") {
            // Revocation is only in B. Direct-read variants never called B's generated procedure.
            const rejection = assert.rejects(bounded(stream.next()), { code: "FORBIDDEN" });
            await owner.query(`UPDATE "${second.metadata.namespace}".permissions SET allowed = false`);
            await coordinator.poll();
            await rejection;
            expect(captures.at(-1)).toEqual(expected);
            await owner.query(`UPDATE "${second.metadata.namespace}".permissions SET allowed = true`);
          }
        } finally {
          await stream.return?.();
          await graph.stop();
          await coordinator.stop();
        }
      }
    } finally {
      await effects.stop();
      await connection?.close();
      for (const { schema } of scopes)
        await owner.query(`DROP SCHEMA IF EXISTS "${schema.metadata.namespace}" CASCADE`);
      await owner.query(`DROP SCHEMA IF EXISTS "${metadataNamespace}" CASCADE`);
      await owner.query(`DROP ROLE IF EXISTS "${role}"`);
      await owner.end();
    }
  }, 60000);
}
