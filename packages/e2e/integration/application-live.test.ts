import { expect, test } from "bun:test";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/websocket";
import { RPCHandler } from "@orpc/server/websocket";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { Context } from "effect";
import { defineRelations, sql } from "drizzle-orm";
import pg from "pg";
import * as v from "valibot";
import { z } from "zod";
import { oc, eventIterator } from "kello/contract";
import type { RouterContractClient } from "kello/contract";
import { createRpcRuntime, defineRpcAuth, defineSchema, Invocation } from "../../../apps/kello/src/core/server";
import { applicationBase } from "../../../apps/kello/src/core/server/application/definition";
import { bootstrapDatabase, installRevisionTracking } from "kello/tooling";

const connectionString = process.env.LOOM_TEST_DATABASE_URL;
for (const library of ["valibot", "zod"] as const)
  test.skipIf(!connectionString)(
    `${library} explicit contracts transform events once through authorized PostgreSQL snapshots`,
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
        const schema = defineSchema(
          (s) => ({ tasks: { title: s.text().notNull() }, permissions: { allowed: s.boolean().notNull() } }),
          { namespace },
        );
        const relations = defineRelations(schema.tables);
        let transforms = 0;
        let authorized = 0;
        let snapshots = 0;
        const snapshotStarted = Promise.withResolvers<void>();
        const finishSnapshot = Promise.withResolvers<void>();
        const contract = {
          watch: oc
            .errors({ FORBIDDEN: { message: "Access revoked" } })
            .input(
              v.pipe(
                v.string(),
                v.transform((value) => {
                  transforms++;
                  return { label: value.toUpperCase(), url: new URL(`https://kello.test/${value}`) };
                }),
              ),
            )
            .output(
              eventIterator(
                library === "zod"
                  ? z.object({
                      title: z.string(),
                      input: z.string(),
                      prefix: z.string().transform((value) => value + "!"),
                      url: z.string(),
                    })
                  : v.object({
                      title: v.string(),
                      input: v.string(),
                      prefix: v.pipe(
                        v.string(),
                        v.transform((value) => value + "!"),
                      ),
                      url: v.string(),
                    }),
              ),
            ),
        };
        const os = applicationBase<
          typeof contract,
          typeof schema,
          typeof relations,
          { PREFIX: v.StringSchema<undefined> }
        >(contract, schema, relations, () => ({ PREFIX: "app" })).use(async ({ context, next, errors }) => {
          authorized++;
          const permission = await context.db.execute<{ allowed: boolean }>(
            sql`SELECT allowed FROM ${sql.identifier(namespace)}.permissions`,
          );
          if (!permission.rows[0]?.allowed) throw errors.FORBIDDEN();
          return next();
        });
        const watch = os.watch.handler(({ input, context }) =>
          context.live(async ({ db, env }) => {
            snapshots++;
            const readOnly = await db.execute<{ transaction_read_only: string }>(sql`SHOW transaction_read_only`);
            expect(readOnly.rows[0]?.transaction_read_only).toBe("on");
            const data = await db.execute<{ title: string }>(sql`SELECT title FROM ${sql.identifier(namespace)}.tasks`);
            if (snapshots === 1) {
              snapshotStarted.resolve();
              await finishSnapshot.promise;
            }
            return { title: data.rows[0]!.title, input: input.label, prefix: env.PREFIX, url: input.url.href };
          }),
        );
        const runtime = await createRpcRuntime({
          schema,
          relations,
          connectionString: address.href,
          metadataNamespace: metadata,
          deployment: "live-contract",
          version: "d".repeat(64),
          procedures: [{ path: ["watch"], visibility: "public", procedure: watch }],
          config: { realtime: { pollIntervalMs: 60000 } },
          auth: defineRpcAuth({ allowAnonymous: true, authorize: async () => {} }),
          assertActive: async () => {},
        });
        const controller = new AbortController();
        const invocation = {
          identity: { issuer: "test", subject: "reader" },
          requestId: crypto.randomUUID(),
          signal: controller.signal,
        };
        const context = {
          ...invocation,
          expiresAt: Math.floor(Date.now() / 1000) + 60,
          "effect/context": Context.make(Invocation, invocation),
        };
        const handler = new RPCHandler(runtime.router);
        const server = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch(request, server) {
            if (server.upgrade(request)) return;
            return new Response(null, { status: 400 });
          },
          websocket: {
            async message(socket, message) {
              await handler.message(socket, message, { context });
            },
            async close(socket) {
              await handler.close(socket);
            },
          },
        });
        const socket = new WebSocket(`ws://127.0.0.1:${server.port}`);
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        let unsubscribe: (() => void) | undefined;
        try {
          const client = createORPCClient<RouterContractClient<typeof contract>>(
            new RPCLink({ connect: () => socket }),
          );
          const rpc = createTanstackQueryUtils(client);
          const observer = new QueryObserver(queryClient, rpc.watch.liveOptions({ input: "hello", retry: false }));
          const first = Promise.withResolvers<void>();
          const updated = Promise.withResolvers<void>();
          const revoked = Promise.withResolvers<void>();
          unsubscribe = observer.subscribe((result) => {
            if (result.data?.title === "old") first.resolve();
            if (result.data?.title === "new") updated.resolve();
            if (result.error) revoked.resolve();
          });
          await snapshotStarted.promise;
          await admin.query(`UPDATE "${namespace}".tasks SET title='new'`);
          finishSnapshot.resolve();
          await first.promise;
          expect(observer.getCurrentResult().data).toEqual({
            title: "old",
            input: "HELLO",
            prefix: "app!",
            url: "https://kello.test/hello",
          });
          expect(transforms).toBe(1);
          expect(snapshots).toBe(1);
          expect(authorized).toBe(2);
          const busy = await admin.query(
            "SELECT count(*)::int AS count FROM pg_stat_activity WHERE usename=$1 AND state='idle in transaction'",
            [role],
          );
          expect(busy.rows[0].count).toBe(0);
          await runtime.realtime.coordinator.poll();
          await updated.promise;
          expect(observer.getCurrentResult().data?.title).toBe("new");
          expect(observer.getCurrentResult().data?.prefix).toBe("app!");
          expect(transforms).toBe(1);
          expect(snapshots).toBe(2);
          expect(authorized).toBe(3);
          await admin.query(`UPDATE "${namespace}".permissions SET allowed=false`);
          await runtime.realtime.coordinator.poll();
          await revoked.promise;
          expect(observer.getCurrentResult().error).toMatchObject({ code: "FORBIDDEN", message: "Access revoked" });
          expect(snapshots).toBe(2);
          expect(authorized).toBe(4);
        } finally {
          finishSnapshot.resolve();
          unsubscribe?.();
          queryClient.clear();
          controller.abort();
          socket.close();
          await runtime.stop();
          await server.stop(true);
        }
      } finally {
        await admin.query("ROLLBACK");
        await admin.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
        await admin.query(`DROP SCHEMA IF EXISTS "${metadata}" CASCADE`);
        await admin.query(`DROP ROLE IF EXISTS "${role}"`);
        await admin.end();
      }
    },
    20000,
  );
