import { writePackedSearchSSR } from "../fixtures/packed-search-ssr";
import { writeSearchComponent } from "../fixtures/search-component";
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";

test("packed generated search infers selected results through native options", async () => {
  const root = await mkdtemp(join(tmpdir(), "loom-search-generated-"));
  async function run(command: string[], cwd = root) {
    const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe", timeout: 120_000 });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { code, output: `${stdout}${stderr}` };
  }
  async function succeed(command: string[], cwd = root) {
    const result = await run(command, cwd);
    assert.equal(result.code, 0, `${command.join(" ")}\n${result.output}`);
    return result.output;
  }
  try {
    console.info(JSON.stringify({ proof: "search-generated-root-created", root }));
    await succeed(
      ["bun", "pm", "pack", "--filename", join(root, "kello.tgz"), "--ignore-scripts"],
      fileURLToPath(new URL("../../../apps/loom/", import.meta.url)),
    );
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        private: true,
        type: "module",
        dependencies: {
          kello: "file:./kello.tgz",
          "@orpc/client": "2.0.0-beta.43",
          "@orpc/server": "2.0.0-beta.43",
          "@orpc/tanstack-query": "2.0.0-beta.43",
          "@tanstack/react-query": "5.104.3",
          "drizzle-orm": "1.0.0-rc.4",
          valibot: "1.5.0",
          react: "19.3.0",
          "react-dom": "19.3.0",
          effect: "4.0.5",
        },
        devDependencies: { typescript: "7.0.2", "@types/react": "19.3.0" },
      }),
    );
    await succeed(["bun", "install", "--ignore-scripts", "--linker", "isolated"]);
    await writeFile(
      join(root, "initialize.mjs"),
      `import { initializeProject, saveResolvedProject } from "kello/tooling";
await initializeProject("./app", "search-generated");
await saveResolvedProject("./app", { format: 1, projectId: "fixture", branchId: "br-fixture", branchName: "dev", protected: false, isDefault: false, databaseName: "neondb", migrationRole: "neondb_owner", public: { serviceUrl: "https://search.example.test" } });`,
    );
    await succeed(["bun", "initialize.mjs"]);
    // Internal proofs use source modules; the isolated consumer must resolve only published exports.
    function publicImports(source: string) {
      return source.replaceAll(
        /from "\.\.\/\.\.\/\.\.\/apps\/loom\/src\/core\/(server|client|contract)\/index"/g,
        'from "kello/$1"',
      );
    }
    const fixture = publicImports(
      await readFile(new URL("../../tests/fixtures/search-schema.ts", import.meta.url), "utf8"),
    );
    await writeFile(join(root, "app/kello/fixture.ts"), fixture);
    await writeFile(join(root, "app/kello/schema.ts"), 'export { searchSchema as default } from "./fixture";');
    await writeFile(join(root, "app/kello/relations.ts"), 'export { searchRelations as default } from "./fixture";');
    const source = publicImports(
      await readFile(new URL("../../tests/types/search-generated.test-d.ts", import.meta.url), "utf8"),
    );
    const factory = source.slice(source.indexOf("const policy ="), source.indexOf("type Native ="));
    assert.match(factory, /validators\.tables\.tasks\.search/);
    await writeFile(
      join(root, "app/kello/contracts/tasks.ts"),
      `import { defineContract, oc } from "kello/contract";
import * as v from "valibot";
export default defineContract(({ validators }) => { ${factory} return { ...contract, effectList: contract.list }; });`,
    );
    await writeFile(
      join(root, "app/kello/functions/tasks.ts"),
      `import { os } from "../_generated/rpc";
import { Search } from "../_generated/server";
import { Effect } from "effect";
export default os.tasks.router({
  list: os.tasks.list.handler(({ context, input }) => context.search.tasks.paginate(input)),
  effectList: os.tasks.effectList.effect(function* ({ input }) { const search = yield* Search; return yield* Effect.promise(() => search.tasks.paginate(input)); }),
  watch: os.tasks.watch.handler(({ context, input }) => context.search.tasks.watch(input)),
  ordinary: os.tasks.ordinary.handler(() => "native"),
});`,
    );
    await writeSearchComponent(join(root, "app/kello"));
    await writeFile(
      join(root, "app/kello/app.config.ts"),
      `import { defineApplication } from "kello";
import catalog from "./components/catalog/setup";
import reader from "./components/reader/setup";
const app = defineApplication({ rpc: ({ os }) => ({ os }) });
const store = app.use(catalog, { public: "store" });
const staff = app.use(catalog, { name: "staff" });
app.use(reader, { dependencies: { catalog: store }, public: "reader" });
app.use(reader, { name: "staffReader", dependencies: { catalog: staff } });
export default app;`,
    );
    await writeFile(
      join(root, "generate.mjs"),
      'import { generateProject } from "kello/tooling"; await generateProject("./app");',
    );
    await succeed(["bun", "generate.mjs"]);
    await succeed([join(root, "node_modules/.bin/kello"), "generate", "--cwd", join(root, "app")]);
    await writePackedSearchSSR(root);
    await succeed(["bun", "ssr.mjs"]);
    // Check emitted declarations as source, so skipLibCheck cannot hide generator
    // errors while upstream declarations keep their consumer compatibility setting.
    const declaration = join(root, "app/kello/_generated/current/api.d.ts");
    await writeFile(join(root, "app/kello/_generated/current/checked-api.ts"), await readFile(declaration));
    const copy = join(dirname(await realpath(join(root, "node_modules/kello"))), "loom-copy/dist");
    await cp(join(root, "node_modules/kello/dist"), copy, { recursive: true });
    await writeFile(
      join(root, "copies.mjs"),
      `import assert from "node:assert/strict";
import { createProjectContext } from ${JSON.stringify(join(copy, "core/server/index.js"))};
import { searchPublicNode } from "kello/server";
import { searchSchema, searchRelations } from "./app/kello/fixture.ts";
const { validators } = createProjectContext(searchSchema, searchRelations);
const descriptor = validators.tables.tasks.search({ scope: "public", columns: ["title"] });
assert.deepEqual(Object.keys(searchPublicNode(descriptor.input).columns), ["title"]);
assert.deepEqual(searchPublicNode(descriptor.input), searchPublicNode(descriptor.output));`,
    );
    await succeed(["bun", "copies.mjs"]);
    const probe = source
      .replace('from "../fixtures/search-schema"', 'from "./app/kello/fixture"')
      .replace(
        "declare const client: SearchRouterClient<Native>;",
        `import { createClient } from "./app/kello/_generated/api";
const connection = createClient({ getToken: async () => null });
const client = connection.client.tasks;`,
      )
      .replace("declare const rpc: SearchRouterUtils<Native>;", "const rpc = connection.rpc.tasks;");
    assert.doesNotMatch(probe, /@ts-expect-error|@ts-ignore/);
    assert.doesNotMatch(fixture + probe, /apps\/loom\/src/);
    await writeFile(
      join(root, "probe.ts"),
      probe +
        `
async function components() {
  const page = await connection.client.store.items.list({ columns: { title: true }, with: { labels: { columns: { name: true } } } });
  const title: string = page.rows[0]!.title;
  const label: string = page.rows[0]!.labels[0]!.name;
  const effect = await connection.client.store.items.effectList({ columns: { done: true } });
  const done: boolean = effect.rows[0]!.done;
  void [title, label, done];
}
import { os } from "./app/kello/_generated/rpc";
os.tasks.ordinary.handler(async ({ context }) => {
  const page = await context.components.catalog.rpc.items.list({ columns: { title: true } });
  const staff = await context.components.staff.rpc.items.list({ columns: { done: true } });
  const title: string = page.rows[0]!.title;
  const done: boolean = staff.rows[0]!.done;
  return title + done;
});
`,
    );
    const compilerOptions = {
      target: "ES2023",
      module: "Preserve",
      moduleResolution: "Bundler",
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      lib: ["ES2023", "DOM", "DOM.Iterable"],
    };
    const compiler = join(root, "node_modules/.bin/tsc");
    await writeFile(
      join(root, "full-text.ts"),
      `
import { defineSchema, defineTable } from "kello/server";
import { assessMigration } from "kello/tooling";
import type { MigrationPlan, MigrationAssessment, ApplyMigrationsOptions } from "kello/tooling";
const schema = defineSchema((s) => ({ tasks: defineTable({ title: s.text(), status: s.enum(["open", "closed"]) }, {
  fullText: { content: { config: "pg_catalog.simple", fields: [{ field: "title", weight: "A" }, { field: "status", weight: "D" }], version: "1" } },
}) }));
const config: "pg_catalog.simple" = schema.metadata.entities[0]!.options.fullText.content.config;
const literalSources: readonly [{ readonly field: "title"; readonly weight: "A" }, { readonly field: "status"; readonly weight: "D" }] = schema.metadata.entities[0]!.options.fullText.content.fields;
const mutableSources: { field: "title" | "body"; weight: "A" | "D" }[] = [{ field: "title", weight: "A" }];
const mutableDocument = {
  config: "pg_catalog.simple" as const,
  fields: mutableSources,
  version: "1",
};
const mutableSchema = defineSchema((s) => ({ articles: defineTable({ title: s.text(), body: s.text() }, {
  fullText: { content: mutableDocument },
}) }));
const mutableContent = mutableSchema.metadata.entities[0]!.options.fullText.content;
const mutableConfig: "pg_catalog.simple" = mutableContent.config;
const mutableVersion: string = mutableContent.version;
const sourceField: "title" | "body" = mutableContent.fields[0]!.field;
const sourceWeight: "A" | "D" = mutableContent.fields[0]!.weight;
const nativeContent: typeof mutableContent = mutableSchema.tables.articles._.fullText.content;
// @ts-expect-error compiled versions are readonly for mutable author input
mutableContent.version = "2";
// @ts-expect-error compiled source arrays are readonly for mutable author input
mutableContent.fields.push({ field: "body", weight: "D" });
// @ts-expect-error compiled source entries are deeply readonly
mutableContent.fields[0]!.field = "body";
// @ts-expect-error compiled source weights are deeply readonly
mutableContent.fields[0]!.weight = "D";
// @ts-expect-error mutable input preserves literal document names
mutableSchema.metadata.entities[0]!.options.fullText.absent;
void [literalSources, mutableConfig, mutableVersion, sourceField, sourceWeight, nativeContent];
declare const plan: MigrationPlan;
const result: Promise<MigrationAssessment> = assessMigration(plan);
declare const assessment: Awaited<typeof result>;
if (!assessment.blockingGinTimeout.eligible) {
  const reason: string = assessment.blockingGinTimeout.reason;
  void reason;
}
// @ts-expect-error derived evidence is readonly
assessment.artifactHash = "changed";
// @ts-expect-error derived evidence cannot be executed as an immutable artifact
assessMigration(assessment);
// @ts-expect-error document names remain literal keys
schema.metadata.entities[0]!.options.fullText.absent;
const options: ApplyMigrationsOptions = { connectionString: "postgresql://localhost/disposable", root: ".", migrations: "migrations", namespace: "app", runtimeRole: "runtime", reviewedHashes: [plan.hash], blockingGinTimeouts: [{ artifactHash: plan.hash, statementTimeoutMs: 120000 }] };
void [config, options];
`,
    );
    await writeFile(
      join(root, "full-text.mjs"),
      `
import assert from "node:assert/strict";
import { defineSchema, defineTable } from "kello/server";
import { assessMigration, createSnapshot, emptySnapshot, planMigration, validateMigration } from "kello/tooling";
const initial = defineSchema((s) => ({ tasks: { title: s.text() } }), { namespace: "fts_packed" });
const target = defineSchema((s) => ({ tasks: defineTable({ title: s.text() }, { fullText: { content: { config: "pg_catalog.simple", fields: [{ field: "title", weight: "A" }], version: "1" } } }) }), { namespace: "fts_packed" });
const baseline = await createSnapshot(initial);
const plan = await planMigration(baseline, target);
const before = JSON.stringify(plan);
const assessment = await assessMigration(plan);
assert.equal(plan.safety.automatic, true);
assert.equal(assessment.safety.automatic, false);
assert.equal(assessment.artifactHash, plan.hash);
assert.deepEqual(assessment.blockingGinTimeout, { eligible: true });
assert.equal(assessment.blockingGinOperations.length, 1);
await validateMigration(plan);
assert.equal(JSON.stringify(plan), before);
assert.equal((await assessMigration(await planMigration(await emptySnapshot("fts_packed"), target))).safety.automatic, true);
assert.equal((await planMigration(plan.snapshot, target)).statements.length, 0);
`,
    );
    await succeed(["bun", "full-text.mjs"]);
    for (const exactOptionalPropertyTypes of [true, false]) {
      await writeFile(
        join(root, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: { ...compilerOptions, exactOptionalPropertyTypes },
          include: ["probe.ts", "full-text.ts", "app/kello/**/*.ts"],
        }),
      );
      const start = performance.now();
      await succeed([compiler, "-p", "tsconfig.json"]);
      console.info(
        JSON.stringify({
          proof: "search-four-edge-types",
          exactOptionalPropertyTypes,
          elapsedMs: Math.round(performance.now() - start),
          declarationBytes: (await readFile(join(root, "app/kello/_generated/current/api.d.ts"))).byteLength,
        }),
      );
    }
    await writeFile(
      join(root, "negative.ts"),
      `import { createClient } from "./app/kello/_generated/api";
import { keepPreviousData } from "@tanstack/react-query";
const { client, rpc } = createClient({ getToken: async () => null });
const forbidden = { columns: { title: true, projectId: true } } as const;
client.tasks.list(forbidden);
rpc.tasks.list.queryOptions({ input: forbidden });
rpc.tasks.list.queryOptions({ input: { columns: { title: true } }, initialData: { rows: [{ title: 42 }], nextCursor: null, previousCursor: null } });
rpc.tasks.list.queryOptions({ input: { columns: { done: true } }, placeholderData: keepPreviousData });
rpc.tasks.list.queryOptions({ input: { columns: { title: true } }, queryFn: async () => ({ rows: [{ done: true }], nextCursor: null, previousCursor: null }) });
const nested = { with: { labels: { columns: { name: true, _id: true } } } } as const;
client.tasks.list(nested);
async function fields() { const result = await client.tasks.list({ columns: { title: true } }); result.rows[0]!.done; }
rpc.tasks.list.queryKey({ input: forbidden });
rpc.tasks.list.infiniteKey({ input: () => forbidden, initialPageParam: null });
rpc.tasks.watch.liveKey({ input: forbidden });
client.store.items.list({ columns: { title: true, projectId: true } });
client.staff;
client.store.internal;
client.store.items.list({ with: { taskLabels: {} } });
async function componentFields() { const page = await client.store.items.list({ columns: { title: true } }); page.rows[0]!.done; }
client.tasks.list({ orderBy: [{ field: "title", direction: "asc", unknown: true }] } as const);
client.tasks.list({ orderBy: [{ field: "owner", direction: "asc" }] } as const);
client.tasks.list({ with: { labels: { orderBy: [{ field: "name", direction: "asc", unknown: true }] } } } as const);

`,
    );
    await writeFile(join(root, "negative.json"), JSON.stringify({ compilerOptions, include: ["negative.ts"] }));
    const negative = await run([compiler, "-p", "negative.json"]);
    assert.notEqual(negative.code, 0);
    for (const line of [5, 6, 7, 8, 9, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23])
      assert.match(negative.output, new RegExp(`negative\\.ts\\(${line},`));
    await writeFile(
      join(root, "browser.mjs"),
      `import assert from "node:assert/strict";
const result = await Bun.build({ entrypoints: ["./app/kello/_generated/api.js"], target: "browser" });
assert.equal(result.success, true, String(result.logs));
const output = (await Promise.all(result.outputs.map(file => file.text()))).join("\\n");
assert.match(output, /loom-search-projections/);
assert.doesNotMatch(output, /taskLabels|projectId|organizationId|DATABASE_URL|node:fs|node:crypto|pg-protocol|kello.search.descriptor/);
console.info(JSON.stringify({ proof: "search-browser-bundle", bytes: Buffer.byteLength(output) }));
`,
    );
    console.info((await succeed(["bun", "browser.mjs"])).trim());
    await writeFile(
      join(root, "watch.mjs"),
      `import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { watchDevelopment, generateProject } from "kello/tooling";
let generations = 0;
const watcher = await watchDevelopment("./app", async () => { await generateProject("./app"); generations++; }, { debounceMs: 100 });
try {
  await watcher.flush();
  const before = generations;
  for (const name of ["schema.ts", "contracts/items.ts"]) {
    const path = "./app/kello/components/catalog/" + name;
    await writeFile(path, (await readFile(path, "utf8")).replaceAll("title", "caption"));
  }
  for (const name of ["relations.ts", "contracts/items.ts"]) {
    const path = "./app/kello/components/catalog/" + name;
    await writeFile(path, (await readFile(path, "utf8")).replace("labels:", "tags:"));
  }
  const reader = "./app/kello/components/reader/functions/items.ts";
  await writeFile(reader, (await readFile(reader, "utf8")).replace("{ title: true }", "{ caption: true }").replace("page.rows[0]!.title", "page.rows[0]!.caption"));
  const deadline = Date.now() + 30000;
  while (generations === before && !watcher.failure && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  await watcher.settled();
  assert.equal(watcher.failure, null);
  assert.ok(generations > before, "schema edits must trigger generation without CLI generate");
} finally { await watcher.stop(); }
`,
    );
    await succeed(["bun", "watch.mjs"]);
    await writeFile(join(root, "app/kello/_generated/current/checked-api.ts"), await readFile(declaration));
    await writeFile(
      join(root, "regenerated.ts"),
      `import { createClient } from "./app/kello/_generated/api";
const { client } = createClient({ getToken: async () => null });
async function current() {
  const page = await client.store.items.list({ columns: { caption: true }, with: { tags: { columns: { name: true } } } });
  const caption: string = page.rows[0]!.caption;
  const tag: string = page.rows[0]!.tags[0]!.name;
  return caption + tag;
}
`,
    );
    await writeFile(
      join(root, "regenerated.json"),
      JSON.stringify({ compilerOptions, include: ["regenerated.ts", "app/kello/**/*.ts"] }),
    );
    await succeed([compiler, "-p", "regenerated.json"]);
    await writeFile(
      join(root, "removed.ts"),
      `import { createClient } from "./app/kello/_generated/api";
const { client } = createClient({ getToken: async () => null });
client.store.items.list({ columns: { title: true } });
client.store.items.list({ with: { labels: {} } });
`,
    );
    await writeFile(join(root, "removed.json"), JSON.stringify({ compilerOptions, include: ["removed.ts"] }));
    const removed = await run([compiler, "-p", "removed.json"]);
    assert.notEqual(removed.code, 0);
    assert.match(removed.output, /removed\.ts\(3,/);
    assert.match(removed.output, /removed\.ts\(4,/);
    // Regeneration must change the selected codec and remove unmounted capabilities.
    const componentSchema = join(root, "app/kello/components/catalog/schema.ts");
    const beforeCodec = await readFile(componentSchema, "utf8");
    assert.match(beforeCodec, /caption: s\.text\(\)/);
    await writeFile(componentSchema, beforeCodec.replace("caption: s.text()", "caption: s.boolean()"));
    await writeFile(
      join(root, "app/kello/app.config.ts"),
      `import { defineApplication } from "kello";
import catalog from "./components/catalog/setup";
const app = defineApplication({ rpc: ({ os }) => ({ os }) });
app.use(catalog, { public: "store" });
export default app;`,
    );
    await succeed(["bun", "generate.mjs"]);
    await writeFile(join(root, "app/kello/_generated/current/checked-api.ts"), await readFile(declaration));
    await writeFile(
      join(root, "codec.ts"),
      `import { createClient } from "./app/kello/_generated/api";
const { client } = createClient({ getToken: async () => null });
async function current() {
  const page = await client.store.items.list({ columns: { caption: true } });
  const caption: boolean = page.rows[0]!.caption;
  return caption;
}`,
    );
    await writeFile(join(root, "codec.json"), JSON.stringify({ compilerOptions, include: ["codec.ts"] }));
    await succeed([compiler, "-p", "codec.json"]);
    await writeFile(
      join(root, "codec-negative.ts"),
      `import { createClient } from "./app/kello/_generated/api";
const { client } = createClient({ getToken: async () => null });
client.reader;
async function obsoleteCodec() {
  const page = await client.store.items.list({ columns: { caption: true } });
  const caption: string = page.rows[0]!.caption;
  return caption;
}`,
    );
    await writeFile(
      join(root, "codec-negative.json"),
      JSON.stringify({ compilerOptions, include: ["codec-negative.ts"] }),
    );
    const obsoleteCodec = await run([compiler, "-p", "codec-negative.json"]);
    assert.notEqual(obsoleteCodec.code, 0);
    assert.match(obsoleteCodec.output, /codec-negative\.ts\(3,/);
    assert.match(obsoleteCodec.output, /codec-negative\.ts\(6,/);
  } finally {
    await rm(root, { recursive: true, force: true });
    console.info(JSON.stringify({ proof: "search-generated-root-cleanup", root }));
  }
}, 180_000);
