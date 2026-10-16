import { readFile } from "node:fs/promises";
import * as v from "valibot";
import { resolveProjectPath } from "../../config/paths";
import { loadProjectConfig } from "../../project/load";
import type { DeploymentDatabaseProvider } from "./connection";
import type { DeploymentHealthProvider } from "./health";
import { releaseDatabaseOptionsValidator } from "./release-database";
import { retireNeonReleaseDatabase } from "./retire";

const declarationValidator = v.strictObject({
  format: v.literal(1),
  ...v.pick(releaseDatabaseOptionsValidator, ["releaseKey", "environment", "databaseName", "migrationRole"]).entries,
  activationTokenEnv: v.pipe(v.string(), v.regex(/^[A-Z][A-Z0-9_]*$/)),
});

/** Retires a saved release without loading the current application schema or functions. */
export async function retireProjectReleaseDatabase(
  root: string,
  file: string,
  provider?: DeploymentDatabaseProvider & DeploymentHealthProvider,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const path = await resolveProjectPath(root, file);
  let declaration: v.InferOutput<typeof declarationValidator>;
  try {
    declaration = v.parse(declarationValidator, JSON.parse(await readFile(path, "utf8")));
  } catch {
    throw new Error("Invalid database retirement declaration");
  }
  const { config } = await loadProjectConfig(root);
  const { format: _format, activationTokenEnv, ...options } = declaration;
  if (["NEON_API_KEY", config.database.migrationUrlEnv].includes(activationTokenEnv))
    throw new Error("Reserved retirement environment source");
  const token = v.safeParse(releaseDatabaseOptionsValidator.entries.activationToken, process.env[activationTokenEnv]);
  if (!token.success) throw new Error("Missing or invalid retirement activation token");
  signal?.throwIfAborted();
  const input = { ...options, config, activationToken: token.output };
  return retireNeonReleaseDatabase(root, signal ? { ...input, signal } : input, provider);
}
