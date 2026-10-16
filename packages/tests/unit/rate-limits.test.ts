import { describe, expect, test } from "vite-plus/test";
import { createHash } from "node:crypto";
import {
  defineRateLimits,
  isRateLimitDefinitions,
  rateLimitPolicyFingerprint,
} from "../../../apps/loom/src/core/server/rate-limits/policy";
import { createRateLimitKey } from "../../../apps/loom/src/core/server/rate-limits/key";

const quota = { version: 1, mode: "quota", scope: "user", limit: 10, windowMs: 60_000 } as const;
const base = {
  metadataNamespace: "metadata",
  applicationNamespace: "app",
  mountPath: "",
  policyName: "createItem",
  policy: quota,
  identity: { issuer: "issuer", subject: "alice", tenantId: "tenant" },
};
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

describe("rate limit definitions", () => {
  test("captures immutable configuration and recognizes independently evaluated content", async () => {
    const input = { createItem: { ...quota } };
    const definitions = defineRateLimits(input);
    Object.assign(input.createItem, { limit: 99 });
    expect(definitions.policies.createItem.limit).toBe(10);
    expect(Object.isFrozen(definitions)).toBe(true);
    expect(Object.isFrozen(definitions.policies)).toBe(true);
    expect(Object.isFrozen(definitions.policies.createItem)).toBe(true);
    // A distinct module evaluation has its own module-local objects and functions.
    // @ts-expect-error Vite's query suffix creates a second evaluation; it is not a TypeScript module path.
    const independent = await import("../../../apps/loom/src/core/server/rate-limits/policy?independent");
    expect(independent.defineRateLimits).not.toBe(defineRateLimits);
    expect(isRateLimitDefinitions(independent.defineRateLimits({ createItem: quota }))).toBe(true);
    expect(independent.isRateLimitDefinitions(definitions)).toBe(true);
    expect(isRateLimitDefinitions({ ...definitions, policies: { createItem: { ...quota, limit: 99 } } })).toBe(false);
    expect(isRateLimitDefinitions({ ...definitions, fingerprint: "0".repeat(64) })).toBe(false);
    expect(isRateLimitDefinitions({ ...definitions, extra: true })).toBe(false);
    expect(isRateLimitDefinitions({ policies: { createItem: quota } })).toBe(false);
    expect(isRateLimitDefinitions(null)).toBe(false);
    expect(isRateLimitDefinitions({ ...definitions, policies: { createItem: { ...quota, mode: "unknown" } } })).toBe(
      false,
    );
  });

  test("fingerprints canonical content independent of insertion order", () => {
    const attempt = { ...quota, mode: "attempt", scope: "tenant" } as const;
    expect(defineRateLimits({ a: quota, b: attempt }).fingerprint).toBe(
      defineRateLimits({ b: attempt, a: { windowMs: 60_000, limit: 10, scope: "user", mode: "quota", version: 1 } })
        .fingerprint,
    );
    expect(rateLimitPolicyFingerprint(quota)).toBe(digest('["kello.rate-limit.policy.v1",1,"quota","user",10,60000]'));
    for (const changed of [
      { ...quota, version: 2 },
      { ...quota, mode: "attempt" as const },
      { ...quota, scope: "tenant" as const },
      { ...quota, limit: 11 },
      { ...quota, windowMs: 61_000 },
    ])
      expect(rateLimitPolicyFingerprint(changed)).not.toBe(rateLimitPolicyFingerprint(quota));
    expect(defineRateLimits({ renamed: quota }).fingerprint).not.toBe(
      defineRateLimits({ original: quota }).fingerprint,
    );
  });

  test("enforces closed policy fields, names, counts and numeric bounds", () => {
    expect(isRateLimitDefinitions(defineRateLimits({}))).toBe(true);
    expect(() =>
      defineRateLimits(Object.fromEntries(Array.from({ length: 128 }, (_, i) => [`p${i}`, quota]))),
    ).not.toThrow();
    expect(() =>
      defineRateLimits(Object.fromEntries(Array.from({ length: 129 }, (_, i) => [`p${i}`, quota]))),
    ).toThrow();
    for (const name of ["", "0abc", "a/b", "é", "a\0", "a\n", "a".repeat(65), "\ud800"]) {
      expect(() => defineRateLimits({ [name]: quota })).toThrow();
    }
    expect(() => defineRateLimits({ ["a".repeat(64)]: quota })).not.toThrow();
    // These are valid ASCII names and must not be dropped by dictionary parsing.
    const specialNames = defineRateLimits({ constructor: quota, prototype: quota });
    expect(Object.keys(specialNames.policies)).toEqual(["constructor", "prototype"]);
    expect(isRateLimitDefinitions(specialNames)).toBe(true);
    for (const [field, values] of [
      ["version", [0, 2 ** 31, 1.5, NaN, Infinity]],
      ["limit", [0, 1_000_001, 1.5, NaN, Infinity]],
      ["windowMs", [999, 86_400_001, 1_000.5, NaN, Infinity]],
      ["mode", ["other"]],
      ["scope", ["global", "anonymous"]],
    ] as const) {
      for (const value of values) {
        // SAFETY: invalid runtime input intentionally crosses the typed boundary to exercise validation.
        expect(() => defineRateLimits({ p: { ...quota, [field]: value } } as never)).toThrow();
      }
    }
    for (const policy of [null, {}, { ...quota, extra: true }, { ...quota, limit: "10" }]) {
      // SAFETY: invalid runtime input intentionally crosses the typed boundary to exercise validation.
      expect(() => defineRateLimits({ p: policy } as never)).toThrow();
    }
    expect(() =>
      defineRateLimits({ p: { ...quota, version: 2 ** 31 - 1, limit: 1_000_000, windowMs: 86_400_000 } }),
    ).not.toThrow();
    expect(() => defineRateLimits({ p: { ...quota, version: 1, limit: 1, windowMs: 1_000 } })).not.toThrow();
  });
});

