import { expect, test } from "vite-plus/test";
import { betterAuth } from "better-auth";
import { drizzle } from "drizzle-orm/node-postgres";
import { defineBetterAuth } from "../../../apps/kello/src/core/better-auth/definition";
import { resolveBetterAuthSchema } from "../../../apps/kello/src/core/better-auth/resolve";
import { initializeBetterAuth } from "../../../apps/kello/src/core/better-auth/runtime";
import {
  defineApplication,
  prepareApplicationEnvironment,
} from "../../../apps/kello/src/core/server/application/definition";

test("runtime admits only planned native schemas and binds services once per scope", async () => {
  let creations = 0;
  const create = (database: Parameters<Parameters<typeof resolveBetterAuthSchema>[0]>[0]) => {
    creations++;
    return betterAuth({
      database,
      baseURL: "https://api.test",
      secret: "test-only-runtime-secret-at-least-32-characters",
    });
  };
  const definition = defineBetterAuth({ name: "identity", env: {}, create: ({ database }) => create(database) });
  const app = defineApplication({ rpc: ({ os }) => ({ os }) });
  app.use(definition);
  const schema = await resolveBetterAuthSchema(create, "identity");
  const application = await prepareApplicationEnvironment(app, {});
  const options = { definition: app, application, database: drizzle.mock(), activate: async () => {} };
  await expect(initializeBetterAuth({ ...options, scopes: [] })).rejects.toThrow("Missing planned auth fingerprint");
  await expect(
    initializeBetterAuth({
      ...options,
      scopes: [{ mountPath: "identity", namespace: "identity", fingerprint: "wrong" }],
    }),
  ).rejects.toThrow("differs");
  const before = creations;
  const runtime = await initializeBetterAuth({
    ...options,
    scopes: [{ mountPath: "identity", namespace: "identity", fingerprint: schema.fingerprint }],
  });
  expect(creations).toBe(before + 1);
  expect(runtime.mounts[0]?.prefix).toBe("/api/auth");
  const factory = runtime.application.serviceFactories.identity!;
  expect(factory({})).toEqual(factory({}));
  expect(creations).toBe(before + 1);
});
