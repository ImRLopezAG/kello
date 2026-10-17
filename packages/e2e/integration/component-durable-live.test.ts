import assert from "node:assert/strict";
import { expect, test } from "bun:test";
import { os } from "@orpc/server";
import * as v from "valibot";
import type { RpcJobCall } from "../../../apps/kello/src/core/server/jobs/rpc-contracts";
import { createRpcScheduler } from "../../../apps/kello/src/core/server/jobs/rpc-scheduler";
import { compileJobMigrations } from "../../../apps/kello/src/core/server/jobs/rpc-migrations";
import pg from "pg";

const version = "a".repeat(64);
const procedure = os.input(v.string()).handler(({ input }) => input);
const internal = ["left", "right"].map((scope) => ({ scope, path: ["task"], procedure }));

test("same authored durable target resolves by owning mount and never falls back", async () => {
  const calls: { call: RpcJobCall; key: string }[] = [];
  for (const scope of ["left", "right"]) {
    const scheduler = createRpcScheduler(
      version,
      internal,
      async (call, policy) => {
        calls.push({ call, key: policy.deduplicationKey });
        return "job";
      },
      (work) => work(),
      scope,
    );
    await scheduler.runAfter(0, procedure, "payload", { deduplicationKey: "same" });
  }
  expect(calls).toMatchObject([
    { call: { scope: "left", path: ["task"] } },
    { call: { scope: "right", path: ["task"] } },
  ]);
  expect(calls[0]).not.toEqual(calls[1]);
  const compiled = compileJobMigrations({ version, internal, migrations: [] });
  const left = calls[0]!.call;
  expect(await compiled.resolve(left)).toMatchObject({ scope: "left" });
  const removed = compileJobMigrations({ version, internal: [{ path: ["task"], procedure }], migrations: [] });
  await assert.rejects(removed.resolve(left), /not found/);
});

test("durable callbacks carry the mount identity at compilation", async () => {
  const { compileProcedureCapabilities, defineProcedureStorage, procedureCron, procedureObjectCreated } =
    await import("../../../apps/kello/src/core/server/rpc/capabilities");
  const callback = os.input(v.any()).handler(() => null);
  const entries = ["left", "right"].map((scope) => ({ scope, path: ["callback"], procedure: callback }));
  const storage = defineProcedureStorage({ buckets: { files: { onObjectCreated: procedureObjectCreated(callback) } } });
  for (const scope of ["left", "right"]) {
    const compiled = compileProcedureCapabilities({
      version,
      scope,
      internal: entries,
      crons: { tick: procedureCron("* * * * *", callback, null) },
      storage,
      maxAttempts: 1,
    });
    expect(compiled.handlers.files).toMatchObject({ scope, path: ["callback"] });
    expect(compiled.crons.tick?.call).toMatchObject({ scope, path: ["callback"] });
  }
});

