import assert from "node:assert/strict";
import { test } from "node:test";
import { and, count, eq, getTableColumns, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { boolean, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { drizzleAdapter } from "@neon/realtime-drizzle";
import { drizzleParsers } from "@neon/realtime-drizzle/client";
import { pgTypeOids } from "@neon/realtime/client";
import { createRealtime } from "@neon/realtime/server";

const messages = pgTable("messages", {
  id: integer().primaryKey(),
  channel_id: integer().notNull(),
  body: text().notNull(),
  published: boolean().notNull(),
  created_at: timestamp({ mode: "date" }).notNull(),
  tags: text().array(),
  ids: integer().array(),
  metadata: jsonb().$type<{ label: string }>(),
});
const memberships = pgTable("memberships", {
  channel_id: integer().notNull(),
  user_id: text().notNull(),
});
const db = drizzle.mock();
const adapter = drizzleAdapter();

test("RC.5 typed select and membership join retain SQL binding and tenant value", () => {
  const subject = "member-' OR true --";
  const query = db
    .select(getTableColumns(messages))
    .from(messages)
    .innerJoin(memberships, eq(memberships.channel_id, messages.channel_id))
    .where(and(eq(memberships.user_id, subject), eq(messages.channel_id, 42)))
    .orderBy(messages.id)
    .limit(50);
  const prepared = adapter.prepare(query);
  assert.equal(prepared.sql, query.toSQL().sql);
  assert.equal(prepared.sql.includes(subject), false);
  assert.deepEqual(prepared.parameters, [
    { typeOid: 0, value: subject },
    { typeOid: 0, value: "42" },
    { typeOid: 0, value: "50" },
  ]);
});

test("RC.5 column encoders prepare Date, JSON and boolean parameters before Neon encoding", () => {
  const when = new Date("2026-10-15T12:00:00Z");
  const query = db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.created_at, when), eq(messages.metadata, { label: "hello" }), eq(messages.published, true)));
  assert.deepEqual(adapter.prepare(query).parameters, [
    { typeOid: 0, value: "2026-10-15T12:00:00.000Z" },
    { typeOid: 0, value: '{"label":"hello"}' },
    { typeOid: 0, value: "true" },
  ]);
});

test("RC.5 default flat selection is accepted", () => {
  assert.match(adapter.prepare(db.select().from(messages)).sql, /^select /);
});

test("RC.5 explicit aliases support renamed properties and aggregate SQL", () => {
  const query = db
    .select({
      channelId: sql<number>`${messages.channel_id}`.as("channelId"),
      total: count().as("total"),
    })
    .from(messages)
    .groupBy(messages.channel_id);
  assert.match(adapter.prepare(query).sql, /as "channelId"/);
  assert.match(adapter.prepare(query).sql, /as "total"/);
});

test("unaliased renamed fields remain rejected rather than silently claiming the wrong row shape", () => {
  const query = db.select({ channelId: messages.channel_id }).from(messages);
  assert.throws(() => adapter.prepare(query), /explicit SQL alias matching the selection key/);
});

test("nested join result shapes remain explicitly unsupported", () => {
  const query = db.select({ message: getTableColumns(messages) }).from(messages);
  assert.throws(() => adapter.prepare(query), /cannot determine the PostgreSQL result name/);
});

test("unbound placeholders remain rejected, not stringified into a sealed parameter", () => {
  const query = db
    .select({ id: messages.id })
    .from(messages)
    .where(eq(messages.id, sql.placeholder("id")));
  assert.throws(() => adapter.prepare(query), /parameter that cannot be encoded/);
});

test("SDK seal preserves RC.5 inferred row type without casts or rawSql", async () => {
  // Disposable, generated test key: never a provider-issued project credential.
  const secret = `nrt_live_1${Buffer.alloc(32, 7).toString("base64url")}`;
  const realtime = createRealtime({ secret, db: "fixture", adapter });
  const query = db.select({ id: messages.id, body: messages.body }).from(messages);
  const sealed = await realtime.seal({ query });
  type Row = NonNullable<typeof sealed.__row>["__type"];
  type Exact = Row extends { id: number; body: string }
    ? { id: number; body: string } extends Row
      ? true
      : false
    : false;
  const exact: Exact = true;
  assert.equal(exact, true);
  assert.equal(sealed.capability.split(".").length, 5);
  const row: Row = { id: 1, body: "hello" };
  // @ts-expect-error RC.5 number inference must not become unknown/any.
  const invalidRow: Row = { id: "wrong", body: "hello" };
  assert.equal(row.id, 1);
  void invalidRow;
});

test("Drizzle-compatible timestamp parser retains UTC Date semantics", () => {
  const parse = drizzleParsers[pgTypeOids.timestamp];
  assert(parse);
  assert.deepEqual(parse("2026-10-15 12:00:00.123456"), new Date("2026-10-15T12:00:00.123Z"));
  assert.throws(() => parse("2026-02-30 00:00:00"), /Invalid PostgreSQL timestamp/);
});

test("RC.5 native arrays retain PostgreSQL escaping and NULL semantics", () => {
  const query = db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.tags, ["a,b", 'a"b', "a\\b", "NULL", ""]), eq(messages.ids, [1, 2])));
  assert.deepEqual(adapter.prepare(query).parameters, [
    { typeOid: 0, value: '{"a,b","a\\"b","a\\\\b","NULL",""}' },
    { typeOid: 0, value: "{1,2}" },
  ]);
  const nested = db
    .select({ id: messages.id })
    .from(messages)
    .where(
      sql`${sql.param([
        [1, null],
        [2, 3],
      ])}::integer[][] is not null`,
    );
  assert.equal(adapter.prepare(nested).parameters[0]?.value, "{{1,NULL},{2,3}}");
});

test("RC.5 JSON arrays use their column encoder, not SQL array encoding", () => {
  const table = pgTable("json_values", { value: jsonb() });
  const query = db
    .select({ value: table.value })
    .from(table)
    .where(eq(table.value, [1, { a: true }]));
  assert.equal(adapter.prepare(query).parameters[0]?.value, '[1,{"a":true}]');
});

test("unsupported array objects and cyclic JSON fail before sealing", () => {
  const base = db.select({ id: messages.id }).from(messages);
  assert.throws(
    () => adapter.prepare(base.where(sql`${sql.param([new Date()])}::text[] is not null`)),
    /unsupported PostgreSQL array element/,
  );
  interface Cycle {
    self?: Cycle;
  }
  const cycle: Cycle = {};
  cycle.self = cycle;
  assert.throws(() => adapter.prepare(base.where(sql`${cycle}::jsonb is not null`)), /circular|cyclic/i);
});
