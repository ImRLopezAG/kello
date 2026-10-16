import assert from "node:assert/strict";
import { expect, test } from "bun:test";
import { call, os, Procedure } from "@orpc/server";
import { Context, Effect, Layer } from "effect";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as v from "valibot";
import { bindRuntimeGraph } from "../../../apps/kello/src/core/server/rpc/runtime-graph";
import { createEffectRuntime, Invocation } from "../../../apps/kello/src/core/server/effect/runtime";
import { createRevisionCoordinator } from "../../../apps/kello/src/core/server/realtime/coordinator";
import { defineComponent } from "../../../apps/kello/src/core/server/components/definition";
import {
  defineApplication,
  prepareApplicationEnvironment,
} from "../../../apps/kello/src/core/server/application/definition";
import type { ProcedureContext } from "../../../apps/kello/src/core/server/rpc/procedure";

class VendorClient {
  constructor(readonly name: string) {}
  greet() {
    return this.name;
  }
}

test("assembled service contexts preserve SDK objects, mount configuration and forbidden live access", async () => {
  let acquired = 0;
  let released = 0;
  let authorized = false;
  const definition = defineComponent({
    name: "sdk",
    options: v.object({ name: v.string() }),
    services: ({ options }) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          acquired++;
          return { sdk: new VendorClient(options.name) };
        }),
        () =>
          Effect.sync(() => {
            released++;
          }),
      ),
  });
  const app = defineApplication({ rpc: ({ os }) => ({ os }) });
  app.use(definition, { name: "first", options: { name: "one" } });
  app.use(definition, { name: "second", options: { name: "two" } });
  const application = await prepareApplicationEnvironment(app, {});
  const parent = os
    .$context<
      ProcedureContext & {
        components: {
          first: { services: { sdk: VendorClient } };
          second: { services: { sdk: VendorClient } };
        };
      }
    >()
    .handler(({ context }) => {
      expect(context.components.first.services.sdk).toBeInstanceOf(VendorClient);
      return [context.components.first.services.sdk.greet(), context.components.second.services.sdk.greet()];
    });
  const local = os
    .$context<ProcedureContext & { services: { sdk: VendorClient } }>()
    .handler(({ context }) => context.services.sdk.greet());
  const effects = createEffectRuntime(Layer.empty);
  const coordinator = createRevisionCoordinator({ readRevisions: async () => ({}) });
  const pool = new pg.Pool({ connectionString: "postgresql://unused:unused@127.0.0.1:1/unused" });
  const db = drizzle({ client: pool });
  const graph = bindRuntimeGraph({
    entries: [
      { path: ["get"], visibility: "public", procedure: parent },
      { scope: "first", path: ["local"], visibility: "exported", procedure: local },
    ],
    scopes: [
      { name: "", dependencies: { first: "first", second: "second" } },
      { name: "first", dependencies: {} },
      { name: "second", dependencies: {} },
    ],
    exposures: [{ scope: "first", prefix: "first" }],
    application,
    effects,
    coordinator,
    activate: async () => {},
    authorize: async () => {
      if (!authorized) throw new Error("Unauthorized");
    },
    database: {
      connection: { db, pool, transaction: db.transaction.bind(db), close: () => pool.end() },
      replay: { metadataNamespace: "loom_meta", deployment: "test" },
      authorize: async () => {},
    },
  });
  try {
    const invocation = { requestId: "sdk", identity: null, signal: new AbortController().signal };
    const context = { ...invocation, "effect/context": Context.make(Invocation, invocation) };
    const get = graph.router.get;
    assert(get instanceof Procedure);
    await assert.rejects(call(get, undefined, { context }));
    expect(acquired).toBe(0);
    authorized = true;
    await assert.rejects(call(get, undefined, { context: { ...context, operation: "live" } }));
    expect(acquired).toBe(0);
    expect(await call(get, undefined, { context })).toEqual(["one", "two"]);
    expect(await call(get, undefined, { context })).toEqual(["one", "two"]);
    expect(acquired).toBe(2);
    expect(released).toBe(0);
    await assert.rejects(call(get, undefined, { context: { ...context, operation: "live" } }));
    expect(acquired).toBe(2);
    const first = graph.router.first;
    assert(first && !(first instanceof Procedure) && "local" in first);
    const route = first.local;
    assert(route instanceof Procedure);
    expect(await call(route, undefined, { context })).toBe("one");
  } finally {
    await graph.stop();
    await effects.stop();
    await coordinator.stop();
    await pool.end();
  }
  expect(released).toBe(2);
});