const connectionString = process.env.LOOM_TEST_DATABASE_URL;
test.skipIf(!connectionString)(
  "mounted schedules rollback with their parent and replay receipts remain isolated",
  async () => {
    if (!connectionString) throw new Error("Missing database URL");
    const { call, Procedure } = await import("@orpc/server");
    const { Context, Layer } = await import("effect");
    const { defineRelations } = await import("drizzle-orm");
    const { bootstrapDatabase } = await import("kello/tooling");
    const { defineSchema } = await import("../../../apps/kello/src/core/schema/define-schema");
    const { connectDatabase } = await import("../../../apps/kello/src/core/server/database/connection");
    const { createProjectProcedures } = await import("../../../apps/kello/src/core/server/rpc/procedure");
    const { createDatabaseMiddleware } = await import("../../../apps/kello/src/core/server/rpc/database");
    const { bindRuntimeGraph } = await import("../../../apps/kello/src/core/server/rpc/runtime-graph");
    const { createEffectRuntime, Invocation } = await import("../../../apps/kello/src/core/server/effect/runtime");
    const { createRpcJobQueue } = await import("../../../apps/kello/src/core/server/jobs/rpc-queue");
    const { createTransactionalRpcScheduler } = await import("../../../apps/kello/src/core/server/jobs/rpc-service");
    const namespace = `loom_durable_${crypto.randomUUID().replaceAll("-", "")}`;
    const role = `${namespace}_role`;
    const admin = new pg.Client({ connectionString });
    await admin.connect();
    const schema = defineSchema(() => ({}));
    const relations = defineRelations(schema.tables);
    const connection = await connectDatabase({ schema, relations, connectionString });
    const effects = createEffectRuntime(Layer.empty);
    try {
      await bootstrapDatabase({ connectionString, metadataNamespace: namespace, runtimeRole: role });
      const target = createProjectProcedures(schema)
        .procedure.input(v.string())
        .handler(({ input }) => input);
      const entries = ["left", "right"].map((scope) => ({ scope, path: ["task"], procedure: target }));
      const replay = { metadataNamespace: namespace, deployment: "test" };
      const queue = createRpcJobQueue({ ...replay, db: connection.db, version, internal: entries });
      const schedulers = Object.fromEntries(
        ["", "left", "right"].map((scope) => [
          scope,
          createTransactionalRpcScheduler({ version, scope, internal: entries, queue }),
        ]),
      );
      let executions = 0;
      const schedule = createProjectProcedures(schema)
        .procedure.use(createDatabaseMiddleware(relations, "write", schema))
        .input(v.string())
        .output(v.string())
        .handler(({ context, input }) => {
          executions++;
          return context.scheduler.runAfter(0, target, input, { deduplicationKey: input });
        });
      const parent = createProjectProcedures(schema)
        .procedure.use(createDatabaseMiddleware(relations, "write", schema))
        .handler(async ({ context }) => {
          // SAFETY: graph below explicitly installs this dependency and input contract.
          const scoped = context as typeof context & {
            components: { left: { rpc: { schedule: (input: string) => Promise<string> } } };
          };
          await scoped.components.left.rpc.schedule("rollback");
          throw new Error("parent failure");
        });
      const database = { connection, replay, authorize: async () => {} };
      const graph = bindRuntimeGraph({
        entries: [
          ...entries.map((entry) => ({ ...entry, visibility: "internal" as const })),
          ...["left", "right"].map((scope) => ({
            scope,
            path: ["schedule"],
            procedure: schedule,
            visibility: "exported" as const,
          })),
          { path: ["parent"], procedure: parent, visibility: "public" },
        ],
        exposures: [
          { scope: "left", prefix: "left" },
          { scope: "right", prefix: "right" },
        ],
        scopes: [
          { name: "", dependencies: { left: "left", right: "right" } },
          { name: "left", dependencies: {} },
          { name: "right", dependencies: {} },
        ],
        application: { run: (work) => work(), runComponent: (_scope, work) => work() },
        effects,
        activate: async () => {},
        authorize: async () => {},
        database,
        databaseForScope: (scope) => ({ ...database, scheduler: schedulers[scope]! }),
      });
      try {
        const invocation = { identity: null, requestId: "durable", signal: new AbortController().signal };
        const context = {
          ...invocation,
          idempotencyKey: "same-receipt",
          "effect/context": Context.make(Invocation, invocation),
        };
        const parentRoute = graph.router.parent;
        if (!(parentRoute instanceof Procedure)) throw new Error("Missing parent route");
        await assert.rejects(call(parentRoute, undefined, { context, path: ["parent"] }));
        expect((await admin.query(`SELECT count(*)::int AS count FROM "${namespace}".jobs`)).rows[0].count).toBe(0);
        executions = 0;
        const results: string[] = [];
        for (const scope of ["left", "right", "left", "right"]) {
          const router = graph.router[scope];
          if (
            !router ||
            router instanceof Procedure ||
            !("schedule" in router) ||
            !(router.schedule instanceof Procedure)
          )
            throw new Error("Missing mounted route");
          // Identical native path and key intentionally exercise mount-scoped receipts.
          results.push(v.parse(v.string(), await call(router.schedule, "same-job", { context, path: ["schedule"] })));
        }
        expect(executions).toBe(2);
        expect(results[0]).toBe(results[2]);
        expect(results[1]).toBe(results[3]);
        expect(results[0]).not.toBe(results[1]);
        const jobs = await admin.query(`SELECT call->>'scope' AS scope FROM "${namespace}".jobs ORDER BY scope`);
        expect(jobs.rows).toEqual([{ scope: "left" }, { scope: "right" }]);
        const { createComponentStorageRuntime } =
          await import("../../../apps/kello/src/core/server/storage/component-runtime");
        const { defineProcedureStorage, procedureObjectCreated, compileProcedureCapabilities } =
          await import("../../../apps/kello/src/core/server/rpc/capabilities");
        const { createLocalStorage } = await import("../fixtures/local-storage");
        const { createHash } = await import("node:crypto");
        const backend = createLocalStorage({ origin: "http://127.0.0.1:5174", onUploaded: async () => {} });
        try {
          const callback = os.input(v.any()).handler(() => null);
          const callbacks = ["left", "right"].map((scope) => ({ scope, path: ["uploaded"], procedure: callback }));
          const callbackQueue = createRpcJobQueue({ ...replay, db: connection.db, version, internal: callbacks });
          const definition = defineProcedureStorage({
            authorize: () => {},
            buckets: { uploads: { onObjectCreated: procedureObjectCreated(callback) } },
          });
          const common = {
            ...replay,
            ...backend.target,
            db: connection.db,
            storage: backend,
            version,
            queue: callbackQueue,
            assertActive: async () => {},
          };
          const scopes = ["left", "right"].map((scope) => ({
            scope,
            storage: definition,
            handlers: compileProcedureCapabilities({
              version,
              scope,
              internal: callbacks,
              storage: definition,
              crons: {},
              maxAttempts: 1,
            }).handlers,
          }));
          const storage = createComponentStorageRuntime({ ...common, scopes });
          const owner = { issuer: "test", subject: "owner" };
          const body = Buffer.from("component scoped object");
          const upload = {
            bucket: "uploads",
            contentType: "text/plain",
            size: body.length,
            sha256: createHash("sha256").update(body).digest("hex"),
          };
          const longScope = Array.from({ length: 4 }, () => "nested".repeat(20)).join("/");
          const longStorage = createComponentStorageRuntime({
            ...common,
            deployment: "d".repeat(256),
            scopes: [{ scope: longScope, storage: definition, handlers: {} }],
          });
          const longIntent = await longStorage.forScope(longScope)!.create(owner, upload, "long");
          const stored = await admin.query(
            `SELECT length(deployment)::int AS length FROM "${namespace}".storage_intents WHERE id=$1`,
            [longIntent.id],
          );
          expect(stored.rows[0].length).toBeLessThanOrEqual(256);
          expect(await longStorage.forScope(longScope)!.status(owner, longIntent.id)).toMatchObject({
            state: "pending",
          });
          const left = storage.forScope("left")!;
          const right = storage.forScope("right")!;
          const intent = await left.create(owner, upload, "same");
          const sibling = await right.create(owner, upload, "same");
          expect(intent.id).not.toBe(sibling.id);
          await assert.rejects(right.status(owner, intent.id), /denied/);
          const signed = await left.signUpload(owner, intent.id);
          expect((await fetch(signed.url, { method: "PUT", headers: signed.headers, body })).status).toBe(204);
          const delivery = {
            invocationId: "delivery",
            triggerId: "trigger",
            triggerName: "trigger",
            bucket: "uploads",
            key: signed.key,
          };
          expect(await storage.receive(delivery)).toMatchObject({ state: "dispatched" });
          const callbackJobs = await admin.query(
            `SELECT call->>'scope' AS scope FROM "${namespace}".jobs WHERE call->'path'->>0 = 'uploaded'`,
          );
          expect(callbackJobs.rows).toEqual([{ scope: "left" }]);
          expect(await storage.receive(delivery)).toMatchObject({ state: "dispatched" });
          const inherited = createComponentStorageRuntime({
            ...common,
            deployment: "forked-deployment",
            branchId: "forked-branch",
            storage: { ...backend, target: { ...backend.target, branchId: "forked-branch" } },
            scopes,
          });
          const inheritedDownload = await inherited.forScope("left")!.signDownload(owner, intent.id);
          expect(await (await fetch(inheritedDownload.url)).text()).toBe(body.toString());
          await assert.rejects(inherited.forScope("right")!.signDownload(owner, intent.id), /denied/);
          await assert.rejects(inherited.forScope("left")!.signUpload(owner, intent.id), /denied/);
          await assert.rejects(inherited.receive(delivery), /Unbound storage event/);
          const removed = createComponentStorageRuntime({
            ...common,
            scopes: scopes.filter((entry) => entry.scope !== "left"),
          });
          await assert.rejects(removed.receive(delivery), /no longer mounted/);
        } finally {
          await backend.close();
        }
        const { quarantineBranchConnection } = await import("../../../apps/kello/src/tooling/deploy/neon/quarantine");
        const quarantined = await quarantineBranchConnection(admin, namespace, {
          projectId: "project",
          branchId: "clone",
          endpointId: "endpoint",
        });
        expect(quarantined.cancelledJobs).toBe(3);
        expect(
          (
            await admin.query(
              `SELECT count(*)::int AS count FROM "${namespace}".jobs WHERE state IN ('pending', 'running')`,
            )
          ).rows[0].count,
        ).toBe(0);
      } finally {
        await graph.stop();
      }
    } finally {
      await effects.stop();
      await connection.close();
      await admin.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
      await admin.query(`DROP OWNED BY "${role}"`);
      await admin.query(`DROP ROLE IF EXISTS "${role}"`);
      await admin.end();
    }
  },
);

