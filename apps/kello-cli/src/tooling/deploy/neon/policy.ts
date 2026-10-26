import { defineConfig } from "@neon/config-runtime/v1";

/** Only function code and its explicit environment; provider branch settings and triggers are separate stages. */
export function neonFunctionPolicy(
  functions: ReadonlyArray<{ role: "service" | "worker"; slug: string; source: string }>,
  variables: Readonly<Record<string, string>> = {},
) {
  return defineConfig({
    functions: Object.fromEntries(
      functions.map(({ role, slug, source }) => [
        slug,
        {
          name: `Kello ${role}`,
          source,
          env: { ...variables },
        },
      ]),
    ),
  });
}
