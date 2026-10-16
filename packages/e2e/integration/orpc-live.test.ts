import { createSnapshotStream } from "../../../apps/kello/src/core/server/rpc/snapshot-stream";
import { evaluateSnapshot } from "../../../apps/kello/src/core/server/rpc/snapshot";
import { eventIterator } from "kello/contract";
import type { ProcedureContext } from "../../../apps/kello/src/core/server";
import assert from "node:assert/strict";
import { test, expect } from "bun:test";
import { call, os, ORPCError } from "@orpc/server";
import type { RouterClient } from "@orpc/server";
import { createORPCClient, RPCSerializer } from "@orpc/client";
import { RPCLink } from "@orpc/client/websocket";
import { RPCHandler } from "@orpc/server/websocket";
import { Context } from "effect";
import { defineRelations, sql } from "drizzle-orm";
import pg from "pg";
import * as v from "valibot";
import { bootstrapDatabase, installRevisionTracking } from "kello/tooling";
import {
  bindRpcDatabaseProcedure,
  createDatabaseMiddleware,
  createProjectProcedures,
  connectDatabase,
  defineSchema,
  Invocation,
  createRevisionCoordinator,
  createRevisionReader,
} from "../../../apps/kello/src/core/server";
const connectionString = process.env.LOOM_TEST_DATABASE_URL;
test.skipIf(!connectionString)(
  "native live iterators preserve snapshot revisions, authorization and cancellation over WebSocket",
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
      const connection = await connectDatabase({ schema, relations, connectionString: address.href });
      const revisions = createRevisionReader({
        namespace,
        metadataNamespace: metadata,
        tables: ["tasks", "permissions"],
      });
      const coordinator = createRevisionCoordinator({
        readRevisions: () => revisions(connection.db),
        intervalMs: 60_000,
      });
      try {
        const started = Promise.withResolvers<void>();
        const resume = Promise.withResolvers<void>();
        let paused = true;
        let calls = 0;
        let transforms = 0;
        const { procedure } = createProjectProcedures(schema);
        const definition = procedure

          .use(createDatabaseMiddleware(relations, "read", schema))
          .input(
            v.pipe(
              v.string(),
              v.transform((value) => {
                transforms++;
                return value.toUpperCase();
              }),
            ),
          )
          .handler(async ({ context, input }) => {
            calls++;
            if (paused) {
              started.resolve();
              await resume.promise;
            }
            const result = await context.db.execute<{ title: string }>(
              sql`SELECT title FROM ${sql.identifier(namespace)}.tasks`,
            );
            return { title: result.rows[0]!.title, input, at: new Date("2026-09-24"), count: 1n };
          });
        const bound = bindRpcDatabaseProcedure(definition, {
          connection,
          revisions,
          replay: { metadataNamespace: metadata, deployment: "live-test" },
          authorize: async ({ db }) => {
            const result = await db.execute<{ allowed: boolean }>(
              sql`SELECT allowed FROM ${sql.identifier(namespace)}.permissions`,
            );
            if (!result.rows[0]?.allowed) throw new ORPCError("FORBIDDEN");
          },
        });
        const live = os
          .$context<ProcedureContext>()
          .input(v.string())
          .output(eventIterator(v.object({ title: v.string(), input: v.string(), at: v.date(), count: v.bigint() })))
          .handler(({ input, context }) =>
            createSnapshotStream({
              signal: context.signal,
              expiresAt: context.expiresAt,
              coordinator,
              evaluate: (signal) => evaluateSnapshot(() => call(bound, input, { context: { ...context, signal } })),
            }),
          );
        const controller = new AbortController();
        const invocation = {
          identity: { issuer: "test", subject: "one" },
          requestId: crypto.randomUUID(),
          signal: controller.signal,
        };
        const context = {
          ...invocation,
          expiresAt: Math.floor(Date.now() / 1000) + 60,
          "effect/context": Context.make(Invocation, invocation),
        };
        const stream = await call(live, "test", { context });
        const first = stream.next();
        await started.promise;
        await admin.query(`UPDATE "${namespace}".tasks SET title = 'new'`);
        paused = false;
        resume.resolve();
        expect((await first).value).toMatchObject({ title: "old", input: "TEST" });
        await coordinator.poll();
        expect((await stream.next()).value).toMatchObject({ title: "new" });
        expect(calls).toBe(2);
        expect(transforms).toBe(2);
        // A changed revision arriving during evaluation cannot label old data as current.
        await stream.return();
        expect(connection.pool.idleCount).toBe(connection.pool.totalCount);
        const router = { tasks: { list: live } };
        const serializer = new RPCSerializer({ omitUndefinedProperties: false });
        const sockets = new RPCHandler(router, { serializer });
        const server = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch(request, server) {
            if (server.upgrade(request)) return;
            return new Response(null, { status: 400 });
          },
          websocket: {
            async message(socket, message) {
              await sockets.message(socket, message, { context });
            },
            async close(socket) {
              await sockets.close(socket);
            },
          },
        });
        const socket = new WebSocket(`ws://127.0.0.1:${server.port}`);
        try {
          const client = createORPCClient<RouterClient<typeof router>>(
            new RPCLink({ connect: () => socket, serializer }),
          );
          const remote = await client.tasks.list("wire");
          expect((await remote.next()).value).toEqual({
            title: "new",
            input: "WIRE",
            at: new Date("2026-09-24"),
            count: 1n,
          });
          await admin.query(`UPDATE "${namespace}".permissions SET allowed = false`);
          const rejected = remote.next();
          await coordinator.poll();
          await assert.rejects(rejected, { code: "FORBIDDEN" });
          // SAFETY: deliberately malformed peer input exercises runtime validation.
          await assert.rejects(client.tasks.list(4 as never), { code: "BAD_REQUEST" });
          await admin.query(`UPDATE "${namespace}".permissions SET allowed = true`);
          const aborted = await client.tasks.list("cancel", { signal: controller.signal });
          await aborted.next();
          controller.abort();
          await new Promise((resolve) => setTimeout(resolve, 30));
          expect(connection.pool.idleCount).toBe(connection.pool.totalCount);
        } finally {
          socket.close();
          await server.stop(true);
        }
      } finally {
        await coordinator.stop();
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
  20_000,
);
