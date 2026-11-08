import { defineConfig } from "@neon/config-runtime/v1";
import type { Config } from "@neon/config-runtime/v1";

/** An optional variable released without a value. Neon removes it from the function's merged environment. */
const unsetOptional = { value: undefined, required: false, onUndefined: "unset" } as const;

/** Only function code and its explicit environment; provider branch settings and triggers are separate stages. */
export function neonFunctionPolicy(
  functions: ReadonlyArray<{ role: "service" | "worker"; slug: string; source: string }>,
  variables: Readonly<Record<string, string>> = {},
): Config {
  const env = Object.fromEntries(
    Object.entries(variables).map(([name, value]) => [name, value === "" ? { ...unsetOptional } : value]),
  );
  return defineConfig({
    functions: Object.fromEntries(
      functions.map(({ role, slug, source }) => [slug, { name: `Kello ${role}`, source, env: { ...env } }]),
    ),
  });
}
