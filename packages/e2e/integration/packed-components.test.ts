import { buildNeonFunctionBundle } from "kello-cli";
import { bootstrapDatabase } from "kello-cli";
import pg from "pg";
import { unzipSync } from "fflate";
import assert from "node:assert/strict";
import { test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const workspace = fileURLToPath(new URL("../../../", import.meta.url));
const fixtures = fileURLToPath(new URL("../fixtures/components-package/", import.meta.url));

test("packed components preserve typed per-instance bindings and transitive definitions outside the workspace", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "loom-packed-components-")));
  async function run(command: string[], cwd = root, env = process.env) {
    const child = Bun.spawn(command, { cwd, env, stdout: "pipe", stderr: "pipe", timeout: 120000 });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    assert.equal(code, 0, `${command.join(" ")}\n${stdout}\n${stderr}`);
    return stdout;
  }
  async function write(path: string, content: string) {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, content);
  }
  async function copyFixture(source: string, target: string) {
    for (const entry of await readdir(source, { withFileTypes: true })) {
      if (entry.isDirectory()) await copyFixture(join(source, entry.name), join(target, entry.name));
      else
        await write(
          join(target, entry.name.replace(/\.fixture$/, "")),
          await readFile(join(source, entry.name), "utf8"),
        );
    }
  }
  async function snapshot(directory: string): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    async function visit(parent: string) {
      for (const entry of await readdir(join(directory, parent), { withFileTypes: true })) {
        const path = join(parent, entry.name);
        if (entry.isDirectory()) await visit(path);
        else result[path] = await readFile(join(directory, path), "utf8");
      }
    }
    await visit("");
    return result;
  }
  const exports = {
    ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
    "./component": { types: "./dist/index.d.ts", import: "./dist/index.js" },
    "./*": { types: "./dist/*.d.ts", import: "./dist/*.js" },
  };
  const config = `export default { pack: { entry: ["src/**/*.ts"], root: "src", unbundle: true, format: "esm", platform: "node", dts: true, outExtensions: () => ({ js: ".js", dts: ".d.ts" }), deps: { neverBundle: true } } };`;
  const tsconfig = JSON.stringify({
    compilerOptions: {
      target: "ES2023",
      module: "ESNext",
      moduleResolution: "Bundler",
      strict: true,
      skipLibCheck: true,
      declaration: true,
      types: ["node"],
    },
    include: ["src"],
  });
  try {
    await run(
      ["bun", "pm", "pack", "--filename", join(root, "kello.tgz"), "--ignore-scripts"],
      join(workspace, "apps/kello"),
    );
    await run(
      ["bun", "pm", "pack", "--filename", join(root, "kello-cli.tgz"), "--ignore-scripts"],
      join(workspace, "apps/kello-cli"),
    );
    await write(
      join(root, "package.json"),
      JSON.stringify({
        private: true,
        type: "module",
        overrides: { kello: "file:./kello.tgz", "@loom-test/sdk": "file:./sdk.tgz" },
        dependencies: {
          kello: "file:./kello.tgz",
          "kello-cli": "file:./kello-cli.tgz",
          valibot: "1.5.0",
          "@orpc/client": "2.0.0-beta.46",
          "drizzle-orm": "1.0.0-rc.5",
        },
        devDependencies: { "@types/node": "24.13.6" },
      }),
    );
    await run(["bun", "install", "--ignore-scripts"]);
    const sdk = join(root, "sdk");
    await copyFixture(join(fixtures, "sdk"), join(sdk, "src"));
    await write(
      join(sdk, "package.json"),
      JSON.stringify({
        name: "@loom-test/sdk",
        version: "0.0.0",
        type: "module",
        files: ["dist"],
        exports,
        peerDependencies: { kello: "*" },
      }),
    );
    await write(join(sdk, "vite.config.ts"), config);
    await write(join(sdk, "tsconfig.json"), tsconfig);
    await run([join(workspace, "node_modules/.bin/vp"), "pack"], sdk);
    await run(["bun", "pm", "pack", "--filename", join(root, "sdk.tgz"), "--ignore-scripts"], sdk);
    await run(["bun", "add", "--ignore-scripts", "@loom-test/sdk@file:./sdk.tgz"]);
    const author = join(root, "author");
    await mkdir(author);
    await run([join(root, "node_modules/.bin/kello"), "integrate", "--cwd", author, "--apply", "--json"]);
    const stateful = join(author, "kello/components/catalog");
    await copyFixture(join(fixtures, "stateful"), stateful);
    await write(
      join(author, "kello/app.config.ts"),
      'import { defineApplication } from "kello"; import component from "./components/catalog/setup"; const app = defineApplication({ rpc: ({ os }) => ({ os }) }); app.use(component); export default app;',
    );
    await run([
      "bun",
      "-e",
      `import { generateProject } from "kello-cli"; await generateProject(${JSON.stringify(author)});`,
    ]);
    const library = join(root, "stateful");
    await mkdir(library);
    // Generated module boundaries are build inputs, never recreated inside a consumer's installed package.
    await cp(stateful, join(library, "src"), { recursive: true });
    await write(
      join(library, "package.json"),
      JSON.stringify({
        name: "@loom-test/stateful",
        version: "0.0.0",
        type: "module",
        files: ["dist"],
        exports,
        dependencies: { "@loom-test/sdk": "0.0.0" },
        peerDependencies: { kello: "*", valibot: "*", "drizzle-orm": "*" },
      }),
    );
    await write(join(library, "vite.config.ts"), config);
    await write(join(library, "tsconfig.json"), tsconfig);
    await write(
      join(library, "src/functions/products.ts"),
      (await readFile(join(library, "src/functions/products.ts"), "utf8")).replace(
        '"../_generated/rpc"',
        '"@loom-test/stateful/helper"',
      ),
    );
    await run([join(workspace, "node_modules/.bin/vp"), "pack"], library);
    await run(["bun", "pm", "pack", "--filename", join(root, "stateful.tgz"), "--ignore-scripts"], library);
    await run(["bun", "add", "--ignore-scripts", "@loom-test/stateful@file:./stateful.tgz"]);
    const installedStateful = await realpath(join(root, "node_modules/@loom-test/stateful"));
    const nestedSdk = join(installedStateful, "node_modules/@loom-test/sdk");
    await mkdir(join(nestedSdk, ".."), { recursive: true });
    await cp(await realpath(join(root, "node_modules/@loom-test/sdk")), nestedSdk, {
      recursive: true,
      dereference: true,
    });
    await rm(join(root, "node_modules/@loom-test/sdk"), { recursive: true });
    await rm(sdk, { recursive: true });
    await rm(author, { recursive: true });
    await rm(library, { recursive: true });
    const consumer = join(root, "consumer");
    await mkdir(consumer);
    await write(
      join(consumer, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2023",
          module: "ESNext",
          moduleResolution: "Bundler",
          strict: true,
          skipLibCheck: true,
          noEmit: true,
          types: ["node"],
        },
        include: ["kello"],
      }),
    );
    await run([join(root, "node_modules/.bin/kello"), "integrate", "--cwd", consumer, "--apply", "--json"]);
    await write(join(consumer, "kello/components/store.setup.ts"), 'export { default } from "@loom-test/stateful";');
    await write(
      join(consumer, "kello/app.config.ts"),
      'import { defineApplication } from "kello"; import store from "./components/store.setup"; const app = defineApplication({ rpc: ({ os }) => ({ os }) }); app.use(store, { name: "first", public: "first" }); app.use(store, { name: "second", public: "second" }); export default app;',
    );
    await write(
      join(root, "verify.ts"),
      `import assert from "node:assert/strict"; import { writeFile } from "node:fs/promises"; import { loadProject, generateProject } from "kello-cli"; import { getTableConfig } from "drizzle-orm/pg-core"; const project = await loadProject(${JSON.stringify(consumer)}); assert.deepEqual(project.components.map(c => c.path), ["first", "first/sdk", "second", "second/sdk"]); const schemas = project.componentScopes.filter(s => s.schema.tables.products).map(s => getTableConfig(s.schema.tables.products).schema); assert.equal(new Set(schemas).size, 2); const generated = await generateProject(${JSON.stringify(consumer)}); assert.equal((await generateProject(${JSON.stringify(consumer)})).version, generated.version); await writeFile(${JSON.stringify(join(root, "version.txt"))}, generated.version);`,
    );
    const installedBefore = await snapshot(installedStateful);
    await run(["bun", "verify.ts"]);
    assert.deepEqual(await snapshot(installedStateful), installedBefore);
    await write(join(root, "node-entry.ts"), await readFile(join(fixtures, "runtime.ts.fixture"), "utf8"));
    const archive = await buildNeonFunctionBundle(join(root, "node-entry.ts"));
    const deployed = await mkdtemp(join(tmpdir(), "loom-component-deployed-"));
    try {
      for (const [name, bytes] of Object.entries(unzipSync(archive))) {
        const destination = join(deployed, name);
        await mkdir(join(destination, ".."), { recursive: true });
        await writeFile(destination, bytes);
      }
      const connectionString = process.env.LOOM_TEST_DATABASE_URL;
      if (connectionString) {
        const address = new URL(connectionString);
        assert(["localhost", "127.0.0.1", "[::1]"].includes(address.hostname), "Local test database required");
        const metadataNamespace = `loom_packed_${crypto.randomUUID().replaceAll("-", "")}`;
        const runtimeRole = `${metadataNamespace}_role`;
        const admin = new pg.Client({ connectionString });
        await admin.connect();
        try {
          await bootstrapDatabase({ connectionString, metadataNamespace, runtimeRole });
          await run(["node", join(deployed, "index.mjs")], deployed, {
            ...process.env,
            LOOM_PACKED_METADATA_NAMESPACE: metadataNamespace,
          });
        } finally {
          try {
            await admin.query(`DROP SCHEMA IF EXISTS "${metadataNamespace}" CASCADE`);
            if ((await admin.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [runtimeRole])).rowCount)
              await admin.query(`DROP OWNED BY "${runtimeRole}"`);
            await admin.query(`DROP ROLE IF EXISTS "${runtimeRole}"`);
          } finally {
            await admin.end();
          }
        }
      } else {
        await run(["node", join(deployed, "index.mjs")], deployed);
      }
    } finally {
      await rm(deployed, { recursive: true, force: true });
    }
    const helper = join(nestedSdk, "dist/helper.js");
    await writeFile(helper, (await readFile(helper, "utf8")).replace('"sdk"', '"changed"'));
    await run([
      "bun",
      "-e",
      `import assert from "node:assert/strict"; import { readFile } from "node:fs/promises"; import { loadProject } from "kello-cli"; assert.notEqual((await loadProject(${JSON.stringify(consumer)})).version, await readFile(${JSON.stringify(join(root, "version.txt"))}, "utf8"));`,
    ]);
    await write(join(root, "browser.ts"), 'import component from "@loom-test/stateful"; console.log(component);');
    const browser = Bun.spawn(["bun", "build", "browser.ts", "--target", "browser"], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    const browserError = await new Response(browser.stderr).text();
    await new Response(browser.stdout).text();
    assert.notEqual(await browser.exited, 0);
    assert.match(browserError, /node:|browser|server/i);
    await write(
      join(consumer, "kello/types.ts"),
      `import { os } from "./_generated/rpc"; os.use(({ context, next }) => { const result: Promise<string> = context.components.first.rpc.products.title(); void result; // @ts-expect-error unknown component method\n context.components.second.rpc.products.missing(); return next(); });`,
    );
    await run([join(workspace, "node_modules/.bin/tsc"), "-p", join(consumer, "tsconfig.json")]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 180000);
