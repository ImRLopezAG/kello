import { defaultComponentReleaseScopes } from "../component-scopes";
import { createHash } from "node:crypto";
import { readMigrations } from "../../migrations/history";
import { readFile } from "node:fs/promises";
import type { NeonApi } from "@neon/config-runtime/v1";
import * as v from "valibot";
import { resolveProjectPath } from "../../config/paths";
import { loadProject } from "../../project/load";
import {
  neonInjectedVariables,
  applicationEnvironmentSources,
  componentEnvironmentDeclarations,
  resolveReleaseEnvironment,
} from "./environment";
import { slugsValidator } from "./plan";
import { deployNeonRelease } from "./release";
import { releaseDatabaseOptionsValidator } from "./release-database";
import { resolveManagedDeploymentCredentials } from "./managed-credentials";
import { publishDeployedClient } from "./publish-client";

const environmentName = v.pipe(v.string(), v.regex(/^[A-Z][A-Z0-9_]*$/));
const declarationValidator = v.strictObject({
  ...v.omit(releaseDatabaseOptionsValidator, ["inputHash", "activationToken"]).entries,
  format: v.literal(1),
  slugs: slugsValidator,
  activationTokenEnv: environmentName,
  variables: v.record(environmentName, environmentName),
});

/** Validates declarations without reading application secrets or mutating provider resources. */
export async function readProjectRelease(root: string, file: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const project = await loadProject(root);
  async function declaration() {
    if (file === "kello.config.ts") {
      const settings = project.config.deployment;
      if (!settings) throw new Error("Run kello link to discover deployment settings, or configure explicit overrides");
      const migrations = await readMigrations(root, project.config.database.migrations);
      const head = migrations.at(-1);
      if (!head) throw new Error("Generate a migration before deployment");
      const variables = {
        [project.config.database.runtimeUrlEnv]: project.config.database.runtimeUrlEnv,
        ...settings.variables,
      };
      if (project.config.realtime.mode === "notify")
        variables[project.config.database.directRuntimeUrlEnv] ??= project.config.database.directRuntimeUrlEnv;
      return {
        ...settings,
        format: 1,
        version: project.version,
        slugs: settings.slugs ?? {
          service: `s${project.version.slice(0, 19)}`,
          worker: `w${project.version.slice(0, 19)}`,
        },
        releaseKey: createHash("sha256").update(project.version).update(settings.deployment).digest("hex"),
        componentScopes: settings.componentScopes ?? (await defaultComponentReleaseScopes(project)),
        migrationHashes: migrations.map((entry) => entry.plan.hash),
        schema: settings.schema ?? { minimum: head.plan.after, maximum: head.plan.after, target: head.plan.after },
        variables,
      };
    } else {
      const path = await resolveProjectPath(root, file);
      return JSON.parse(await readFile(path, "utf8"));
    }
  }
  const input = await declaration();
  const parsed = v.safeParse(declarationValidator, input);
  if (!parsed.success) throw new Error("Invalid release declaration");
  const release = {
    ...parsed.output,
    variables: v.parse(declarationValidator.entries.variables, {
      ...Object.assign({}, ...componentEnvironmentDeclarations(project.components).map(applicationEnvironmentSources)),
      ...applicationEnvironmentSources(project.application?.environmentSchema),
      ...parsed.output.variables,
    }),
  };
  const { activationTokenEnv, variables: sources } = release;
  if (project.version !== parsed.output.version) throw new Error("Release source version changed");
  const privileged = ["NEON_API_KEY", project.config.database.migrationUrlEnv];
  if (
    privileged.includes(activationTokenEnv) ||
    Object.values(sources).some((name) => [...privileged, activationTokenEnv, "LOOM_ACTIVATION_TOKEN"].includes(name))
  )
    throw new Error("Reserved release environment source");
  const reserved = [...neonInjectedVariables, ...privileged, "LOOM_ACTIVATION_TOKEN"];
  if (Object.keys(sources).some((name) => reserved.includes(name)))
    throw new Error("Reserved release environment destination");
  if (!Object.hasOwn(sources, project.config.database.runtimeUrlEnv))
    throw new Error("Missing release runtime variable declaration");
  if (project.config.realtime.mode === "notify" && !Object.hasOwn(sources, project.config.database.directRuntimeUrlEnv))
    throw new Error("Missing direct runtime variable declaration");
  signal?.throwIfAborted();
  return { project, declaration: release };
}

/** Reads a reviewable release declaration; only environment variable names belong in the file. */
export async function deployProjectRelease(root: string, file: string, provider?: NeonApi, signal?: AbortSignal) {
  const { project, declaration } = await readProjectRelease(root, file, signal);
  const { format: _format, activationTokenEnv, variables: sources, ...options } = declaration;
  const environment = { ...process.env };
  const runtimeName = project.config.database.runtimeUrlEnv;
  const directName = project.config.database.directRuntimeUrlEnv;
  const discoverRuntime =
    runtimeName === "LOOM_DATABASE_URL" && sources[runtimeName] === runtimeName && !environment[runtimeName];
  const discoverDirect =
    directName === "LOOM_DIRECT_DATABASE_URL" && sources[directName] === directName && !environment[directName];
  const discoverToken = activationTokenEnv === "LOOM_ACTIVATION_TOKEN" && !environment[activationTokenEnv];
  if (file === "kello.config.ts" && (discoverRuntime || discoverDirect || discoverToken)) {
    const managed = await resolveManagedDeploymentCredentials(
      project.config,
      {
        environment: options.environment,
        databaseName: options.databaseName,
        migrationRole: options.migrationRole,
        runtimeRole: options.runtimeRole,
        deployment: options.deployment,
        version: options.version,
      },
      provider,
      signal,
    );
    if (discoverRuntime) environment[runtimeName] = managed.runtimeUrl;
    if (discoverDirect) environment[directName] = managed.runtimeUrl;
    if (discoverToken) environment[activationTokenEnv] = managed.activationToken;
  }
  function value(name: string): string {
    const result = environment[name];
    if (!result) throw new Error("Missing release environment value");
    return result;
  }
  const activationToken = value(activationTokenEnv);
  if (!v.is(v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)), activationToken))
    throw new Error("Invalid release activation token");
  const variables = await resolveReleaseEnvironment(
    sources,
    project.application?.environmentSchema,
    environment,
    componentEnvironmentDeclarations(project.components),
  );
  const input = { ...options, activationToken, variables };
  const receipt = await deployNeonRelease(project.root, signal ? { ...input, signal } : input, provider);
  await publishDeployedClient(
    project.root,
    {
      projectId: receipt.identity.target.projectId,
      branchId: receipt.identity.target.branchId,
      version: receipt.identity.version,
      serviceSlug: options.slugs.service,
    },
    provider,
  );
  return receipt;
}
