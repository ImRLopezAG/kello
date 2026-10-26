import { expect, test } from "vite-plus/test";
import { createBackfillPlan } from "kello-cli";

const input = {
  name: "titles",
  namespace: "app",
  table: "tasks",
  migrationHash: "a".repeat(64),
  batchSize: 100,
  sql: 'UPDATE app.tasks SET title=upper(title) WHERE "_id"=ANY($1::uuid[]) RETURNING "_id"',
};

test("backfill identity binds the reviewed operation, migration head and batch contract", async () => {
  const first = await createBackfillPlan(input);
  expect(await createBackfillPlan({ ...input })).toEqual(first);
  for (const change of [
    { batchSize: 1 },
    { migrationHash: "b".repeat(64) },
    { sql: input.sql + " /* reviewed change */" },
    { name: "other" },
  ])
    expect((await createBackfillPlan({ ...input, ...change })).hash).not.toBe(first.hash);
});

test("backfill plans refuse transaction control, multiple writes, wrong targets and system field writes", async () => {
  for (const sql of [
    "BEGIN",
    `${input.sql}; ${input.sql}`,
    'UPDATE other.tasks SET title=upper(title) WHERE "_id"=ANY($1::uuid[]) RETURNING "_id"',
    'UPDATE app.tasks SET "_id"=gen_random_uuid() WHERE "_id"=ANY($1::uuid[]) RETURNING "_id"',
    'UPDATE app.tasks SET "_createdAt"=0 WHERE "_id"=ANY($1::uuid[]) RETURNING "_id"',
    "UPDATE app.tasks SET title=upper(title)",
    `WITH removed AS (DELETE FROM app.tasks RETURNING "_id") ${input.sql}`,
  ])
    await expect(createBackfillPlan({ ...input, sql })).rejects.toThrow(/Backfill requires/);
  for (const batchSize of [0, -1, 0.5, 10001, Infinity])
    await expect(createBackfillPlan({ ...input, batchSize })).rejects.toThrow();
});
