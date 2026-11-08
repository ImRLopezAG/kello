import { describe, expect, test } from "vite-plus/test";
import { resolveFunctionEnv, splitFunctionEnv } from "@neon/config/v1";
import { neonFunctionPolicy } from "../../../apps/kello-cli/src/tooling/deploy/neon/policy";

const functions = [{ role: "service" as const, slug: "service", source: "service.ts" }];

function functionEnv(variables: Record<string, string>) {
  const env = neonFunctionPolicy(functions, variables).functions?.["service"]?.env;
  if (!env) throw new Error("Function environment missing");
  return env;
}

describe("Neon function policy environment", () => {
  test("declares an empty variable as an optional native unset", () => {
    expect(functionEnv({ OPTIONAL: "" })["OPTIONAL"]).toEqual({
      value: undefined,
      required: false,
      onUndefined: "unset",
    });
  });

  test("keeps non-empty values literal", () => {
    const env = functionEnv({ API_KEY: "secret-value", MODE: "production" });
    expect(env["API_KEY"]).toBe("secret-value");
    expect(env["MODE"]).toBe("production");
  });

  test("applies the same declarations to every function", () => {
    const config = neonFunctionPolicy([...functions, { role: "worker", slug: "worker", source: "worker.ts" }], {
      OPTIONAL: "",
      KEPT: "value",
    });
    expect(config.functions?.["worker"]?.env).toEqual(config.functions?.["service"]?.env);
  });

  test("resolves an unset variable to an empty string on deploy, which deletes the retained value", () => {
    const { env, envVars } = splitFunctionEnv(functionEnv({ OPTIONAL: "", KEPT: "value" }));
    expect(env).toEqual({ KEPT: "value" });
    expect(resolveFunctionEnv(envVars, "deploy")).toEqual({ env: { OPTIONAL: "" }, missing: [] });
  });

  test("does not require an unset variable for a deploy target", () => {
    const { envVars } = splitFunctionEnv(functionEnv({ OPTIONAL: "" }));
    expect(resolveFunctionEnv(envVars, "deploy").missing).toEqual([]);
  });

  test("leaves an unset variable out of local development", () => {
    const { envVars } = splitFunctionEnv(functionEnv({ OPTIONAL: "" }));
    expect(resolveFunctionEnv(envVars, "development").env).toEqual({});
  });
});
