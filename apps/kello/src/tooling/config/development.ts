import * as v from "valibot";

const identifier = v.pipe(v.string(), v.regex(/^[a-z][a-z0-9_]{0,62}$/));
const environmentName = v.pipe(v.string(), v.regex(/^[A-Z][A-Z0-9_]*$/));
const bounded = (minimum: number, maximum: number) =>
  v.pipe(v.number(), v.integer(), v.minValue(minimum), v.maxValue(maximum));

/** Declarative Neon development settings. Secret values remain in the named environment variables. */
export const developmentConfigValidator = v.strictObject({
  databaseName: identifier,
  migrationRole: identifier,
  runtimeRole: identifier,
  deployment: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(256)), "development"),
  activationTokenEnv: v.optional(environmentName, "LOOM_ACTIVATION_TOKEN"),
  port: v.optional(bounded(0, 65535), 3000),
  maxConnections: v.optional(bounded(1, 1000), 100),
  storage: v.optional(
    v.strictObject({
      projectId: v.string(),
      branchId: v.string(),
      endpoint: v.string(),
      region: v.string(),
      accessKeyIdEnv: environmentName,
      secretAccessKeyEnv: environmentName,
    }),
  ),
  debounceMs: v.optional(bounded(0, 60_000), 75),
  jobPollMs: v.optional(bounded(100, 60_000), 1000),
});
