import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { call, os, Procedure } from "@orpc/server";
import type { RouterClient } from "@orpc/server";
import { Context, Layer } from "effect";
import * as v from "valibot";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { bindRuntimeGraph } from "../../../apps/kello/src/core/server/rpc/runtime-graph";
import { createEffectRuntime, createRevisionCoordinator, Invocation } from "kello/server";
import type { ProcedureContext } from "kello/server";

test("runtime dispatch gives each scope only its private and explicitly bound native callers", async () => {
  const privateProcedure = os
    .$context<ProcedureContext>()
    .input(v.string())
    .output(v.string())
    .handler(({ input, context }) => `${context.requestId}:${input}`);
  const privateRouter = { secret: privateProcedure };
  const exported = os
    .$context<ProcedureContext & { internal: RouterClient<typeof privateRouter> }>()
    .input(v.string())
    .output(v.string())
    .handler(({ input, context }) => context.internal.secret(input));
  const exportedRouter = { get: exported };
  const publicProcedure = os
    .$context<ProcedureContext & { components: { child: { rpc: RouterClient<typeof exportedRouter> } } }>()
    .input(v.string())
    .output(v.string())
    .handler(({ input, context }) => context.components.child.rpc.get(input));
  const effects = createEffectRuntime(Layer.empty);
  const coordinator = createRevisionCoordinator({ readRevisions: async () => ({}) });
  // These handlers have no database middleware: any connection attempt is a test failure.
  const pool = new pg.Pool({ connectionString: "postgresql://unused:unused@127.0.0.1:1/unused" });
  const db = drizzle({ client: pool });
  const graph = bindRuntimeGraph({
    entries: [
      { path: ["get"], visibility: "public", procedure: publicProcedure },
      { scope: "child", path: ["get"], visibility: "exported", procedure: exported },
      { scope: "child", path: ["secret"], visibility: "internal", procedure: privateProcedure },
    ],
    exposures: [{ scope: "child", prefix: "store" }],
    scopes: [
      { name: "", dependencies: { child: "child" } },
      { name: "child", dependencies: {} },
    ],
    application: { run: (work) => work(), runComponent: (_scope, work) => work() },
    effects,
    coordinator,
    activate: async () => {},
    authorize: async () => {},
    database: {
      connection: { db, pool, transaction: db.transaction.bind(db), close: () => pool.end() },
      replay: { metadataNamespace: "kello", deployment: "test" },
      authorize: async () => {},
    },
  });
  try {
    const invocation = { requestId: "parent", identity: null, signal: new AbortController().signal };
    const context = { ...invocation, "effect/context": Context.make(Invocation, invocation) };
    expect(Object.keys(graph.router)).toEqual(["get", "store"]);
    const store = graph.router.store;
    assert(store && !(store instanceof Procedure));
    expect(Object.keys(store)).toEqual(["get"]);
    expect(graph.internal).toHaveLength(1);
    expect(graph.internal[0]?.scope).toBe("child");
    const route = graph.router.get;
    assert(route instanceof Procedure);
    expect(await call(route, "input", { context })).toBe("parent:input");
  } finally {
    await graph.stop();
    await effects.stop();
    await coordinator.stop();
    await pool.end();
  }
});
