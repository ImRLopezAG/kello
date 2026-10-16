import { readFile } from "node:fs/promises";
import * as v from "valibot";
import { createNeonStorageBackend } from "kello/neon";
import type { RuntimeStorageBackend } from "kello/server";
import { resolveProjectPath } from "../config/paths";
import { developmentRuntimeOptions } from "./runtime";
import { developmentConfigValidator } from "../config/development";
import { startDevelopment, startDevelopmentWithOwnedOutput } from "./development";
import type { DevelopmentDatabaseProvider } from "./connection";
import { loadProjectConfig } from "../project/load";
import { quarantineDevelopmentDatabase } from "./quarantine";
import { resolveManagedDeploymentCredentials } from "../deploy/neon/managed-credentials";

const declarationValidator = v.strictObject({ format: v.literal(1), ...developmentConfigValidator.entries });

async function readDeclaration(root: string, file: string) {
  if (file === "kello.config.ts") {
    const { config } = await loadProjectConfig(root);
    if (!config.development)
      throw new Error("Run kello link to discover development settings, or configure explicit overrides");
    return { format: 1 as const, ...config.development };
  }
  const path = await resolveProjectPath(root, file);
  try {
    return v.parse(declarationValidator, JSON.parse(await readFile(path, "utf8")));
  } catch {
    throw new Error("Invalid development declaration");
  }
}

/** Reads a contained declaration and resolves framework-owned secrets through Neon. */
export async function startProjectDevelopment(
  root: string,
  file = "kello.config.ts",
  provider?: DevelopmentDatabaseProvider,
) {
  return startProjectDevelopmentInternal(root, file, provider);
}

/** Source-internal CLI ownership forwarding; absent from the public tooling barrel. */
export async function startProjectDevelopmentWithOwnedOutput(
  root: string,
  file: string,
  provider: DevelopmentDatabaseProvider | undefined,
  ownedOutputPath: string,
) {
  return startProjectDevelopmentInternal(root, file, provider, ownedOutputPath);
}

async function startProjectDevelopmentInternal(
  root: string,
  file: string,
  provider?: DevelopmentDatabaseProvider,
  ownedOutputPath?: string,
) {
  const declaration = await readDeclaration(root, file);
  const { format: _format, activationTokenEnv, storage, ...options } = declaration;
  if (activationTokenEnv === "NEON_API_KEY") throw new Error("Reserved development environment source");
  let activationToken = process.env[activationTokenEnv];
  if (!activationToken && activationTokenEnv === "LOOM_ACTIVATION_TOKEN" && file === "kello.config.ts") {
    const { config } = await loadProjectConfig(root);
    const managed = await resolveManagedDeploymentCredentials(
      config,
      {
        environment: "preview",
        databaseName: options.databaseName,
        migrationRole: options.migrationRole,
        runtimeRole: options.runtimeRole,
        deployment: options.deployment,
        // Development keeps one secret through file changes and process restarts.
        version: "0".repeat(64),
      },
      provider,
    );
    activationToken = managed.activationToken;
  }
  const token = v.safeParse(developmentRuntimeOptions.entries.activationToken, activationToken);
  if (!token.success) throw new Error("Invalid development activation token");
  const backend: Partial<Record<"storageBackend", RuntimeStorageBackend>> = {};
  if (storage) {
    try {
      const { projectId, branchId, endpoint, region, accessKeyIdEnv, secretAccessKeyEnv } = storage;
      if (new Set(["NEON_API_KEY", activationTokenEnv, accessKeyIdEnv, secretAccessKeyEnv]).size !== 4)
        throw new Error("Distinct storage credential sources required");
      const secret = v.pipe(v.string(), v.minLength(1));
      backend.storageBackend = createNeonStorageBackend(
        { projectId, branchId },
        {
          endpoint,
          region,
          credentials: {
            accessKeyId: v.parse(secret, process.env[accessKeyIdEnv]),
            secretAccessKey: v.parse(secret, process.env[secretAccessKeyEnv]),
          },
        },
      );
    } catch {
      throw new Error("Invalid development storage configuration");
    }
  }
  const input = { ...options, ...backend, root, activationToken: token.output };
  return ownedOutputPath === undefined
    ? startDevelopment(input, provider)
    : startDevelopmentWithOwnedOutput(input, provider, ownedOutputPath);
}

/** Quarantines the selected database without reading runtime secrets or loading backend modules. */
export async function quarantineProjectDevelopment(
  root: string,
  file = "kello.config.ts",
  provider?: DevelopmentDatabaseProvider,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const declaration = await readDeclaration(root, file);
  const { config } = await loadProjectConfig(root);
  signal?.throwIfAborted();
  const cancellation: Partial<Record<"signal", AbortSignal>> = {};
  if (signal) cancellation.signal = signal;
  return quarantineDevelopmentDatabase(
    {
      config,
      databaseName: declaration.databaseName,
      migrationRole: declaration.migrationRole,
      ...cancellation,
    },
    provider,
  );
}
