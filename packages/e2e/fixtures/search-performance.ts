import assert from "node:assert/strict";
import type * as pg from "./postgres";
import type { JsonValue } from "kello/server";
import * as v from "valibot";

const page = v.object({
  rows: v.array(
    v.object({
      title: v.string(),
      labels: v.optional(v.array(v.object({ name: v.string() }))),
      project: v.optional(
        v.object({
          organization: v.object({ teams: v.array(v.object({ members: v.array(v.object({ name: v.string() })) })) }),
        }),
      ),
    }),
  ),
  count: v.optional(v.string()),
});

/** Representative hosted work, measured without declaring an unmeasured speed gain. */
export async function measureSearchPerformance(options: {
  admin: pg.Client;
  namespace: string;
  projectId: string;
  request: (input: Readonly<Record<string, JsonValue>>) => Promise<Response>;
}) {
  const { admin, namespace, projectId, request } = options;
  assert.match(namespace, /^search_[a-f0-9]{32}$/);
  await admin.query(`INSERT INTO "${namespace}".permissions(subject,allowed) VALUES ('performance',true)`);
  await admin.query(
    `INSERT INTO "${namespace}".tasks(owner,title,done,project_id,at,count,amount)
    SELECT 'performance','perf-' || lpad(n::text,5,'0'),false,$1,'2026-01-01',n,'1.0001' FROM generate_series(1,2000) n`,
    [projectId],
  );
  await admin.query(`INSERT INTO "${namespace}".labels(name) SELECT 'perf-label-' || n FROM generate_series(1,12) n`);
  await admin.query(`INSERT INTO "${namespace}".task_labels(task_id,label_id)
    SELECT t._id,l._id FROM "${namespace}".tasks t CROSS JOIN "${namespace}".labels l
    WHERE t.owner='performance' AND l.name LIKE 'perf-label-%'`);
  await admin.query(`ANALYZE "${namespace}".tasks; ANALYZE "${namespace}".task_labels; ANALYZE "${namespace}".labels`);
  const workloads = [
    {
      name: "indexed roots",
      input: { columns: { title: true }, limit: 50, orderBy: [{ field: "title", direction: "asc" }] },
    },
    { name: "exact count", input: { columns: { title: true }, count: true, limit: 50 } },
    {
      name: "M2M fanout",
      input: { columns: { title: true }, with: { labels: { columns: { name: true } } }, limit: 50 },
    },
    {
      name: "four relation edges",
      input: {
        columns: { title: true },
        with: {
          project: {
            columns: { name: true },
            with: {
              organization: {
                columns: { name: true },
                with: { teams: { columns: { name: true }, with: { members: { columns: { name: true } } } } },
              },
            },
          },
        },
        limit: 50,
      },
    },
  ] as const;
  const measurements = [];
  for (const workload of workloads) {
    const milliseconds = [];
    for (let iteration = 0; iteration < 3; iteration++) {
      const started = performance.now();
      const response = await request(workload.input);
      assert.equal(response.status, 200, workload.name);
      const value = v.parse(page, await response.json());
      milliseconds.push(performance.now() - started);
      assert.equal(value.rows.length, 50);
      if (workload.name === "exact count") assert.equal(value.count, "2000");
      if (workload.name === "M2M fanout") for (const row of value.rows) assert.equal(row.labels?.length, 12);
      if (workload.name === "four relation edges")
        for (const row of value.rows) assert.equal(row.project?.organization.teams[0]?.members[0]?.name, "member");
    }
    measurements.push({ workload: workload.name, milliseconds });
  }
  // These oracle plans describe indexed root/count/junction access, not the full Drizzle-generated projection SQL.
  const statements = [
    `SELECT title FROM "${namespace}".tasks WHERE owner='performance' ORDER BY title,_id LIMIT 51`,
    `SELECT count(*) FROM "${namespace}".tasks WHERE owner='performance'`,
    `SELECT l.name FROM "${namespace}".task_labels j JOIN "${namespace}".labels l ON l._id=j.label_id WHERE j.task_id=(SELECT _id FROM "${namespace}".tasks WHERE owner='performance' LIMIT 1)`,
  ];
  const plans = [];
  for (const statement of statements)
    plans.push((await admin.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement}`)).rows);
  return { roots: 2000, labelsPerRoot: 12, junctionRows: 24000, measurements, plans };
}
