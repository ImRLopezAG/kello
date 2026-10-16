import type { loadProject } from "../project/load";

type LoadedProject = Awaited<ReturnType<typeof loadProject>>;

export function runtimeArtifacts(project: LoadedProject) {
  const config = {
    auth: project.config.auth,
    jobs: project.config.jobs,
    realtime: project.config.realtime,
    openapi: project.config.openapi,
  };
  const artifacts = new Map([
    [
      "runtime.js",
      [
        'import { schema, relations, auth, crons, storage, procedures, jobMigrations, application, scopes, exposures } from "./router.js";',
        'import { version } from "./version.mjs";',
        "export function runtimeOptions() {",
        `  return { schema, relations, auth, crons, storage, procedures, jobMigrations, application, scopes, exposures, authScopes: ${JSON.stringify(project.authScopes.map(({ mountPath, namespace, fingerprint }) => ({ mountPath, namespace, fingerprint })))}, version, metadataNamespace: ${JSON.stringify(project.config.database.metadataNamespace)}, config: ${JSON.stringify(config)} };`,
        "}",
        "",
      ].join("\n"),
    ],
  ]);
  for (const [name, exported, factory] of [
    ["service", "createService", "createNeonRpcService"],
    ["worker", "createWorker", "createNeonRpcWorker"],
  ] as const) {
    artifacts.set(
      `${name}.js`,
      [
        `import { ${factory} } from "kello/neon";`,
        'import { runtimeOptions } from "./runtime.js";',
        `export function ${exported}(options) { return ${factory}({ ...options, ...runtimeOptions() }); }`,
        "",
      ].join("\n"),
    );
    const binding = name === "worker" ? " & { readonly bindings: Readonly<Record<string, NeonTriggerBinding>> }" : "";
    artifacts.set(
      `${name}.d.ts`,
      [
        `import type { ${factory}${name === "worker" ? ", NeonTriggerBinding" : ""} } from "kello/neon";`,
        `import type { RpcRuntimeOptions } from "kello/server";`,
        'import type { AnyRelations } from "drizzle-orm";',
        `type ConnectionOptions = Pick<RpcRuntimeOptions<AnyRelations>, "connectionString" | "deployment" | "assertActive" | "assertIngress" | "maxConnections" | "storageBackend" | "directConnectionString" | "environment" | "branchId">;`,
        `export declare function ${exported}(options: ConnectionOptions${binding}): ReturnType<typeof ${factory}>;`,
        "",
      ].join("\n"),
    );
  }
  return Object.fromEntries(artifacts);
}
