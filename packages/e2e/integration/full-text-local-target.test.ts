import assert from "node:assert/strict";
import { test } from "bun:test";
import { fullTextLocalTarget } from "./full-text-local-target";

test("full-text fixture guard rejects alternate targets and driver routing overrides without exposing credentials", () => {
  const local = "postgresql://postgres:fixture-only-password@127.0.0.1:55432/kello_test";
  assert.equal(fullTextLocalTarget(local), local);
  for (const invalid of [
    undefined,
    "not a URL",
    local.replace("127.0.0.1", "remote.example.test"),
    local.replace("55432", "5432"),
    local.replace("kello_test", "production"),
    local.replace("postgres:", "other:"),
    local.replace(":fixture-only-password", ""),
    ...[
      "host=remote.example.test",
      "port=5432",
      "user=other",
      "password=override",
      "dbname=production",
      "sslmode=require",
    ].map((query) => `${local}?${query}`),
    `${local}#fragment`,
  ]) {
    assert.throws(() => fullTextLocalTarget(invalid), {
      message:
        /^(A valid shared local full-text test URL is required|Full-text tests require the shared local PG18 target without URI overrides)$/,
    });
  }
});
