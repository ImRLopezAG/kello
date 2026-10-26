import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import * as v from "valibot";
import {
  applicationEnvironmentSources,
  resolveReleaseEnvironment,
} from "../../../apps/kello-cli/src/tooling/deploy/neon/environment";

test("application environment forwards declared custom variables and preserves provider injection", async () => {
  const declaration = {
    PORT: v.pipe(v.string(), v.transform(Number)),
    OPTIONAL: v.optional(v.string(), "default"),
    DATABASE_URL: v.string(),
    AWS_SECRET_ACCESS_KEY: v.string(),
  };
  const sources = applicationEnvironmentSources(declaration);
  expect(sources).toEqual({ PORT: "PORT", OPTIONAL: "OPTIONAL" });
  const result = await resolveReleaseEnvironment(
    { ...sources, PORT: "DEPLOY_PORT", LOOM_DATABASE_URL: "RUNTIME_URL" },
    declaration,
    {
      DEPLOY_PORT: "3000",
      RUNTIME_URL: "runtime-url",
      DATABASE_URL: "must-not-forward",
      AWS_SECRET_ACCESS_KEY: "must-not-forward",
      UNDECLARED: "must-not-forward",
    },
  );
  expect(result).toEqual({ PORT: "3000", OPTIONAL: "", LOOM_DATABASE_URL: "runtime-url" });
});

test("deployment validates effective custom values without exposing credentials", async () => {
  const declaration = {
    TOKEN: v.pipe(
      v.string(),
      v.check(() => false, "secret-fixture"),
    ),
  };
  await assert.rejects(
    resolveReleaseEnvironment({ TOKEN: "SOURCE" }, declaration, { SOURCE: "secret-fixture" }),
    (cause: unknown) => {
      assert(cause instanceof Error);
      assert.equal(cause.message, "Invalid application environment variable: TOKEN");
      assert.equal(cause.cause, undefined);
      return true;
    },
  );
  await assert.rejects(
    resolveReleaseEnvironment({ TOKEN: "SOURCE" }, { TOKEN: v.string() }, { SOURCE: "" }),
    /Invalid application environment variable: TOKEN/,
  );
  await assert.rejects(
    resolveReleaseEnvironment({ RUNTIME: "SOURCE" }, undefined, {}),
    /Missing release environment value/,
  );
});

test("component deployment includes only unbound mounted declarations and validates shared sources", async () => {
  const { defineApplication, defineComponent, sealComponentGraph } = await import("kello/server");
  const { componentEnvironmentDeclarations } =
    await import("../../../apps/kello-cli/src/tooling/deploy/neon/environment");
  const component = defineComponent({ name: "sdk", env: { KEY: v.string(), OPTIONAL: v.optional(v.string()) } });
  const app = defineApplication({ env: { CUSTOMER_KEY: v.string() }, rpc: ({ os }) => ({ os }) });
  app.use(component, { env: { KEY: app.env.CUSTOMER_KEY } });
  const declarations = componentEnvironmentDeclarations(sealComponentGraph(app).nodes);
  expect(declarations.map(applicationEnvironmentSources)).toEqual([{ OPTIONAL: "OPTIONAL" }]);
  const result = await resolveReleaseEnvironment(
    { CUSTOMER_KEY: "CUSTOMER_KEY", OPTIONAL: "OPTIONAL" },
    app.environmentSchema,
    { CUSTOMER_KEY: "fixture" },
    declarations,
  );
  expect(result).toEqual({ CUSTOMER_KEY: "fixture", OPTIONAL: "" });
  await assert.rejects(
    resolveReleaseEnvironment({ KEY: "KEY" }, {}, { KEY: "fixture" }, [
      { KEY: v.string() },
      { KEY: v.pipe(v.string(), v.minLength(100)) },
    ]),
    /Invalid application environment variable: KEY/,
  );
});