function serviceHarness(
  configuration: Pick<Parameters<typeof bindRuntimeGraph>[0], "entries" | "scopes" | "application" | "exposures">,
) {
  const effects = createEffectRuntime(Layer.empty);
  const coordinator = createRevisionCoordinator({ readRevisions: async () => ({}) });
  const pool = new pg.Pool({ connectionString: "postgresql://unused:unused@127.0.0.1:1/unused" });
  const db = drizzle({ client: pool });
  const graph = bindRuntimeGraph({
    ...configuration,
    effects,
    coordinator,
    activate: async () => {},
    authorize: async () => {},
    database: {
      connection: { db, pool, transaction: db.transaction.bind(db), close: () => pool.end() },
      replay: { metadataNamespace: "loom_meta", deployment: "test" },
      authorize: async () => {},
    },
  });
  return {
    graph,
    async close() {
      await graph.stop();
      await effects.stop();
      await coordinator.stop();
      await pool.end();
    },
  };
}

function serviceInvocation(requestId: string, signal = new AbortController().signal) {
  const invocation = { requestId, identity: null, signal };
  return { ...invocation, "effect/context": Context.make(Invocation, invocation) };
}

import { componentDefinitionFor } from "../../../apps/kello/src/core/server/components/definition";
import type { ComponentRegistration } from "../../../apps/kello/src/core/server/components/definition";

test("dependent SDK factories initialize in order with isolated mount environment and defaults", async () => {
  const observed: string[] = [];
  const provider = defineComponent({
    name: "provider",
    env: { KEY: v.string() },
    services: ({ env }) =>
      Effect.sync(() => {
        observed.push(env.KEY);
        return { sdk: new VendorClient(env.KEY) };
      }),
  });
  const defineDependent = componentDefinitionFor<
    ComponentRegistration & {
      components: { provider: { services: { sdk: VendorClient } } };
    }
  >();
  const dependent = defineDependent({
    name: "dependent",
    options: v.optional(v.object({ suffix: v.string() }), { suffix: "default" }),
    services: ({ components, options }) =>
      Effect.sync(() => {
        const source = components.provider.services.sdk;
        observed.push(`${source.greet()}:dependent`);
        return { source, sdk: new VendorClient(`${source.greet()}:${options.suffix}`) };
      }),
  });
  const app = defineApplication({ env: { FIRST: v.string(), SECOND: v.string() }, rpc: ({ os }) => ({ os }) });
  const first = app.use(provider, { name: "first", env: { KEY: app.env.FIRST } });
  const second = app.use(provider, { name: "second", env: { KEY: app.env.SECOND } });
  app.use(dependent, { name: "left", dependencies: { provider: first } });
  app.use(dependent, { name: "right", dependencies: { provider: second }, options: { suffix: "custom" } });
  const application = await prepareApplicationEnvironment(app, { FIRST: "one", SECOND: "two" });
  const get = os
    .$context<
      ProcedureContext & {
        components: {
          left: { services: { source: VendorClient; sdk: VendorClient } };
          right: { services: { source: VendorClient; sdk: VendorClient } };
        };
      }
    >()
    .handler(({ context }) => {
      expect(context.components.left.services.source).not.toBe(context.components.right.services.source);
      return [context.components.left.services.sdk.greet(), context.components.right.services.sdk.greet()];
    });
  const harness = serviceHarness({
    application,
    entries: [{ path: ["get"], visibility: "public", procedure: get }],
    scopes: [
      { name: "", dependencies: { left: "left", right: "right" } },
      { name: "first", dependencies: {} },
      { name: "second", dependencies: {} },
      { name: "left", dependencies: { provider: "first" } },
      { name: "right", dependencies: { provider: "second" } },
    ],
  });
  try {
    const route = harness.graph.router.get;
    assert(route instanceof Procedure);
    expect(await call(route, undefined, { context: serviceInvocation("dependencies") })).toEqual([
      "one:default",
      "two:custom",
    ]);
    expect(observed.indexOf("one")).toBeLessThan(observed.indexOf("one:dependent"));
    expect(observed.indexOf("two")).toBeLessThan(observed.indexOf("two:dependent"));
    expect(observed).toHaveLength(4);
  } finally {
    await harness.close();
  }
});

