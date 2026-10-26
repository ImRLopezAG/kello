import * as v from "valibot";

const identifier = v.pipe(v.string(), v.regex(/^[a-z][a-z0-9_]{0,62}$/));
const bounded = (minimum: number, maximum: number) =>
  v.pipe(v.number(), v.integer(), v.minValue(minimum), v.maxValue(maximum));

/** Development deploys to the linked preview target; these settings only select its database and watch pacing. */
export const developmentConfigValidator = v.strictObject({
  databaseName: identifier,
  migrationRole: identifier,
  runtimeRole: identifier,
  debounceMs: v.optional(bounded(0, 60_000), 75),
});
