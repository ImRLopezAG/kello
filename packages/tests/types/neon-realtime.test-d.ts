import * as v from "valibot";
import { pgTable, text } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/node-postgres";
import { createNeonLiveQuery, createNeonQueryIssuer } from "kello/server";
import type { NeonAuthority } from "kello/server";
import type { IssuedNeonQuery } from "kello/client";
const tasks = pgTable("tasks", { id: text().notNull() });
const db = drizzle.mock();
const query = createNeonLiveQuery({
  name: "typed",
  input: v.strictObject({ tenant: v.string() }),
  rows: v.array(v.strictObject({ id: v.string() })),
  authorize: (_authority, input) => {
    const tenant: string = input.tenant;
    void tenant;
  },
  query: () => db.select({ id: tasks.id }).from(tasks),
});
declare const authority: NeonAuthority;
declare const issuer: ReturnType<typeof createNeonQueryIssuer>;
const output: Promise<IssuedNeonQuery<{ id: string }>> = issuer.issue(query, { tenant: "tenant" }, authority);
void output;
createNeonLiveQuery({
  name: "bad",
  input: v.object({}),
  // @ts-expect-error Runtime decoder cannot contradict the selected Drizzle row.
  rows: v.array(v.object({ id: v.number() })),
  authorize: () => {},
  query: () => db.select({ id: tasks.id }).from(tasks),
});
// @ts-expect-error A normal invocation context has no trusted login-generation authority.
const missing: NeonAuthority = { identity: null, signal: new AbortController().signal, requestId: "client-label" };
void missing;
