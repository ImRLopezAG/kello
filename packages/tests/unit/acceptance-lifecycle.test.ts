import { expect, test } from "vite-plus/test";
import {
  acceptanceExpiry,
  acceptanceSchemasForRole,
  assertAcceptanceBranch,
  assertDisposableBranch,
  MAX_ACCEPTANCE_TTL_MS,
  planTeardown,
  quoteIdentifier,
  redact,
  selectLeftovers,
  teardownStatements,
} from "../../e2e/cloud/lifecycle";

const now = Date.parse("2026-11-22T00:00:00Z");
const hex = "0123456789abcdef0123456789abcdef";
const role = `runtime_${hex}`;
const hour = 60 * 60 * 1000;

test("acceptance branches must be unprotected, non-default and expire within seven days", () => {
  const branch = { name: "kello-acceptance-x", expires_at: new Date(now + 2 * hour).toISOString() };
  expect(() => assertDisposableBranch(branch, now)).not.toThrow();
  expect(() => assertDisposableBranch({ ...branch, expires_at: null }, now)).toThrow(/no expiry/);
  expect(() => assertDisposableBranch({ ...branch, expires_at: "soon" }, now)).toThrow(/valid timestamp/);
  expect(() => assertDisposableBranch({ ...branch, expires_at: new Date(now - 1).toISOString() }, now)).toThrow(
    /already expired/,
  );
  expect(() =>
    assertDisposableBranch({ ...branch, expires_at: new Date(now + MAX_ACCEPTANCE_TTL_MS + 1).toISOString() }, now),
  ).toThrow(/7 days/);
  expect(() => assertDisposableBranch({ ...branch, name: "main" }, now)).toThrow(/kello-acceptance-/);
  expect(() => assertDisposableBranch({ ...branch, protected: true }, now)).toThrow();
  expect(() => assertAcceptanceBranch({ name: "kello-acceptance-x", default: true })).toThrow();
  expect(() => assertAcceptanceBranch({ name: "kello-acceptance-x", expires_at: null })).not.toThrow();
});

test("created branches get a bounded expiry", () => {
  expect(acceptanceExpiry(now)).toBe("2026-11-23T00:00:00.000Z");
  expect(() => acceptanceExpiry(now, MAX_ACCEPTANCE_TTL_MS + 1)).toThrow();
  expect(() => acceptanceExpiry(now, 0)).toThrow();
});

test("teardown names are strictly validated before any SQL is produced", () => {
  expect(acceptanceSchemasForRole(role)).toEqual([`accept_${hex}`, `kello_accept_${hex}`]);
  expect(() => acceptanceSchemasForRole("neondb_owner")).toThrow();
  expect(() => planTeardown({ schemas: ["public"] })).toThrow();
  expect(() => planTeardown({ schemas: [`accept_${hex}"; DROP SCHEMA public; --`] })).toThrow();
  expect(() => planTeardown({ roles: ["neondb_owner"] })).toThrow();
  expect(() => planTeardown({ roles: [`runtime_${hex.toUpperCase()}`] })).toThrow();
  expect(() => planTeardown({ functions: ["Bad-Slug"] })).toThrow();
  expect(planTeardown({ functions: ["svc", "svc"] }).functions).toEqual(["svc"]);
});

test("teardown drops schemas before reassigning, dropping owned objects and the role", () => {
  expect(teardownStatements({ functions: ["svc"], schemas: acceptanceSchemasForRole(role), roles: [role] })).toEqual([
    `DROP SCHEMA IF EXISTS "accept_${hex}" CASCADE`,
    `DROP SCHEMA IF EXISTS "kello_accept_${hex}" CASCADE`,
    `REASSIGN OWNED BY "${role}" TO CURRENT_USER`,
    `DROP OWNED BY "${role}"`,
    `DROP ROLE "${role}"`,
  ]);
  expect(quoteIdentifier('a"b')).toBe('"a""b"');
});

test("cleanup selects only acceptance leftovers and honours kept functions", () => {
  expect(
    selectLeftovers({
      schemas: ["public", "kello_meta", `accept_${hex}`, `kello_accept_${hex}`, "accept_short"],
      roles: ["neondb_owner", "authenticator", role, "runtime_x"],
      functions: ["svc", "wrk", "kelloissuer"],
      keepFunctions: ["kelloissuer"],
    }),
  ).toEqual({ schemas: [`accept_${hex}`, `kello_accept_${hex}`], roles: [role], functions: ["svc", "wrk"] });
});

test("error text is redacted before it reaches CI output", () => {
  const message = redact(
    "failed postgresql://u:p@ep-x.neon.tech/db?sslmode=verify-full password=hunter2 a@b.co napi_abc123",
  );
  expect(message).not.toMatch(/hunter2|u:p@|a@b\.co|napi_abc123/);
});
