import * as v from "valibot";
import { deploymentConfigValidator } from "./deployment";
import { developmentConfigValidator } from "./development";
import { runtimeConfigValidator } from "kello/server";

const identifier = v.pipe(v.string(), v.regex(/^[a-z][a-z0-9_-]{0,62}$/));
const path = v.pipe(v.string(), v.minLength(1));
const secretName = v.pipe(v.string(), v.regex(/^[A-Z][A-Z0-9_]*$/));
const target = v.strictObject({
  branchId: v.pipe(v.string(), v.minLength(1)),
  protected: v.optional(v.boolean(), false),
});
const configSchema = v.pipe(
  v.strictObject({
    version: v.optional(v.literal(1), 1),
    project: v.optional(identifier, "kello"),
    projectId: v.optional(v.pipe(v.string(), v.regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/))),
    branchId: v.optional(v.pipe(v.string(), v.regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/))),
    backend: v.optional(path, "kello"),
    database: v.optional(
      v.pipe(
        v.strictObject({
          namespace: v.optional(
            v.pipe(
              identifier,
              v.regex(/^[a-z][a-z0-9_]*$/),
              v.check(
                (name) => !name.startsWith("pg_") && !name.startsWith("loom_") && name !== "information_schema",
                "Reserved namespace",
              ),
            ),
            "app",
          ),
          postgresVersion: v.optional(v.literal(18), 18),
          migrations: v.optional(path),
          runtimeUrlEnv: v.optional(secretName, "LOOM_DATABASE_URL"),
          directRuntimeUrlEnv: v.optional(secretName, "LOOM_DIRECT_DATABASE_URL"),
          migrationUrlEnv: v.optional(secretName, "LOOM_MIGRATION_DATABASE_URL"),
          metadataNamespace: v.optional(v.pipe(identifier, v.regex(/^loom_[a-z0-9_]+$/)), "loom_meta"),
        }),
        v.check(
          (database) =>
            database.runtimeUrlEnv !== database.migrationUrlEnv &&
            database.directRuntimeUrlEnv !== database.migrationUrlEnv,
          "Runtime and migration credentials require separate environment variables",
        ),
      ),
      {},
    ),
    deployment: v.optional(deploymentConfigValidator),
    development: v.optional(developmentConfigValidator),
    provider: v.optional(
      v.strictObject({
        projectId: v.pipe(v.string(), v.minLength(1)),
        targets: v.strictObject({
          development: v.optional(target),
          preview: v.optional(target),
          production: v.optional(target),
        }),
      }),
    ),
    ...runtimeConfigValidator.entries,
  }),
  v.transform((config) => ({
    ...config,
    database: {
      ...config.database,
      migrations: config.database.migrations ?? `${config.backend}/_generated/migrations`,
    },
  })),
);
/** Optional operational overrides accepted by defineConfig. Secret settings name environment variables; linked Neon projects supply provider and connection defaults. */
export type KelloConfigInput = v.InferInput<typeof configSchema>;
/** Normalized configuration after validation and defaults. Application authors pass KelloConfigInput instead of manually constructing this resolved shape. */
export type KelloConfig = v.InferOutput<typeof configSchema>;

export function defineConfig(input: KelloConfigInput): KelloConfig {
  return v.parse(configSchema, input);
}
/** The schema is also used for imported executable configuration's untyped default export. */
export const configValidator = configSchema;