test.skipIf(!connectionString)(
  "assembled runtime shares the parent's transaction with child internal work and schedules",
  async () => {
    if (!connectionString) throw new Error("Missing database URL");
    const { call, Procedure } = await import("@orpc/server");
    const { Context } = await import("effect");
    const { defineRelations, sql } = await import("drizzle-orm");
    const { bootstrapDatabase } = await import("kello/tooling");
    const { defineSchema } = await import("../../../apps/kello/src/core/schema/define-schema");
    const { createRpcRuntime } = await import("../../../apps/kello/src/core/server/rpc-runtime");
    const { createProjectProcedures } = await import("../../../apps/kello/src/core/server/rpc/procedure");
    const { createDatabaseMiddleware } = await import("../../../apps/kello/src/core/server/rpc/database");
    const { Invocation } = await import("../../../apps/kello/src/core/server/effect/runtime");
    const { defineApplication } = await import("../../../apps/kello/src/core/server/application/definition");
    const { defineComponent } = await import("../../../apps/kello/src/core/server/components/definition");
    const { defineRpcAuth } = await import("../../../apps/kello/src/core/server/auth/rpc-definition");
    const namespace = `loom_assembled_${crypto.randomUUID().replaceAll("-", "")}`;
    const role = `${namespace}_role`;
    const admin = new pg.Client({ connectionString });
    await admin.connect();
    try {
      await bootstrapDatabase({ connectionString, metadataNamespace: namespace, runtimeRole: role });
      await admin.query(`CREATE TABLE "${namespace}".counter (value integer NOT NULL)`);
      await admin.query(`INSERT INTO "${namespace}".counter VALUES (0)`);
      const schema = defineSchema(() => ({}));
      const relations = defineRelations(schema.tables);
      const application = defineApplication({ rpc: ({ os }) => ({ os }) });
      application.use(defineComponent({ name: "child" }));
      const table = sql`${sql.identifier(namespace)}.${sql.identifier("counter")}`;
      const task = createProjectProcedures(schema)
        .procedure.input(v.string())
        .handler(({ input }) => input);
      const write = createProjectProcedures(schema).procedure.use(createDatabaseMiddleware(relations, "write", schema));
      const internal = write
        .input(v.string())
        .output(v.string())
        .handler(async ({ context, input }) => {
          await context.db.execute(sql`UPDATE ${table} SET value = value + 1`);
          await context.scheduler.runAfter(0, task, input, { deduplicationKey: input });
          const tx = await context.db.execute<{ id: string }>(sql`SELECT pg_current_xact_id()::text AS id`);
          return tx.rows[0]!.id;
        });
      const exported = write
        .input(v.string())
        .output(v.string())
        .handler(({ context, input }) => {
          // SAFETY: the runtime below registers this exact private child input/output contract.
          const scoped = context as typeof context & { internal: { write: (input: string) => Promise<string> } };
          return scoped.internal.write(input);
        });
      const parent = write
        .input(v.boolean())
        .output(v.boolean())
        .handler(async ({ context, input }) => {
          await context.db.execute(sql`UPDATE ${table} SET value = value + 1`);
          const tx = await context.db.execute<{ id: string }>(sql`SELECT pg_current_xact_id()::text AS id`);
          // SAFETY: the runtime below binds the child exported procedure to this dependency.
          const scoped = context as typeof context & {
            components: { child: { rpc: { write: (input: string) => Promise<string> } } };
          };
          const childTx = await scoped.components.child.rpc.write(input ? "rollback" : "commit");
          if (input) throw new Error("parent rollback");
          return childTx === tx.rows[0]!.id;
        });
      const runtime = await createRpcRuntime({
        schema,
        relations,
        application,
        connectionString,
        metadataNamespace: namespace,
        version,
        deployment: "assembled",
        assertActive: async () => {},
        auth: defineRpcAuth({ authorize: () => {} }),
        scopes: [
          { name: "", dependencies: { child: "child" }, schema },
          { name: "child", dependencies: {}, schema },
        ],
        procedures: [
          { path: ["parent"], visibility: "public", procedure: parent },
          { scope: "child", path: ["write"], visibility: "exported", procedure: exported },
          { scope: "child", path: ["write"], visibility: "internal", procedure: internal },
          { scope: "child", path: ["task"], visibility: "internal", procedure: task },
        ],
      });
      try {
        const route = runtime.router.parent;
        assert(route instanceof Procedure);
        const invocation = { identity: null, requestId: "assembled", signal: new AbortController().signal };
        const context = { ...invocation, "effect/context": Context.make(Invocation, invocation) };
        expect(await call(route, false, { context: { ...context, idempotencyKey: "commit" }, path: ["parent"] })).toBe(
          true,
        );
        expect((await admin.query(`SELECT value FROM "${namespace}".counter`)).rows[0].value).toBe(2);
        expect((await admin.query(`SELECT call->>'scope' AS scope FROM "${namespace}".jobs`)).rows).toEqual([
          { scope: "child" },
        ]);
        await assert.rejects(
          call(route, true, { context: { ...context, idempotencyKey: "rollback" }, path: ["parent"] }),
        );
        expect((await admin.query(`SELECT value FROM "${namespace}".counter`)).rows[0].value).toBe(2);
        expect((await admin.query(`SELECT count(*)::int AS count FROM "${namespace}".jobs`)).rows[0].count).toBe(1);
      } finally {
        await runtime.stop();
      }
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
      await admin.query(`DROP OWNED BY "${role}"`);
      await admin.query(`DROP ROLE IF EXISTS "${role}"`);
      await admin.end();
    }
  },
);

