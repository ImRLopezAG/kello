import assert from "node:assert/strict";
import { test, expect } from "bun:test";
import { Effect, Layer } from "effect";
import { defineRelations, sql } from "drizzle-orm";
import { connectDatabase, createEffectRuntime, defineSchema, runFunctionTransaction } from "kello/server";

const connectionString = process.env.KELLO_TEST_DATABASE_URL;
test.skipIf(!connectionString)("interruption drains PostgreSQL work before releasing its client", async () => {
  const schema = defineSchema(() => ({}));
  const connection = await connectDatabase({
    schema,
    relations: defineRelations(schema.tables),
    connectionString: connectionString!,
  });
  const runtime = createEffectRuntime(Layer.empty);
  const abort = new AbortController();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  try {
    const work = runtime.promise(
      { identity: null, requestId: "cancel-query" },
      async ({ signal }) =>
        runFunctionTransaction(
          connection,
          "query",
          async (tx) => {
            const query = tx.execute(sql`SELECT pg_sleep(0.1)`);
            const running = query.then(() => undefined);
            started();
            await running;
            return 1;
          },
          { signal },
        ),
      abort.signal,
    );
    const outcome = work.then(
      () => "unexpected success",
      () => "interrupted",
    );
    await ready;
    abort.abort();
    expect(connection.pool.idleCount).toBe(0);
    expect(await outcome).toBe("interrupted");
    expect(connection.pool.idleCount).toBe(connection.pool.totalCount);
    const escaped = await runtime.promise({ identity: null, requestId: "escaped" }, () =>
      runFunctionTransaction(connection, "query", async (tx) => () => tx.execute(sql`SELECT 1`)),
    );
    await assert.rejects(Promise.resolve(escaped()), /Database invocation is inactive/);
    expect(await runtime.run({ identity: null, requestId: "healthy" }, Effect.succeed(true))).toBe(true);
  } finally {
    await runtime.stop();
    await connection.close();
  }
});
