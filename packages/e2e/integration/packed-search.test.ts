import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";

test("packed generated search-shaped contracts expose the native dependent-output typing gap", async () => {
  const root = await mkdtemp(join(tmpdir(), "loom-packed-search-"));
  async function run(command: string[], cwd = root) {
    const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe", timeout: 120000 });
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
    await succeed(
      ["bun", "pm", "pack", "--filename", join(root, "kello.tgz"), "--ignore-scripts"],
      fileURLToPath(new URL("../../../apps/kello/", import.meta.url)),
    );
    await succeed(
      ["bun", "pm", "pack", "--filename", join(root, "kello-cli.tgz"), "--ignore-scripts"],
      fileURLToPath(new URL("../../../apps/kello-cli/", import.meta.url)),
    );
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        private: true,
        type: "module",
        dependencies: {
          kello: "file:./kello.tgz",
          "kello-cli": "file:./kello-cli.tgz",
          "@orpc/tanstack-query": "2.0.0-beta.46",
          "@tanstack/react-query": "5.104.3",
          "drizzle-orm": "1.0.0-rc.5",
          valibot: "1.5.0",
          react: "19.3.0",
        },
        devDependencies: { typescript: "7.0.2", "@types/react": "19.3.0" },
      }),
    );
    await succeed(["bun", "install", "--ignore-scripts", "--linker", "isolated"]);
    await writeFile(
      join(root, "initialize.mjs"),
      `import { initializeProject, saveResolvedProject } from "kello-cli";
await initializeProject("./app", "search-proof");
await saveResolvedProject("./app", {
  format: 1, projectId: "project-fixture", branchId: "br-fixture", branchName: "dev", protected: false, isDefault: false,
  databaseName: "neondb", migrationRole: "neondb_owner", public: { serviceUrl: "https://search.example.test" },
});
`,
    );
    await succeed(["bun", "initialize.mjs"]);
    const internalSource = await readFile(
      new URL("../../tests/types/search-contracts.test-d.ts", import.meta.url),
      "utf8",
    );
    // The appended policy-authoring probe uses the internal schema fixture;
    // this consumer retains the complete native projection-gap probe preceding it.
    const policyBoundary =
      '\nimport { createProjectContext } from "../../../apps/kello/src/core/server/rpc/procedure";';
    assert.equal(internalSource.split(policyBoundary).length, 2, "one internal policy probe boundary is required");
    const source = internalSource
      .split(policyBoundary)[0]!
      .replaceAll(
        /from "\.\.\/\.\.\/\.\.\/apps\/kello\/src\/core\/(server|client|contract)\/index"/g,
        'from "kello/$1"',
      )
      .replace(/^const contract = resolveContract\(.*\);\n/m, "");
    assert.doesNotMatch(source, /apps\/kello\/src/, "packed consumer must use public package imports");
    const boundary = "declare const client: RouterContractClient<typeof contract>;";
    assert.equal(source.split(boundary).length, 2, "proof must have one generated-client substitution point");
    await writeFile(
      join(root, "app/kello/contracts/tasks.ts"),
      `${source.split(boundary)[0]}\nexport default definition;\n`,
    );
    // The graph is real schema input to generation. These handlers only establish
    // contract/client types; they do not claim database pagination acceptance.
    await writeFile(
      join(root, "app/kello/schema.ts"),
      `import { defineSchema, defineTable } from "kello/server";
export default defineSchema(s => ({
  tasks: defineTable({ title: s.text().notNull(), done: s.boolean().notNull() }),
  labels: defineTable({ name: s.text().notNull() }),
  taskLabels: defineTable({ taskId: s.reference("tasks").notNull(), labelId: s.reference("labels").notNull() }),
}), { namespace: "app" });
`,
    );
    await writeFile(
      join(root, "app/kello/relations.ts"),
      `import { defineRelations } from "drizzle-orm";
import schema from "./schema";
export default defineRelations(schema.tables, r => ({
  tasks: { labels: r.many.labels({
    from: r.tasks._id.through(r.taskLabels.taskId),
    to: r.labels._id.through(r.taskLabels.labelId),
  }) },
}));
`,
    );
    await writeFile(
      join(root, "app/kello/functions/tasks.ts"),
      `import { os } from "../_generated/rpc";
export default os.tasks.router({
  list: os.tasks.list.handler(() => ({ rows: [], nextCursor: null })),
  watch: os.tasks.watch.handler(async function* () { yield { rows: [], nextCursor: null }; }),
});
`,
    );
    await writeFile(
      join(root, "generate.mjs"),
      'import { generateProject } from "kello-cli"; await generateProject("./app");\n',
    );
    await succeed(["bun", "generate.mjs"]);
    await succeed([join(root, "node_modules/.bin/kello"), "generate", "--cwd", join(root, "app")]);
    const probe = source.replace('from "kello/client"', 'from "@orpc/tanstack-query"').replace(
      boundary,
      `import { createClient } from "./app/kello/_generated/api";
const connection = createClient({ url: "https://search.example.test", getToken: async () => null });
const client = connection.client.tasks;`,
    );
    await writeFile(join(root, "probe.ts"), probe);
    await writeFile(
      join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2023",
          module: "Preserve",
          moduleResolution: "Bundler",
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          lib: ["ES2023", "DOM", "DOM.Iterable"],
        },
        include: ["probe.ts"],
      }),
    );
    const compiler = join(root, "node_modules/.bin/tsc");
    await succeed([compiler, "-p", "tsconfig.json"]);
    await writeFile(join(root, "probe.ts"), probe.replace(/^\s*\/\/ @ts-expect-error \(projection gap\).*$/gm, ""));
    const exactProjection = await run([compiler, "-p", "tsconfig.json"]);
    assert.notEqual(exactProjection.code, 0, "native selection gap unexpectedly disappeared; reassess U1");
    assert.match(exactProjection.output, /TS2322: Type 'string \| undefined'/);
    assert.match(exactProjection.output, /name\?: string/);
    assert.match(exactProjection.output, /TS2339: Property 'title' does not exist/);
    const diagnostics = [...exactProjection.output.matchAll(/^probe\.ts\(.+\): error (TS\d+):/gm)].map((match) => {
      assert.ok(match[1]);
      return match[1];
    });
    assert.deepEqual(
      diagnostics.sort((left, right) => left.localeCompare(right)),
      ["TS2322", "TS2322", "TS2322", "TS2322", "TS2339"],
    );
    assert.equal((exactProjection.output.match(/: error TS\d+:/g) ?? []).length, diagnostics.length);
    await writeFile(join(root, "probe.ts"), probe);
    await writeFile(
      join(root, "browser.mjs"),
      `import assert from "node:assert/strict";
const result = await Bun.build({ entrypoints: ["./app/kello/_generated/api.js"], target: "browser" });
assert.equal(result.success, true, String(result.logs));
const output = (await Promise.all(result.outputs.map(file => file.text()))).join("\\n");
assert.match(output, /search\\.example\\.test/);
assert.doesNotMatch(output, /taskLabels|DATABASE_URL|node:fs|pg-protocol/);
`,
    );
    await succeed(["bun", "browser.mjs"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 180000);