describe("trusted rate limit identity keys", () => {
  test("uses the versioned canonical SHA256 contract and excludes policy configuration", () => {
    const key = createRateLimitKey(base);
    expect(key).toBe(
      digest('["kello.rate-limit.key.v1","metadata","app","","createItem",1,"user",["issuer","alice"]]'),
    );
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(createRateLimitKey({ ...base, policy: { ...quota, mode: "attempt", limit: 20, windowMs: 1_000 } })).toBe(
      key,
    );
    for (const changed of [
      { ...base, metadataNamespace: "other" },
      { ...base, applicationNamespace: "other" },
      { ...base, mountPath: "component" },
      { ...base, policyName: "other" },
      { ...base, policy: { ...quota, version: 2 } },
      { ...base, identity: { ...base.identity, issuer: "other" } },
      { ...base, identity: { ...base.identity, subject: "other" } },
    ])
      expect(createRateLimitKey(changed)).not.toBe(key);
  });

  test("separates scopes and delimiter-like identities without normalization", () => {
    const tenant = { ...base, policy: { ...quota, scope: "tenant" } } as const;
    expect(createRateLimitKey({ ...tenant, identity: { ...base.identity, subject: "bob" } })).toBe(
      createRateLimitKey(tenant),
    );
    expect(createRateLimitKey({ ...tenant, identity: { ...base.identity, tenantId: "other" } })).not.toBe(
      createRateLimitKey(tenant),
    );
    expect(createRateLimitKey({ ...tenant, identity: { ...base.identity, issuer: "other" } })).not.toBe(
      createRateLimitKey(tenant),
    );
    const userInTenant = { ...base, policy: { ...quota, scope: "userInTenant" } } as const;
    expect(createRateLimitKey(userInTenant)).not.toBe(createRateLimitKey(tenant));
    expect(createRateLimitKey({ ...userInTenant, identity: { ...base.identity, subject: "bob" } })).not.toBe(
      createRateLimitKey(userInTenant),
    );
    expect(createRateLimitKey({ ...userInTenant, identity: { ...base.identity, tenantId: "other" } })).not.toBe(
      createRateLimitKey(userInTenant),
    );
    expect(createRateLimitKey({ ...base, identity: { issuer: "a|b", subject: "c" } })).not.toBe(
      createRateLimitKey({ ...base, identity: { issuer: "a", subject: "b|c" } }),
    );
    expect(createRateLimitKey({ ...base, identity: { issuer: "a", subject: "é" } })).not.toBe(
      createRateLimitKey({ ...base, identity: { issuer: "a", subject: "e\u0301" } }),
    );
    expect(createRateLimitKey({ ...base, identity: { issuer: "a", subject: " Alice " } })).not.toBe(keyForAlice());
  });

  test("validates Unicode and UTF8 byte bounds without exposing raw identity", () => {
    for (const field of ["issuer", "subject", "tenantId"] as const) {
      for (const value of ["", "secret\0", "\ud800", "\udc00", "é".repeat(1025)]) {
        expect(() => createRateLimitKey({ ...base, identity: { ...base.identity, [field]: value } })).toThrow();
      }
      expect(() =>
        createRateLimitKey({ ...base, identity: { ...base.identity, [field]: "é".repeat(1024) } }),
      ).not.toThrow();
    }
    expect(() => createRateLimitKey({ ...base, identity: { issuer: "issuer", subject: "😀" } })).not.toThrow();
    for (const field of ["metadataNamespace", "applicationNamespace", "mountPath"] as const) {
      for (const value of ["secret\0", "\ud800", "é".repeat(129)])
        expect(() => createRateLimitKey({ ...base, [field]: value })).toThrow();
      expect(() => createRateLimitKey({ ...base, [field]: "é".repeat(128) })).not.toThrow();
    }
    expect(() => createRateLimitKey({ ...base, applicationNamespace: "" })).toThrow();
    expect(() => createRateLimitKey({ ...base, metadataNamespace: "" })).toThrow();
    expect(() => createRateLimitKey({ ...base, policyName: "bad\0" })).toThrow();
    expect(() => createRateLimitKey({ ...base, policy: { ...quota, version: 0 } })).toThrow();
    for (const scope of ["tenant", "userInTenant"] as const) {
      expect(() =>
        createRateLimitKey({ ...base, policy: { ...quota, scope }, identity: { issuer: "issuer", subject: "alice" } }),
      ).toThrow();
    }
    try {
      createRateLimitKey({ ...base, identity: { ...base.identity, subject: "private-subject\0" } });
      throw new Error("Expected identity rejection");
    } catch (error) {
      expect(String(error)).not.toContain("private-subject");
    }
  });
});

function keyForAlice() {
  return createRateLimitKey({ ...base, identity: { issuer: "a", subject: "Alice" } });
}
