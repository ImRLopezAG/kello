import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import * as v from "valibot";
import { canonical } from "../../validation/canonical";
import type { InvocationIdentity } from "../auth/context";
import { rateLimitPolicyNameValidator, rateLimitPolicyValidator } from "./policy";
import type { RateLimitPolicy } from "./policy";

export interface RateLimitKeyInput {
  readonly metadataNamespace: string;
  readonly applicationNamespace: string;
  /** Empty string denotes the root scope. */
  readonly mountPath: string;
  readonly policyName: string;
  readonly policy: RateLimitPolicy;
  readonly identity: InvocationIdentity;
}

function boundedString(maxBytes: number, allowEmpty = false) {
  return v.pipe(
    v.string(),
    v.check(
      (value) =>
        (allowEmpty || value.length > 0) &&
        !value.includes("\0") &&
        !/[\uD800-\uDFFF]/u.test(value) &&
        Buffer.byteLength(value, "utf8") <= maxBytes,
    ),
  );
}
const identityValidator = v.object({
  issuer: boundedString(2048),
  subject: boundedString(2048),
  tenantId: v.optional(boundedString(2048)),
});
const keyValidator = v.strictObject({
  metadataNamespace: boundedString(256),
  applicationNamespace: boundedString(256),
  mountPath: boundedString(256, true),
  policyName: rateLimitPolicyNameValidator,
  policy: rateLimitPolicyValidator,
  identity: identityValidator,
});

/** Hex SHA256 of the v1 canonical array. No raw identity is returned or retained. */
export function createRateLimitKey(input: RateLimitKeyInput): string {
  const result = v.safeParse(keyValidator, input);
  // Do not expose Valibot's input-bearing issues at the identity boundary.
  if (!result.success) throw new Error("Invalid rate limit key input");
  const { metadataNamespace, applicationNamespace, mountPath, policyName, policy, identity } = result.output;
  const { issuer, subject, tenantId } = identity;
  if (policy.scope !== "user" && tenantId === undefined) throw new Error("Rate limit scope requires tenant identity");
  const payload =
    policy.scope === "user"
      ? [issuer, subject]
      : policy.scope === "tenant"
        ? [issuer, tenantId!]
        : [issuer, tenantId!, subject];
  return createHash("sha256")
    .update(
      canonical([
        "kello.rate-limit.key.v1",
        metadataNamespace,
        applicationNamespace,
        mountPath,
        policyName,
        policy.version,
        policy.scope,
        payload,
      ]),
    )
    .digest("hex");
}
