import { createSnapshotStream } from "../../../apps/kello/src/core/server/rpc/snapshot-stream";
import assert from "node:assert/strict";
import { channel } from "node:diagnostics_channel";
import { expect, test } from "bun:test";
import pg from "pg";
import { defineRelations, sql } from "drizzle-orm";
import { call, ORPCError } from "@orpc/server";
import { Context } from "effect";
import { evaluateSnapshot } from "../../../apps/kello/src/core/server/rpc/snapshot";
import * as v from "valibot";
import { bootstrapDatabase, installRevisionTracking } from "kello/tooling";
import {
  connectDatabase,
  bindRpcDatabaseProcedure,
  createDatabaseMiddleware,
  createProjectProcedures,
  createRevisionCoordinator,
  Invocation,
  createRevisionReader,
  defineSchema,
} from "../../../apps/kello/src/core/server/index";

const connectionString = process.env.LOOM_TEST_DATABASE_URL;
test.skipIf(!connectionString)(
  "live evaluation reads authorization, query data and revisions from one snapshot",
  async () => {
    if (!connectionString) throw new Error("Missing test database");
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const metadata = `loom_${suffix}`;
    const namespace = `app_${suffix}`;
    const role = `runtime_${suffix}`;
    const admin = new pg.Client({ connectionString });
    await admin.connect();
    try {
      await bootstrapDatabase({ connectionString, metadataNamespace: metadata, runtimeRole: role });
      await admin.query(`CREATE SCHEMA "${namespace}"`);
      await admin.query(`CREATE TABLE "${namespace}".tasks (title text NOT NULL)`);
      await admin.query(`CREATE TABLE "${namespace}".permissions (allowed boolean NOT NULL)`);
      await admin.query(`INSERT INTO "${namespace}".tasks VALUES ('old')`);
      await admin.query(`INSERT INTO "${namespace}".permissions VALUES (true)`);
      await admin.query("BEGIN");
      await installRevisionTracking(admin, namespace, metadata, ["tasks", "permissions"]);
      await admin.query("COMMIT");
      await admin.query(`GRANT USAGE ON SCHEMA "${namespace}" TO "${role}"`);
      await admin.query(`GRANT SELECT ON ALL TABLES IN SCHEMA "${namespace}" TO "${role}"`);
      await admin.query(`ALTER ROLE "${role}" LOGIN PASSWORD 'loom-test-only'`);
      const address = new URL(connectionString);
      address.username = role;
      address.password = "loom-test-only";
      const schema = defineSchema(() => ({}));
      const relations = defineRelations(schema.tables);
      const connection = await connectDatabase({
        schema,
        relations,
        connectionString: address.href,
      });
      const metricSchema = v.strictObject({
        type: v.literal("revision.read"),
        status: v.picklist(["success", "error"]),
        durationMs: v.pipe(v.number(), v.finite(), v.minValue(0)),
        tableCount: v.pipe(v.number(), v.integer(), v.minValue(1)),
      });
      const metrics: v.InferOutput<typeof metricSchema>[] = [];
      const metricChannel = channel("kello.runtime.metric");
      const captureMetric: Parameters<typeof metricChannel.subscribe>[0] = (event) => {
        if (v.parse(v.object({ type: v.string() }), event).type === "revision.read") {
          metrics.push(v.parse(metricSchema, event));
        }
      };
      metricChannel.subscribe(captureMetric);
      try {
        const tables = ["tasks", "permissions"];
        const revisions = createRevisionReader({ namespace, metadataNamespace: metadata, tables });
        expect(() => createRevisionReader({ namespace, metadataNamespace: metadata, tables: [] })).toThrow();
        expect(() =>
          createRevisionReader({ namespace, metadataNamespace: metadata, tables: ["tasks; DROP TABLE tasks"] }),
        ).toThrow();
        tables.length = 0;
        const started = Promise.withResolvers<void>();
        const resume = Promise.withResolvers<void>();
        let pause = true;
        let calls = 0;
        const { procedure } = createProjectProcedures(schema);
        const options = {
          connection,
          revisions,
          replay: { metadataNamespace: metadata, deployment: "evaluation-test" },
          authorize: async ({ db }: { readonly db: typeof connection.db }) => {
            const result = await db.execute<{ allowed: boolean }>(
              sql`SELECT allowed FROM ${sql.identifier(namespace)}.permissions`,
            );
            if (!result.rows[0]?.allowed) throw new ORPCError("FORBIDDEN");
          },
        };
        const definition = bindRpcDatabaseProcedure(
          procedure

            .use(createDatabaseMiddleware(relations, "read", schema))
            .input(v.null())
            .handler(async ({ context }) => {
              calls++;
              if (pause) {
                started.resolve();
                await resume.promise;
              }
              return (
                (await context.db.execute<{ title: string }>(sql`SELECT title FROM ${sql.identifier(namespace)}.tasks`))
                  .rows[0]?.title ?? "missing"
              );
            }),
          options,
        );
        const invocation = {
          identity: { issuer: "test", subject: "alice" },
          requestId: crypto.randomUUID(),
          signal: new AbortController().signal,
        };
        const context = {
          ...invocation,
          expiresAt: Math.floor(Date.now() / 1000) + 60,
          "effect/context": Context.make(Invocation, invocation),
        };
        const evaluate = () => evaluateSnapshot(() => call(definition, null, { context }));
        const pending = evaluate();
        await started.promise;
        await admin.query(`UPDATE "${namespace}".tasks SET title = 'new'`);
        resume.resolve();
        expect(await pending).toEqual({ value: "old", revisions: { permissions: "1", tasks: "1" } });
        expect(metrics).toHaveLength(1);
        expect(metrics[0]).toMatchObject({ type: "revision.read", status: "success", tableCount: 2 });
        pause = false;
        expect(await evaluate()).toEqual({
          value: "new",
          revisions: { permissions: "1", tasks: "2" },
        });
        await admin.query(`UPDATE "${namespace}".permissions SET allowed = false`);
        expect(await revisions(connection.db)).toEqual({ permissions: "2", tasks: "2" });
        await assert.rejects(evaluate(), { code: "FORBIDDEN" });
        expect(calls).toBe(2);
        await admin.query(`UPDATE "${namespace}".permissions SET allowed = true`);
        const list = bindRpcDatabaseProcedure(
          procedure

            .use(createDatabaseMiddleware(relations, "read", schema))
            .input(v.null())
            .handler(async ({ context }) =>
              (
                await context.db.execute<{ title: string }>(
                  sql`SELECT title FROM ${sql.identifier(namespace)}.tasks ORDER BY title`,
                )
              ).rows.map((row) => row.title),
            ),
          options,
        );
        const coordinator = createRevisionCoordinator({
          intervalMs: 60_000,
          readRevisions: () => revisions(connection.db),
        });
        try {
          await admin.query(`TRUNCATE "${namespace}".tasks`);
          const stream = createSnapshotStream({
            signal: context.signal,
            expiresAt: context.expiresAt,
            coordinator,
            evaluate: (signal) => evaluateSnapshot(() => call(list, null, { context: { ...context, signal } })),
          });
          expect((await stream.next()).value).toEqual([]);
          await admin.query(`INSERT INTO "${namespace}".tasks VALUES ('newly matching')`);
          await coordinator.poll();
          expect((await stream.next()).value).toEqual(["newly matching"]);
          const beforeRollback = metrics.length;
          await admin.query("BEGIN");
          await admin.query(`INSERT INTO "${namespace}".tasks VALUES ('rolled back')`);
          await admin.query("ROLLBACK");
          await coordinator.poll();
          // Only the coordinator revision read ran; no handler snapshot was evaluated.
          expect(metrics.length - beforeRollback).toBe(1);
          await admin.query(`UPDATE "${namespace}".permissions SET allowed = false`);
          await coordinator.poll();
          await assert.rejects(stream.next(), { code: "FORBIDDEN" });
          await stream.return();
        } finally {
          await coordinator.stop();
        }
        await admin.query(`UPDATE "${namespace}".permissions SET allowed = true`);
        await admin.query(
          `UPDATE "${metadata}".table_revisions SET revision = 9007199254740993 WHERE table_name = 'tasks'`,
        );
        expect((await revisions(connection.db)).tasks).toBe("9007199254740993");
        await admin.query(`DELETE FROM "${metadata}".table_revisions WHERE table_name = 'tasks'`);
        await assert.rejects(revisions(connection.db), /Missing tracked table revision/);
        expect(metrics.at(-1)).toMatchObject({ status: "error", tableCount: 2 });
        await assert.rejects(evaluate(), { code: "INTERNAL_SERVER_ERROR" });
        const beforeDatabaseFailure = metrics.length;
        await admin.query(`REVOKE SELECT ON "${metadata}".table_revisions FROM "${role}"`);
        await assert.rejects(revisions(connection.db));
        expect(metrics).toHaveLength(beforeDatabaseFailure + 1);
        expect(metrics.at(-1)).toMatchObject({ status: "error", tableCount: 2 });
        expect(connection.pool.idleCount).toBe(connection.pool.totalCount);
      } finally {
        metricChannel.unsubscribe(captureMetric);
        await connection.close();
      }
    } finally {
      await admin.query("ROLLBACK");
      await admin.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
      await admin.query(`DROP SCHEMA IF EXISTS "${metadata}" CASCADE`);
      await admin.query(`DROP ROLE IF EXISTS "${role}"`);
      await admin.end();
    }
  },
);
