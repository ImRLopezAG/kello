import assert from "node:assert/strict";
import { channel } from "node:diagnostics_channel";
import { test, expect } from "bun:test";
import pg from "pg";
import { defineRelations, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { pgSchema } from "drizzle-orm/pg-core";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api-postgres";
import { call, Procedure } from "@orpc/server";
import { Context } from "effect";
import * as v from "valibot";
import {
  createProjectProcedures,
  createRpcRuntime,
  defineRpcAuth,
  defineSchema,
  withLiveDependencies,
} from "../../../apps/loom/src/core/server/index";
import { Invocation } from "../../../apps/loom/src/core/server/effect/runtime";
import { evaluateSnapshot } from "../../../apps/loom/src/core/server/rpc/snapshot";
import { evaluateLiveSnapshot } from "../../../apps/loom/src/core/server/rpc/live-context";
import { bootstrapDatabase } from "../../../apps/loom/src/tooling/migrations/bootstrap";
import { installRevisionTracking } from "../../../apps/loom/src/tooling/migrations/revisions";

async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Selective rollout timed out")), 10000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const iteratorSchema = v.custom<AsyncIteratorObject<unknown, unknown>>((value) =>
  v.is(v.object({ next: v.function() }), value),
);
const metricSchema = v.strictObject({
  type: v.literal("revision.read"),
  status: v.literal("success"),
  durationMs: v.pipe(v.number(), v.finite(), v.minValue(0)),
  tableCount: v.pipe(v.number(), v.integer(), v.minValue(1)),
});

