import { componentReleaseScopesValidator } from "../deploy/component-scopes";
import * as v from "valibot";

const identifier = v.pipe(v.string(), v.regex(/^[a-z][a-z0-9_]{0,62}$/));
const environmentName = v.pipe(v.string(), v.regex(/^[A-Z][A-Z0-9_]*$/));
const hash = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/));
const slug = v.pipe(v.string(), v.regex(/^[a-z0-9]{1,20}$/));

export const deploymentConfigValidator = v.strictObject({
  environment: v.picklist(["preview", "production"]),
  deployment: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
  databaseName: identifier,
  migrationRole: identifier,
  runtimeRole: identifier,
  quarantine: v.optional(v.picklist(["clone", "preserve"]), "preserve"),
  activationTokenEnv: v.optional(environmentName, "LOOM_ACTIVATION_TOKEN"),
  slugs: v.optional(v.strictObject({ service: slug, worker: slug })),
  variables: v.optional(v.record(environmentName, environmentName), {}),
  reviewedHashes: v.optional(v.array(hash), []),
  componentScopes: v.optional(componentReleaseScopesValidator),
  schema: v.optional(v.strictObject({ minimum: hash, maximum: hash, target: hash })),
});
