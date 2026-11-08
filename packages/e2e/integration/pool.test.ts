import assert from "node:assert/strict";
import { channel } from "node:diagnostics_channel";
import { setTimeout } from "node:timers/promises";
import { expect, test } from "bun:test";
import { connectDatabase, defineSchema, runFunctionTransaction } from "kello/server";
import { defineRelations, sql } from "drizzle-orm";
import * as v from "valibot";

const connectionString = process.env.KELLO_TEST_DATABASE_URL;
test.skipIf(!connectionString)("pool measures acquisition separately from query execution", async () => {
  if (!connectionString) throw new Error("Missing database URL");
  const schema = defineSchema(() => ({}));
  const connection = await connectDatabase({
    connectionString,
    schema,
    relations: defineRelations(schema.tables),
    maxConnections: 1,
  });
  const metricSchema = v.strictObject({
    type: v.literal("database.acquire"),
    status: v.picklist(["success", "error"]),
    durationMs: v.pipe(v.number(), v.finite(), v.minValue(0)),
    total: v.pipe(v.number(), v.integer(), v.minValue(0)),
    idle: v.pipe(v.number(), v.integer(), v.minValue(0)),
    waiting: v.pipe(v.number(), v.integer(), v.minValue(0)),
  });
  const metrics: v.InferOutput<typeof metricSchema>[] = [];
  const events = channel("kello.runtime.metric");
  const capture: Parameters<typeof events.subscribe>[0] = (event) => {
    if (v.parse(v.object({ type: v.string() }), event).type === "database.acquire") {
      metrics.push(v.parse(metricSchema, event));
    }
  };
  events.subscribe(capture);
  try {
    const held = await connection.pool.connect();
    const acquired = await (async () => {
      try {
        expect(metrics).toHaveLength(1);
        expect(metrics[0]).toMatchObject({ status: "success", total: 1, idle: 0, waiting: 0 });
        const pending = connection.pool.connect();
        await setTimeout(25);
        return pending;
      } finally {
        held.release();
      }
    })();
    try {
      expect(metrics).toHaveLength(2);
      expect(metrics[1]?.durationMs).toBeGreaterThanOrEqual(20);
    } finally {
      acquired.release();
    }
    await connection.db.execute(sql`SELECT 1`);
    expect(metrics).toHaveLength(3);
    await runFunctionTransaction(connection, "query", async (tx) => {
      expect(metrics).toHaveLength(4);
      await tx.execute(sql`SELECT pg_sleep(0.025)`);
      expect(metrics).toHaveLength(4);
    });
    await connection.close();
    await assert.rejects(connection.pool.connect(), /end/);
    expect(metrics).toHaveLength(5);
    expect(metrics.at(-1)?.status).toBe("error");
    await assert.rejects(connection.pool.query("SELECT 1"), /end/);
    expect(metrics).toHaveLength(6);
    expect(metrics.at(-1)?.status).toBe("error");
  } finally {
    events.unsubscribe(capture);
    if (!connection.pool.ending) await connection.close();
  }
});
