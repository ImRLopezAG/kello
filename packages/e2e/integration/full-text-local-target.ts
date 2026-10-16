import assert from "node:assert/strict";

/** This fixture target is coordinator-owned; query parameters can override pg's URI authority. */
export function fullTextLocalTarget(value: string | undefined): string {
  assert(value && URL.canParse(value), "A valid shared local full-text test URL is required");
  const address = new URL(value);
  assert(
    address.protocol === "postgresql:" &&
      address.hostname === "127.0.0.1" &&
      address.port === "55432" &&
      address.pathname === "/kello_test" &&
      address.username === "postgres" &&
      address.password.length > 0 &&
      !address.search &&
      !address.hash,
    "Full-text tests require the shared local PG18 target without URI overrides",
  );
  return value;
}
