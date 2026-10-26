import assert from "node:assert/strict";
import { test } from "bun:test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("documented authoring examples compile and validate through a packed public API", async () => {
  const examples = fileURLToPath(new URL("../../../apps/docs/examples/", import.meta.url));
  assert.ok((await readFile(join(examples, "kello/schema.ts"), "utf8")).includes("defineSchema"));
  const root = await mkdtemp(join(tmpdir(), "loom-docs-consumer-"));
  async function run(command: string[], cwd = root) {
    const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe", timeout: 60000 });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    assert.equal(code, 0, `${command.join(" ")}\n${stdout}\n${stderr}`);
  }
  try {
    await run(
      ["bun", "pm", "pack", "--filename", join(root, "kello.tgz"), "--ignore-scripts"],
      fileURLToPath(new URL("../../../apps/kello/", import.meta.url)),
    );
    await run(
      ["bun", "pm", "pack", "--filename", join(root, "kello-cli.tgz"), "--ignore-scripts"],
      fileURLToPath(new URL("../../../apps/kello-cli/", import.meta.url)),
    );
    await cp(examples, join(root, "examples"), {
      recursive: true,
      filter: (path) => !["_generated", ".kello"].includes(path.split("/").at(-1) ?? ""),
    });
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        private: true,
        type: "module",
        dependencies: {
          kello: "file:./kello.tgz",
          "kello-cli": "file:./kello-cli.tgz",
          "drizzle-orm": "1.0.0-rc.5",
          "@orpc/server": "2.0.0-beta.46",
          effect: "4.0.6",
          valibot: "1.5.0",
          typescript: "7.0.2",
          "@types/node": "24.13.6",
        },
      }),
    );
    await writeFile(
      join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          types: ["node"],
          module: "ESNext",
          moduleResolution: "Bundler",
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          exactOptionalPropertyTypes: true,
          noUncheckedIndexedAccess: true,
        },
        include: ["examples/**/*.ts", "verify.ts"],
      }),
    );
    await run(["bun", "install", "--ignore-scripts"]);
    await writeFile(
      join(root, "generate.ts"),
      'import { generateProject } from "kello-cli"; await generateProject("./examples");',
    );
    await run(["bun", "generate.ts"]);
    await writeFile(
      join(root, "verify.ts"),
      `
import assert from "node:assert/strict";
import { createRouterClient, implement } from "@orpc/server";
import { contract } from "./examples/kello/_generated/contract-registry";
import schema from "./examples/kello/schema";
import relations from "./examples/kello/relations";
import auth from "./examples/kello/auth.config";
import tasks from "./examples/kello/functions/tasks";
assert.equal(schema.metadata.namespace, "app");
const insert = schema.validators.tasks.insert["~standard"];
assert.deepEqual(await insert.validate({ title: "  Ship docs  " }), { value: { title: "Ship docs" } });
assert.ok((await insert.validate({ title: " " })).issues);
assert.ok((await insert.validate({ title: "Valid", ownerId: "forged" })).issues);
assert.ok((await schema.validators.tasks.patch["~standard"].validate({ title: undefined })).issues);
const projected = await schema.validators.tasks.public["~standard"].validate({ _id: "00000000-0000-4000-8000-000000000001", title: "Ship", done: false, ownerId: "private-owner" });
assert.deepEqual(projected, { value: { _id: "00000000-0000-4000-8000-000000000001", title: "Ship", done: false } });
assert.ok(relations);
const invocation = { identity: null, requestId: "docs", signal: new AbortController().signal };
await assert.rejects(auth.authorize({ ...invocation, path: ["tasks", "greeting"], input: { name: "Ada" } }));
assert.ok(tasks.greeting);
const client = createRouterClient({ greeting: implement(contract.tasks.greeting).handler(({ input }) => "Hello, " + input.name) });
assert.equal(await client.greeting({ name: "Ada" }), "Hello, Ada");
`,
    );
    await run(["bun", "run", "tsc", "-p", "tsconfig.json"]);
    await run(["bun", "verify.ts"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 120000);
