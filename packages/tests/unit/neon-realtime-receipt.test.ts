import { expect, test } from "vite-plus/test";
import * as v from "valibot";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL, AnyRelations } from "drizzle-orm";
import type { DatabaseConnection } from "../../../apps/loom/src/core/server/database/connection";
import { runNeonMutation } from "../../../apps/loom/src/core/server/realtime/neon";

// DB-free transaction boundary double; exercises real replay/serialization and
// wrapper control flow. Native PostgreSQL atomicity is a separate required gate.
function fixture(failCommit = false) {
  let durable: { fingerprint: unknown; result: unknown } | undefined;
  let writes = 0;
  let attempts = 0;
  let authorizations = 0;
  const dialect = new PgDialect();
  const boundary = {
    async transaction<Result>(
      operation: (db: { execute: (query: SQL) => Promise<{ rows: object[] }> }) => Promise<Result>,
    ) {
      attempts++;
      let pending = durable;
      const tx = {
        async execute(query: SQL) {
          const compiled = dialect.sqlToQuery(query);
          if (compiled.sql.includes("SELECT fingerprint"))
            return {
              rows:
                pending === undefined
                  ? []
                  : [{ fingerprint: pending.fingerprint, result: pending.result, expired: false }],
            };
          if (compiled.sql.includes("INSERT INTO")) {
            pending = { fingerprint: compiled.params[2], result: JSON.parse(String(compiled.params[3])) };
            return { rows: [{ scope_hash: "saved" }] };
          }
          if (compiled.sql.includes("pg_current_xact_id")) return { rows: [{ txid: String(100 + attempts) }] };
          throw new Error("Unexpected SQL");
        },
      };
      const value = await operation(tx);
      if (failCommit) throw new Error("Commit failed");
      durable = pending;
      return value;
    },
  };
  // SAFETY: This DB-free boundary implements only transaction/execute, the sole
  // methods used by this wrapper. It is not native database acceptance evidence.
  const connection = boundary as DatabaseConnection<AnyRelations>;
  const options = {
    connection,
    secret: "test-secret",
    database: "db",
    deployment: "deployment",
    metadataNamespace: "loom_test",
    operation: "tasks.update.v1",
    idempotencyKey: "request1",
    input: { id: "1", title: "next" },
    authority: {
      identity: { issuer: "issuer", subject: "user", tenantId: "tenant" },
      sessionId: "session",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      signal: new AbortController().signal,
    },
    output: v.object({ title: v.string() }),
    authorize: async () => {
      authorizations++;
    },
    execute: async () => {
      writes++;
      return { kind: "write" as const, value: { title: "next" } };
    },
  };
  return {
    options,
    get durable() {
      return durable;
    },
    get writes() {
      return writes;
    },
    get attempts() {
      return attempts;
    },
    get authorizations() {
      return authorizations;
    },
  };
}
test("receipt is inside persisted replay output; replay reauthorizes without executing", async () => {
  const f = fixture();
  const first = await runNeonMutation(f.options);
  expect(first.transaction).toEqual({ kind: "committed", txid: "101" });
  expect(await runNeonMutation(f.options)).toEqual(first);
  expect(f.writes).toBe(1);
  expect(f.authorizations).toBe(2);
  expect(f.durable).toBeDefined();
});
test("commit failure cannot expose a receipt or durable replay", async () => {
  const f = fixture(true);
  await expect(runNeonMutation(f.options)).rejects.toThrow("Commit failed");
  expect(f.durable).toBeUndefined();
});
test("invalid output rolls back replay and invalid operation version performs no work", async () => {
  const f = fixture();
  await expect(
    runNeonMutation({ ...f.options, output: v.object({ title: v.literal("different") }) }),
  ).rejects.toThrow();
  expect(f.durable).toBeUndefined();
  await expect(runNeonMutation({ ...f.options, operation: "tasks.update" })).rejects.toThrow("Versioned");
  expect(f.attempts).toBe(1);
});
test("no-write is explicit; retry throws away the failed attempt's transaction receipt", async () => {
  const f = fixture();
  const unchanged = await runNeonMutation({
    ...f.options,
    execute: async () => ({ kind: "no-write", value: { title: "next" } }),
  });
  expect(unchanged.transaction).toEqual({ kind: "no-write" });
  const retry = fixture();
  let executions = 0;
  const saved = await runNeonMutation({
    ...retry.options,
    execute: async () => {
      executions++;
      if (executions === 1) throw Object.assign(new Error("serialization"), { code: "40001" });
      return { kind: "write", value: { title: "next" } };
    },
  });
  expect(saved.transaction).toEqual({ kind: "committed", txid: "102" });
  expect(retry.authorizations).toBe(2);
});

test("expired authority and transforming output cannot commit a replay receipt", async () => {
  const f = fixture();
  await expect(runNeonMutation({ ...f.options, authority: { ...f.options.authority, expiresAt: 1 } })).rejects.toThrow(
    "UNAUTHORIZED",
  );
  expect(f.attempts).toBe(0);
  await expect(
    runNeonMutation({
      ...f.options,
      output: v.pipe(
        v.object({ title: v.string() }),
        v.transform(() => ({ title: "transformed" })),
      ),
    }),
  ).rejects.toThrow("without transforming");
  expect(f.durable).toBeUndefined();
});

test("signing-key rotation replays the original committed envelope without executing again", async () => {
  const f = fixture();
  const original = await runNeonMutation(f.options);
  const replay = await runNeonMutation({ ...f.options, secret: "rotated-secret" });
  expect(replay).toEqual(original);
  expect(f.writes).toBe(1);
  expect(f.authorizations).toBe(2);
});
