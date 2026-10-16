import assert from "node:assert/strict";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** A packed public consumer with an authored four-edge graph and explicit streaming contract. */
export async function prepareCloudSearch(root: string, namespace: string) {
  await mkdir(join(root, "node_modules/kello"), { recursive: true });
  const archive = join(root, "kello.tgz");
  const packed = Bun.spawnSync(["bun", "pm", "pack", "--filename", archive, "--ignore-scripts"], {
    cwd: fileURLToPath(new URL("../../../apps/loom/", import.meta.url)),
    stdout: "pipe",
    stderr: "pipe",
  });
  assert.equal(packed.exitCode, 0, "Public package archive failed");
  const unpacked = Bun.spawnSync(
    ["tar", "-xzf", archive, "--strip-components=1", "-C", join(root, "node_modules/kello")],
    { stdout: "pipe", stderr: "pipe" },
  );
  assert.equal(unpacked.exitCode, 0, "Public package extraction failed");
  await symlink(
    fileURLToPath(new URL("../../../apps/loom/node_modules/", import.meta.url)),
    join(root, "node_modules/kello/node_modules"),
  );
  for (const name of ["valibot", "effect", "drizzle-orm"])
    await symlink(
      fileURLToPath(new URL(`../../tests/node_modules/${name}`, import.meta.url)),
      join(root, "node_modules", name),
    );
  await mkdir(join(root, "node_modules/@orpc"));
  await symlink(
    fileURLToPath(new URL("../node_modules/@orpc/server", import.meta.url)),
    join(root, "node_modules/@orpc/server"),
  );
  await writeFile(join(root, "package.json"), JSON.stringify({ private: true, type: "module" }));
  const backend = join(root, "kello");
  for (const path of ["contracts", "functions"]) await mkdir(join(backend, path), { recursive: true });
  const fixture = await readFile(new URL("../../tests/fixtures/search-schema.ts", import.meta.url), "utf8");
  await writeFile(
    join(backend, "schema.ts"),
    'import { defineSchema, defineTable } from "kello/server";\n' +
      fixture
        .slice(fixture.indexOf("export const searchSchema"), fixture.indexOf("export const searchRelations"))
        .replace("export const searchSchema =", "export default")
        .replace("title: s.text().notNull(),", "owner: s.text().notNull(), title: s.text().notNull(),")
        .replace(
          "taskLabels: defineTable",
          "permissions: defineTable({ subject: s.text().notNull(), allowed: s.boolean().notNull() }), declaredPolicyPermissions: defineTable({ subject: s.text().notNull(), allowed: s.boolean().notNull() }), unrelated: defineTable({ title: s.text().notNull() }), taskLabels: defineTable",
        )
        .replace('namespace: "app"', `namespace: "${namespace}"`),
  );
  await writeFile(join(backend, "acceptance-metrics-schema.ts"), searchAcceptanceMetricsSchema);
  await writeFile(join(backend, "acceptance-metrics.ts"), searchAcceptanceMetrics);
  await writeFile(
    join(backend, "relations.ts"),
    'import schema from "./schema"; import { defineRelations } from "drizzle-orm";\n' +
      fixture
        .slice(fixture.indexOf("export const searchRelations"), fixture.indexOf("export const titleSelection"))
        .replace("export const searchRelations =", "export default")
        .replace("searchSchema.tables", "schema.tables"),
  );
  await writeFile(
    join(backend, "app.config.ts"),
    'import { defineApplication } from "kello"; export default defineApplication({ rpc: ({ os }) => ({ os }) });',
  );
  await writeFile(
    join(backend, "auth.config.ts"),
    `import { defineRpcAuth } from "kello/server";
import { ORPCError } from "@orpc/server";
import { sql } from "drizzle-orm";
export default defineRpcAuth({ dependencies: ["permissions"], authorize: async ({ identity, db, path }) => {
  if (!identity) throw new ORPCError("UNAUTHORIZED");
  // Fixture diagnostics remain readable after revocation, on the same authenticated peer.
  if (path[0] === "tasks" && (path[1] === "metrics" || path[1] === "barrier")) return;
  if (db) {
    const result = await db.execute<{ allowed: boolean }>(sql\`SELECT allowed FROM "${namespace}".permissions WHERE subject=\${identity.subject}\`);
    if (result.rows[0]?.allowed !== true) throw new ORPCError("FORBIDDEN");
  }
} });`,
  );
  await writeFile(
    join(backend, "contracts/tasks.ts"),
    `import { defineContract, oc } from "kello/contract";
import { searchErrors } from "kello/contract";
import type { SearchPolicy } from "kello/server";
import relations from "../relations";
import { eq, sql } from "drizzle-orm";
import schema from "../schema";
import { readoutSchema, barrierInput } from "../acceptance-metrics-schema";
export default defineContract(({ validators }) => {
 const policy = {
  scope: { name: "owner", version: "1", dependencies: [], where: ({ table, identity }) => eq(table.owner, identity?.subject ?? "") },
  columns: ["title", "done", "at", "count", "amount"], filter: ["title", "done"], order: ["title", "at", "count"],
  through: { taskLabels: "public" },
  relations: {
   labels: { scope: "public", columns: ["name"], filter: ["name"] },
   project: { scope: "public", columns: ["name"], relations: {
    organization: { scope: "public", columns: ["name"], relations: {
     teams: { scope: "public", columns: ["name"], relations: { members: { scope: "public", columns: ["name"] } } },
    } },
   } },
  },
 } as const satisfies SearchPolicy<typeof relations, typeof relations.tasks>;
 const finite = validators.tables.tasks.search(policy);
 const live = validators.tables.tasks.liveSearch(policy);
 const policyLive = validators.tables.tasks.liveSearch({ ...policy, scope: {
  name: "permitted-owner", version: "1", dependencies: ["declaredPolicyPermissions"],
  where: ({ table, identity }) => sql\`\${table.owner} = \${identity?.subject ?? ""} AND EXISTS (
   SELECT 1 FROM \${schema.tables.declaredPolicyPermissions}
   WHERE \${schema.tables.declaredPolicyPermissions.subject} = \${identity?.subject ?? ""}
   AND \${schema.tables.declaredPolicyPermissions.allowed})\`,
 } });
 const rows = validators.tables.tasks.search({ ...policy, budgets: { rows: 2 } });
 const bytes = validators.tables.tasks.search({ ...policy, budgets: { resultBytes: 128 } });
 const base = oc.errors({ ...searchErrors, UNAUTHORIZED: {}, FORBIDDEN: {} });
 return {
  list: base.input(finite.input).output(finite.output),
  effectList: base.input(finite.input).output(finite.output),
  bad: base.input(finite.input).output(finite.output),
  watch: base.input(live.input).output(live.output),
  broadWatch: base.input(live.input).output(live.output),
  policyWatch: base.input(policyLive.input).output(policyLive.output),
  metrics: base.output(readoutSchema),
  barrier: base.input(barrierInput).output(readoutSchema),
  rows: base.input(rows.input).output(rows.output), bytes: base.input(bytes.input).output(bytes.output),
 };
});`,
  );
  await writeFile(
    join(backend, "functions/tasks.ts"),
    `import { os } from "../_generated/rpc";
import { Search } from "../_generated/server";
import { Effect } from "effect";
import { withLiveDependencies } from "kello/server";
import relations from "../relations";
import { evaluated, readMetrics, barrier } from "../acceptance-metrics";
const router = os.tasks.router({
 list: os.tasks.list.handler(({ context, input }) => context.search.tasks.paginate(input)),
 effectList: os.tasks.effectList.effect(function* ({ input }) { const search = yield* Search; return yield* Effect.promise(() => search.tasks.paginate(input)); }),
 bad: os.tasks.bad.handler(async ({ context, input }) => { const page = await context.search.tasks.paginate(input); return { ...page, rows: page.rows.map(row => ({ ...row, done: true })) }; }),
 watch: os.tasks.watch.handler(({ context, input }) => { if (context.operation === "live") evaluated("watch"); return context.search.tasks.watch(input); }),
 broadWatch: os.tasks.broadWatch.handler(({ context, input }) => { if (context.operation === "live") evaluated("broadWatch"); return context.search.tasks.watch(input); }),
 policyWatch: os.tasks.policyWatch.handler(({ context, input }) => { if (context.operation === "live") evaluated("policyWatch"); return context.search.tasks.watch(input); }),
 metrics: os.tasks.metrics.handler(() => readMetrics()),
 barrier: os.tasks.barrier.handler(({ input }) => barrier(input)),
 rows: os.tasks.rows.handler(({ context, input }) => context.search.tasks.paginate(input)),
 bytes: os.tasks.bytes.handler(({ context, input }) => context.search.tasks.paginate(input)),
});
// Native router construction clones leaves. Declare only the final routed procedures.
withLiveDependencies(relations, [], router.watch);
withLiveDependencies(relations, [], router.policyWatch);
export default router;`,
  );
}