test("U5 selective workload saves evaluations and generation rollback restores broad reads", async () => {
  const connectionString = process.env.LOOM_TEST_DATABASE_URL;
  assert(connectionString, "LOOM_TEST_DATABASE_URL is required");
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const namespace = `rollout_${suffix}`;
  const metadataNamespace = `loom_rollout_${suffix}`;
  const role = `rollout_role_${suffix}`;
  const schema = defineSchema(
    (f) => ({
      tasks: { title: f.text().notNull() },
      permissions: { allowed: f.boolean().notNull() },
      unrelated: { title: f.text().notNull() },
    }),
    { namespace },
  );
  const relations = defineRelations(schema.tables);
  const owner = new pg.Pool({ connectionString });
  const metrics: v.InferOutput<typeof metricSchema>[] = [];
  const metricErrors: unknown[] = [];
  const metricChannel = channel("kello.runtime.metric");
  const capture: Parameters<typeof metricChannel.subscribe>[0] = (event) => {
    if (!v.is(v.object({ type: v.literal("revision.read") }), event)) return;
    const parsed = v.safeParse(metricSchema, event);
    if (parsed.success) metrics.push(parsed.output);
    else metricErrors.push(parsed.issues);
  };
  let runtime: Awaited<ReturnType<typeof createRpcRuntime<typeof relations>>> | undefined;
  let streams: AsyncIteratorObject<unknown, unknown>[] = [];
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
    await db.insert(schema.tables.tasks).values({ title: "initial" });
    await db.insert(schema.tables.permissions).values({ allowed: true });
    await db.insert(schema.tables.unrelated).values({ title: "initial" });
    await owner.query(`GRANT USAGE ON SCHEMA "${namespace}" TO "${role}"`);
    await owner.query(`GRANT SELECT ON ALL TABLES IN SCHEMA "${namespace}" TO "${role}"`);
    await owner.query(`ALTER ROLE "${role}" LOGIN PASSWORD 'rollout-local-test'`);
    const address = new URL(connectionString);
    address.username = role;
    address.password = "rollout-local-test";
    const columns = async () =>
      (
        await owner.query(
          "SELECT table_name,column_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema=$1 ORDER BY table_name,ordinal_position",
          [namespace],
        )
      ).rows;
    const originalColumns = await columns();
    const key = (table: string) => JSON.stringify([namespace, table]);
    const allKeys = schema.metadata.entities.map((entity) => key(entity.sqlName)).sort();
    const project = createProjectProcedures(schema, relations);
    const validator = project.validators.tables.tasks.liveSearch({
      columns: ["title"],
      scope: { name: "rollout", version: "1", dependencies: [], where: () => sql`true` },
    });
    const counts = { eligible: 0, broad: 0 };
    const route = (name: keyof typeof counts) =>
      project.procedure
        .input(validator.input)
        .output(validator.output)
        .handler(({ context, input }) => {
          if (context.operation === "live") counts[name]++;
          return context.search.tasks.watch(input);
        });
    const eligible = withLiveDependencies(relations, [], route("eligible"));
    const broad = route("broad");
    const input = { columns: { title: true }, count: true };
    const context = () => {
      const invocation = {
        identity: { issuer: "rollout", subject: "alice" },
        requestId: crypto.randomUUID(),
        signal: new AbortController().signal,
      };
      return {
        ...invocation,
        expiresAt: Math.floor(Date.now() / 1000) + 120,
        "effect/context": Context.make(Invocation, invocation),
      };
    };
    const start = async (disabled: boolean) => {
      const selection: Partial<Record<"selectiveInvalidation", false>> = {};
      if (disabled) selection.selectiveInvalidation = false;
      return createRpcRuntime({
        schema,
        relations,
        connectionString: address.href,
        directConnectionString: address.href,
        metadataNamespace,
        version: "05".repeat(32),
        deployment: "rollout-u5",
        branchId: "local-disposable",
        environment: { LOOM_SEARCH_CURSOR_KEY: "05".repeat(32) },
        config: { realtime: { mode: "polling", pollIntervalMs: 60000 } },
        assertActive: async () => {},
        auth: defineRpcAuth({
          dependencies: ["permissions"],
          authorize: async ({ db: current }) => {
            if (current)
              assert((await current.execute(sql`SELECT allowed FROM ${schema.tables.permissions}`)).rows[0]?.allowed);
          },
        }),
        ...selection,
        procedures: [
          { path: ["eligible"], visibility: "public", procedure: eligible },
          { path: ["broad"], visibility: "public", procedure: broad },
        ],
      });
    };
    metricChannel.subscribe(capture);
    const receipts = [];
    let beforeRestart: unknown;
    for (const disabled of [false, true]) {
      runtime = await start(disabled);
      const current = runtime;
      const initialTitle = disabled ? "selective relevant" : "initial";
      for (const name of ["eligible", "broad"] as const) {
        const snapshot = current.snapshots[name];
        assert(snapshot instanceof Procedure);
        const result = await evaluateLiveSnapshot(Symbol(name), () =>
          evaluateSnapshot(async () => {
            const stream = v.parse(iteratorSchema, await call(snapshot, input, { context: context(), path: [name] }));
            try {
              const value = await bounded(stream.next());
              expect(value.done).toBe(false);
              expect(value.value).toMatchObject({ pages: [[{ title: initialTitle }]], count: "1" });
              return value.value;
            } finally {
              await stream.return?.();
            }
          }),
        );
        expect(Object.keys(result.revisions).sort()).toEqual(
          disabled || name === "broad" ? allKeys : [key("permissions"), key("tasks")].sort(),
        );
      }
      streams = await Promise.all(
        ["eligible", "broad"].map(async (name) => {
          const definition = current.router[name];
          assert(definition instanceof Procedure);
          return v.parse(iteratorSchema, await call(definition, input, { context: context(), path: [name] }));
        }),
      );
      const initial = streams.map((stream) => bounded(stream.next()));
      await current.realtime.coordinator.poll();
      const initialValues = await Promise.all(initial);
      for (const delivery of initialValues) {
        expect(delivery.done).toBe(false);
        expect(delivery.value).toMatchObject({ pages: [[{ title: initialTitle }]], count: "1" });
      }
      expect(initialValues[0]?.value).toEqual(initialValues[1]?.value);
      if (disabled) expect(initialValues[0]?.value).toEqual(beforeRestart);
      // Drain any startup cycle before measuring explicit committed-write polls.
      await current.realtime.coordinator.poll();
      const before = { ...counts };
      const samples = [];
      for (const [index, relevant] of [false, false, false, true].entries()) {
        const offset = metrics.length;
        const began = performance.now();
        if (relevant)
          await db.update(schema.tables.tasks).set({ title: disabled ? "rollback relevant" : "selective relevant" });
        else await db.update(schema.tables.unrelated).set({ title: `${disabled}-${index}` });
        await current.realtime.coordinator.poll();
        const sample = metrics.slice(offset);
        expect(metricErrors).toEqual([]);
        const both = relevant || disabled;
        expect(sample.map((metric) => metric.tableCount).sort((a, b) => a - b)).toEqual(
          both ? (disabled ? [3, 3, 3] : [2, 3, 3]) : [3, 3],
        );
        // Coordinator finishes its ALL read before evaluation reads begin.
        expect(sample[0]?.tableCount).toBe(3);
        expect(sample.length).toBe(both ? 3 : 2);
        const broadValue = await bounded(streams[1]!.next());
        const expectedTitle = relevant ? (disabled ? "rollback relevant" : "selective relevant") : initialTitle;
        expect(broadValue.done).toBe(false);
        expect(broadValue.value).toMatchObject({ pages: [[{ title: expectedTitle }]], count: "1" });
        if (both) {
          const eligibleValue = await bounded(streams[0]!.next());
          expect(eligibleValue.done).toBe(false);
          expect(eligibleValue.value).toMatchObject({ pages: [[{ title: expectedTitle }]], count: "1" });
          expect(eligibleValue.value).toEqual(broadValue.value);
          beforeRestart = eligibleValue.value;
        }
        samples.push({
          relevant,
          elapsedMs: performance.now() - began,
          coordinator: sample[0],
          evaluations: sample.slice(1),
        });
      }
      const evaluations = { eligible: counts.eligible - before.eligible, broad: counts.broad - before.broad };
      expect(evaluations).toEqual({ eligible: disabled ? 4 : 1, broad: 4 });
      receipts.push({ selectiveInvalidation: !disabled, evaluations, samples });
      const stoppedStreams = streams;
      await current.stop();
      runtime = undefined;
      expect((await bounded(stoppedStreams[0]!.next())).done).toBe(true);
      expect((await bounded(stoppedStreams[1]!.next())).done).toBe(true);
      await Promise.all(stoppedStreams.map(async (stream) => stream.return?.()));
      streams = [];
      const stoppedCounts = { ...counts };
      await current.realtime.coordinator.poll();
      expect(counts).toEqual(stoppedCounts);
      expect(await columns()).toEqual(originalColumns);
    }
    console.log(JSON.stringify({ acceptance: "003-selective-rollout", savedUnrelatedEvaluations: 3, receipts }));
  } finally {
    metricChannel.unsubscribe(capture);
    await Promise.all(streams.map(async (stream) => stream.return?.()));
    await runtime?.stop();
    try {
      await owner.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
      await owner.query(`DROP SCHEMA IF EXISTS "${metadataNamespace}" CASCADE`);
      await owner.query(`DROP ROLE IF EXISTS "${role}"`);
    } finally {
      await owner.end();
    }
  }
}, 60000);
