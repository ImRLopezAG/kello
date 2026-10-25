import { join } from "node:path";
import { writeFile } from "node:fs/promises";

/** Runs the generated HTTP client and native cache lifecycle from the installed tarball. */
export async function writePackedSearchSSR(root: string) {
  await writeFile(
    join(root, "ssr.mjs"),
    `import assert from "node:assert/strict";
import { os } from "@orpc/server";
import { createRpcHttpApp } from "kello/neon";
import { createProjectContext } from "kello/server";
import { withKelloServerSession } from "kello/client";
import { QueryClient, QueryClientProvider, useQuery, hydrate, hashKey } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { RPCJsonSerializer } from "@orpc/client";
const serializer = new RPCJsonSerializer();
function decodeHydration(state, prefix) { const value = serializer.deserializeJson(JSON.parse(state)); assert(value.queries.every(query => query.queryKey[0] === prefix && query.queryHash === hashKey(query.queryKey))); return value; }
import { createServerClient, version } from "./app/kello/_generated/api";
import { searchSchema, searchRelations } from "./app/kello/fixture";
const { validators } = createProjectContext(searchSchema, searchRelations);
const policy = { scope: "public", columns: ["title", "done", "at", "count", "amount"], through: { taskLabels: "public" }, relations: { labels: { scope: "public", columns: ["name"] } } };
const finite = validators.tables.tasks.search(policy);
let reads = 0;
const router = { tasks: {
 list: os.input(finite.input).output(finite.output).handler(async ({ context, input }) => {
  reads++; await new Promise(resolve => setTimeout(resolve, context.identity.subject === "alice" ? 30 : 10));
  const fields = { title: context.identity.subject, done: false, at: new Date("2026-01-01"), count: 9007199254740993n, amount: "1.0001" };
  const row = Object.fromEntries(Object.entries(fields).filter(([key]) => input.columns?.[key] === true));
  if (input.with?.labels) row.labels = [{ name: context.identity.subject }];
  return { rows: [row], nextCursor: null, previousCursor: null };
 }),
} };
const app = createRpcHttpApp({ router, version, origins: [], verify: async token => ({ identity: { issuer: "test", subject: token }, expiresAt: Date.now() / 1000 + 3600 }) });
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
const input = { columns: { title: true, at: true, count: true }, with: { labels: { columns: { name: true } } }, limit: 2 };
async function request(subject) {
 return withKelloServerSession(createServerClient, { url: server.url.origin, getToken: async () => subject }, async ({ connection, queryClient, dehydrate }) => {
  const page = await queryClient.query(connection.rpc.tasks.list.queryOptions({ input }));
  function SearchPanel() {
   const result = useQuery(connection.rpc.tasks.list.queryOptions({ input }));
   return createElement("p", null, result.data?.rows[0]?.title ?? "Pending");
  }
  const markup = renderToString(createElement(QueryClientProvider, { client: queryClient }, createElement(SearchPanel)));
  assert(markup.includes(subject));
  return { page, hydration: dehydrate() };
 });
}
try {
 const [alice, bob] = await Promise.all([request("alice"), request("bob")]);
 assert(alice && bob); assert.equal(reads, 2);
 assert.notEqual(alice.hydration.cachePrefix, bob.hydration.cachePrefix); assert.notEqual(alice.hydration.session.key, bob.hydration.session.key);
 for (const [subject, result] of [["alice", alice], ["bob", bob]]) {
  assert.deepEqual(result.page.rows, [{ title: subject, at: new Date("2026-01-01"), count: 9007199254740993n, labels: [{ name: subject }] }]);
  const state = decodeHydration(result.hydration.state, result.hydration.cachePrefix);
  const browser = new QueryClient(); hydrate(browser, state);
  const value = browser.getQueryData(state.queries[0].queryKey);
  assert.deepEqual(value, result.page); assert.equal(Object.hasOwn(value.rows[0], "done"), false);
  assert.throws(() => decodeHydration(result.hydration.state, subject === "alice" ? bob.hydration.cachePrefix : alice.hydration.cachePrefix));
  browser.clear();
 }
 assert.equal(await request(null), null); assert.equal(reads, 2);
 console.info("Packed concurrent finite SSR search and native hydration passed");
} finally { await server.stop(true); }
`,
  );
}
