import * as v from "valibot";

export const liveQueryEnvelope = v.strictObject({
  version: v.literal(1),
  scope: v.strictObject({ database: v.string(), deployment: v.string() }),
  authorization: v.string(),
  sessionExpiresAt: v.pipe(v.number(), v.safeInteger()),
  query: v.strictObject({
    capability: v.string(),
    queryFingerprint: v.string(),
    expiresAt: v.pipe(v.number(), v.safeInteger()),
  }),
});