// Authored only into this disposable consumer. No production runtime or shared
// metrics fixture is modified. The proof assumes exactly one coordinator and
// one application namespace in this generated service.
const searchAcceptanceMetricsSchema = `import * as v from "valibot";
const natural = v.pipe(v.number(), v.integer(), v.minValue(0));
export const readoutSchema = v.strictObject({
 instance: v.pipe(v.string(), v.uuid()), completedPolls: natural,
 subscriptions: natural, evaluating: natural, queued: natural,
 evaluations: v.strictObject({ watch: natural, broadWatch: natural, policyWatch: natural }),
});
export const barrierInput = v.strictObject({ instance: v.pipe(v.string(), v.uuid()), after: natural, expectedSubscriptions: v.literal(3) });
`;
const searchAcceptanceMetrics = `import { channel } from "node:diagnostics_channel";
import { randomUUID } from "node:crypto";
import * as v from "valibot";
import { barrierInput } from "./acceptance-metrics-schema";
import schema from "./schema";
const natural = v.pipe(v.number(), v.integer(), v.minValue(0));
const allTableCount = schema.metadata.entities.length;
const instance = randomUUID();
const evaluations = { watch: 0, broadWatch: 0, policyWatch: 0 };
let subscriptions = 0, evaluating = 0, queued = 0, completedPolls = 0;
let epoch = 0;
let cycle: { epoch: number } | undefined;
const waiters = new Set<() => void>();
export function evaluated(name: keyof typeof evaluations) { evaluations[name]++; }
export function readMetrics() { return { instance, completedPolls, subscriptions, evaluating, queued, evaluations: { ...evaluations } }; }
const metricSchema = v.variant("type", [
 v.object({ type: v.literal("revision.read"), status: v.picklist(["success", "error"]), tableCount: natural }),
 v.object({ type: v.literal("realtime.coordinator"), subscriptions: natural, evaluating: natural, queued: natural }),
]);
channel("kello.runtime.metric").subscribe(message => {
 const parsed = v.safeParse(metricSchema, message);
 if (!parsed.success) return;
 const metric = parsed.output;
 if (metric.type === "revision.read") {
  // Finite metrics/auth ingress performs no revision reads. Initial stream setup
  // has no snapshot collector. All broad snapshot reads happen with evaluating>0.
  // No other fixture procedure may read revisions while this barrier is armed.
  if (metric.status === "success" && metric.tableCount === allTableCount && subscriptions === 3 && evaluating === 0 && queued === 0)
   cycle = { epoch };
  return;
 }
 if (subscriptions !== metric.subscriptions) { epoch++; cycle = undefined; }
 ({ subscriptions, evaluating, queued } = metric);
 const candidate = cycle;
 if (candidate) {
  queueMicrotask(() => {
   // A worker reports queued-- before evaluating++; both are synchronous.
   // Check after that transition, never count its temporary zero/zero gauge.
   if (cycle !== candidate || candidate.epoch !== epoch || subscriptions !== 3 || evaluating !== 0 || queued !== 0) return;
   cycle = undefined;
   completedPolls++;
   for (const notify of waiters) notify();
  });
 }
 for (const notify of waiters) notify();
});
export async function barrier(input: v.InferOutput<typeof barrierInput>) {
 if (input.instance !== instance) throw new Error("Acceptance isolate changed");
 if (subscriptions !== input.expectedSubscriptions) throw new Error("Acceptance subscriptions changed");
 const armedEpoch = epoch;
 // First completion can include an ALL-read begun before the caller's commit.
 // The second cycle's ALL-read necessarily starts after the first queue drains.
 await new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => { waiters.delete(check); reject(new Error("Acceptance poll barrier timeout")); }, 25000);
  function check() {
   if (epoch !== armedEpoch || subscriptions !== input.expectedSubscriptions) {
    clearTimeout(timer); waiters.delete(check); reject(new Error("Acceptance subscriptions changed"));
   } else if (completedPolls >= input.after + 2 && evaluating === 0 && queued === 0) {
    clearTimeout(timer); waiters.delete(check); resolve();
   }
  }
  waiters.add(check); check();
 });
 return readMetrics();
}
`;
