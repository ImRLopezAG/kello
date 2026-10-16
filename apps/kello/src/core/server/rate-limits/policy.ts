import { createHash } from "node:crypto";
import * as v from "valibot";
import { canonical } from "../../validation/canonical";

export type RateLimitMode = "quota" | "attempt";
export type RateLimitScope = "user" | "tenant" | "userInTenant";

export interface RateLimitPolicy {
  readonly version: number;
  readonly mode: RateLimitMode;
  readonly scope: RateLimitScope;
  readonly limit: number;
  readonly windowMs: number;
}

export type RateLimitPolicyNames<
  Policies extends Readonly<Record<string, RateLimitPolicy>>,
  Mode extends RateLimitMode,
> = {
  [Name in keyof Policies]: Policies[Name]["mode"] extends Mode ? Name : never;
}[keyof Policies] &
  string;

export interface RateLimitDefinitions<
  Policies extends Readonly<Record<string, RateLimitPolicy>> = Readonly<Record<string, RateLimitPolicy>>,
> {
  readonly kind: "kello.rate-limit.definitions.v1";
  readonly policies: { readonly [Name in keyof Policies]: Readonly<Policies[Name]> };
  /** Canonical content identity for scope registry comparison, not an authorization grant. */
  readonly fingerprint: string;
}

export const rateLimitPolicyNameValidator = v.pipe(v.string(), v.regex(/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/));
export const rateLimitPolicyValidator = v.strictObject({
  version: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(2 ** 31 - 1)),
  mode: v.picklist(["quota", "attempt"]),
  scope: v.picklist(["user", "tenant", "userInTenant"]),
  limit: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(1_000_000)),
  windowMs: v.pipe(v.number(), v.integer(), v.minValue(1_000), v.maxValue(86_400_000)),
});

// Validate every own name, including constructor/prototype, which v.record skips.
const policiesValidator = v.custom<Readonly<Record<string, RateLimitPolicy>>>((value) => {
  if (!v.is(v.object({}), value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const entries = Object.entries(value);
  return (
    entries.length <= 128 &&
    entries.every(
      ([name, policy]) => v.is(rateLimitPolicyNameValidator, name) && v.is(rateLimitPolicyValidator, policy),
    )
  );
});
const definitionsValidator = v.strictObject({
  kind: v.literal("kello.rate-limit.definitions.v1"),
  policies: policiesValidator,
  fingerprint: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
});

/** Registry fingerprint; changing configuration must not create another identity key. */
export function rateLimitPolicyFingerprint(policy: RateLimitPolicy): string {
  const parsed = v.parse(rateLimitPolicyValidator, policy);
  return createHash("sha256")
    .update(
      canonical([
        "kello.rate-limit.policy.v1",
        parsed.version,
        parsed.mode,
        parsed.scope,
        parsed.limit,
        parsed.windowMs,
      ]),
    )
    .digest("hex");
}

function definitionsFingerprint(policies: Readonly<Record<string, RateLimitPolicy>>): string {
  const entries = Object.entries(policies).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return createHash("sha256")
    .update(
      canonical([
        "kello.rate-limit.definitions.v1",
        entries.map(([name, policy]) => [
          name,
          policy.version,
          policy.mode,
          policy.scope,
          policy.limit,
          policy.windowMs,
        ]),
      ]),
    )
    .digest("hex");
}

export function defineRateLimits<const Policies extends Readonly<Record<string, RateLimitPolicy>>>(
  policies: Policies,
): RateLimitDefinitions<Policies> {
  const parsed = v.parse(policiesValidator, policies);
  const captured = Object.freeze(
    Object.fromEntries(
      Object.entries(parsed).map(([name, policy]) => [name, Object.freeze(v.parse(rateLimitPolicyValidator, policy))]),
    ),
  );
  // SAFETY: validation preserves each name and field, and freezing prevents mutation;
  // the copied runtime map therefore retains the caller's literal policy types.
  const immutable = captured as RateLimitDefinitions<Policies>["policies"];
  return Object.freeze({
    kind: "kello.rate-limit.definitions.v1",
    policies: immutable,
    fingerprint: definitionsFingerprint(captured),
  });
}

/** Validate canonical content across independent evaluations; scope registration is checked by the service. */
export function isRateLimitDefinitions(value: unknown): value is RateLimitDefinitions {
  try {
    const result = v.safeParse(definitionsValidator, value);
    return result.success && result.output.fingerprint === definitionsFingerprint(result.output.policies);
  } catch {
    return false;
  }
}
