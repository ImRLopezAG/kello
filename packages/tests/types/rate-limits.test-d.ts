import {
  defineRateLimits,
  isRateLimitDefinitions,
  type RateLimitDefinitions,
  type RateLimitPolicyNames,
} from "../../../apps/loom/src/core/server/rate-limits/policy";

const definitions = defineRateLimits({
  createItem: { version: 1, mode: "quota", scope: "userInTenant", limit: 100, windowMs: 60_000 },
  sensitiveAttempt: { version: 1, mode: "attempt", scope: "user", limit: 5, windowMs: 60_000 },
});
type Equal<L, R> = (<T>() => T extends L ? 1 : 2) extends <T>() => T extends R ? 1 : 2 ? true : false;
type Assert<T extends true> = T;
export type PolicyProof = [
  Assert<Equal<RateLimitPolicyNames<typeof definitions.policies, "quota">, "createItem">>,
  Assert<Equal<RateLimitPolicyNames<typeof definitions.policies, "attempt">, "sensitiveAttempt">>,
  Assert<Equal<typeof definitions.policies.createItem.limit, 100>>,
  Assert<Equal<typeof definitions.policies.createItem.scope, "userInTenant">>,
  Assert<Equal<RateLimitPolicyNames<{}, "quota">, never>>,
];

const generic: RateLimitDefinitions = definitions;
void generic;
// @ts-expect-error policy maps are immutable
definitions.policies.createItem = { version: 1, mode: "quota", scope: "userInTenant", limit: 100, windowMs: 60_000 };
// @ts-expect-error policy values are immutable
definitions.policies.createItem.limit = 100;
// @ts-expect-error definition metadata is immutable
definitions.fingerprint = "changed";
// @ts-expect-error unknown names are excluded
const unknown: RateLimitPolicyNames<typeof definitions.policies, "quota"> = "unknown";
// @ts-expect-error attempt names cannot be charged as quota
const wrongMode: RateLimitPolicyNames<typeof definitions.policies, "quota"> = "sensitiveAttempt";
void unknown;
void wrongMode;
// @ts-expect-error modes are closed
defineRateLimits({ p: { version: 1, mode: "other", scope: "user", limit: 1, windowMs: 1000 } });
// @ts-expect-error scopes are closed
defineRateLimits({ p: { version: 1, mode: "quota", scope: "global", limit: 1, windowMs: 1000 } });

export function narrowDefinitions(value: RateLimitDefinitions | undefined): RateLimitDefinitions | undefined {
  if (isRateLimitDefinitions(value)) return value;
  return undefined;
}

import type { InvocationRateLimits } from "../../../apps/loom/src/core/server/rate-limits/service";
export function verifyRateLimitMethods(limits: InvocationRateLimits) {
  const quota: Promise<void> = limits.quotaPromise(definitions, "createItem");
  const attempt: Promise<void> = limits.attemptPromise(definitions, "sensitiveAttempt");
  limits.quota(definitions, "createItem");
  limits.attempt(definitions, "sensitiveAttempt");
  // @ts-expect-error Unknown quota name cannot widen the map.
  limits.quota(definitions, "missing");
  // @ts-expect-error Attempt policy cannot be a quota.
  limits.quota(definitions, "sensitiveAttempt");
  // @ts-expect-error Unknown Promise quota name cannot widen the map.
  void limits.quotaPromise(definitions, "missing");
  // @ts-expect-error Attempt policy cannot be a Promise quota.
  void limits.quotaPromise(definitions, "sensitiveAttempt");
  // @ts-expect-error Unknown attempt name cannot widen the map.
  limits.attempt(definitions, "missing");
  // @ts-expect-error Quota policy cannot be an attempt.
  limits.attempt(definitions, "createItem");
  // @ts-expect-error Unknown Promise attempt name cannot widen the map.
  void limits.attemptPromise(definitions, "missing");
  // @ts-expect-error Quota policy cannot be a Promise attempt.
  void limits.attemptPromise(definitions, "createItem");
  return { quota, attempt };
}