test("aborting one requester does not cancel shared SDK acquisition for another requester", async () => {
  let acquired = 0;
  let released = 0;
  let finish!: () => void;
  let began!: () => void;
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const definition = defineComponent({
    name: "sdk",
    services: () =>
      Effect.acquireRelease(
        Effect.promise(async () => {
          acquired++;
          began();
          await gate;
          return { sdk: new VendorClient("shared") };
        }),
        () =>
          Effect.sync(() => {
            released++;
          }),
      ),
  });
  const app = defineApplication({ rpc: ({ os }) => ({ os }) });
  app.use(definition);
  const application = await prepareApplicationEnvironment(app, {});
  const get = os
    .$context<ProcedureContext & { components: { sdk: { services: { sdk: VendorClient } } } }>()
    .handler(({ context }) => context.components.sdk.services.sdk.greet());
  const harness = serviceHarness({
    application,
    entries: [{ path: ["get"], visibility: "public", procedure: get }],
    scopes: [
      { name: "", dependencies: { sdk: "sdk" } },
      { name: "sdk", dependencies: {} },
    ],
  });
  try {
    const route = harness.graph.router.get;
    assert(route instanceof Procedure);
    const abort = new AbortController();
    const first = call(route, undefined, { context: serviceInvocation("first", abort.signal), signal: abort.signal });
    const rejected = assert.rejects(first);
    await started;
    const second = call(route, undefined, { context: serviceInvocation("second") });
    abort.abort();
    finish();
    expect(await second).toBe("shared");
    await rejected;
    expect(acquired).toBe(1);
    expect(released).toBe(0);
  } finally {
    finish();
    await harness.close();
  }
  expect(released).toBe(1);
});

import { defineRelations } from "drizzle-orm";
import { createProjectProcedures } from "../../../apps/kello/src/core/server/rpc/procedure";
import { createDatabaseMiddleware } from "../../../apps/kello/src/core/server/rpc/database";
import { connectDatabase } from "../../../apps/kello/src/core/server/database/connection";
import { defineSchema } from "../../../apps/kello/src/core/schema/define-schema";
import type { RouterClient } from "@orpc/server";

const serviceDatabaseUrl = process.env.LOOM_TEST_DATABASE_URL;
test.skipIf(!serviceDatabaseUrl)("warmed SDKs reject explicit retryable and nested service access", async () => {
  if (!serviceDatabaseUrl) throw new Error("Missing database URL");
  let acquired = 0;
  let retryableEntries = 0;
  let nestedEntries = 0;
  const sdk = defineComponent({
    name: "sdk",
    services: () => {
      acquired++;
      return { sdk: new VendorClient("ready") };
    },
  });
  const app = defineApplication({ rpc: ({ os }) => ({ os }) });
  app.use(sdk);
  const application = await prepareApplicationEnvironment(app, {});
  const schema = defineSchema(() => ({}));
  const relations = defineRelations(schema.tables);
  const connection = await connectDatabase({ schema, relations, connectionString: serviceDatabaseUrl });
  const effects = createEffectRuntime(Layer.empty);
  const coordinator = createRevisionCoordinator({ readRevisions: async () => ({}) });
  const local = os.$context<ProcedureContext & { services: { sdk: VendorClient } }>().handler(({ context }) => {
    nestedEntries++;
    return context.services.sdk.greet();
  });
  const warm = os
    .$context<ProcedureContext & { components: { sdk: { services: { sdk: VendorClient } } } }>()
    .handler(({ context }) => context.components.sdk.services.sdk.greet());
  const retryable = createProjectProcedures(schema)
    .procedure.use(createDatabaseMiddleware(relations, "read", schema))
    .input(v.boolean())
    .handler(async ({ context, input }) => {
      retryableEntries++;
      // SAFETY: bindRuntimeGraph below declares exactly this SDK dependency and exported router.
      const scoped = context as typeof context & {
        components: {
          sdk: {
            services: { sdk: VendorClient };
            rpc: RouterClient<{ get: typeof local }>;
          };
        };
      };
      return input ? scoped.components.sdk.rpc.get() : scoped.components.sdk.services.sdk.greet();
    });
  const graph = bindRuntimeGraph({
    application,
    effects,
    coordinator,
    activate: async () => {},
    authorize: async () => {},
    entries: [
      { path: ["warm"], visibility: "public", procedure: warm },
      { path: ["denied"], visibility: "public", procedure: retryable },
      { scope: "sdk", path: ["get"], visibility: "exported", procedure: local },
    ],
    scopes: [
      { name: "", dependencies: { sdk: "sdk" } },
      { name: "sdk", dependencies: {} },
    ],
    database: {
      connection,
      replay: { metadataNamespace: "loom_meta", deployment: "service-test" },
      authorize: async () => {},
    },
  });
  try {
    const warmRoute = graph.router.warm;
    const deniedRoute = graph.router.denied;
    assert(warmRoute instanceof Procedure && deniedRoute instanceof Procedure);
    const context = serviceInvocation("retryable");
    expect(await call(warmRoute, undefined, { context })).toBe("ready");
    expect(acquired).toBe(1);
    await assert.rejects(call(deniedRoute, false, { context }));
    await assert.rejects(call(deniedRoute, true, { context }));
    expect(acquired).toBe(1);
    expect(retryableEntries).toBe(2);
    expect(nestedEntries).toBe(1);
  } finally {
    await graph.stop();
    await effects.stop();
    await coordinator.stop();
    await connection.close();
  }
});