test("assembled runtime rejects root and component cron identity collisions before connecting", async () => {
  const { defineRelations } = await import("drizzle-orm");
  const { defineSchema } = await import("../../../apps/kello/src/core/schema/define-schema");
  const { createRpcRuntime } = await import("../../../apps/kello/src/core/server/rpc-runtime");
  const { procedureCron } = await import("../../../apps/kello/src/core/server/rpc/capabilities");
  const schema = defineSchema(() => ({}));
  const childSchema = defineSchema(() => ({}), { namespace: "loom_component_collision" });
  const cron = procedureCron("* * * * *", procedure, "tick");
  let activated = false;
  await assert.rejects(
    createRpcRuntime({
      schema,
      relations: defineRelations(schema.tables),
      version,
      deployment: "collision",
      metadataNamespace: "loom_collision",
      connectionString: "postgresql://unused:unused@127.0.0.1:1/unused",
      assertActive: async () => {
        activated = true;
        throw new Error("Must reject before activation");
      },
      crons: { "loom_component_collision-tick": cron },
      scopes: [
        { name: "", dependencies: { child: "child" }, schema },
        { name: "child", dependencies: {}, schema: childSchema, crons: { tick: cron } },
      ],
      procedures: [
        { path: ["task"], visibility: "internal", procedure },
        { scope: "child", path: ["task"], visibility: "internal", procedure },
      ],
    }),
    /Conflicting cron identity/,
  );
  expect(activated).toBe(false);
});
