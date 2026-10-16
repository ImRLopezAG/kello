import { expect, test } from "vite-plus/test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const testsDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDirectory = resolve(testsDirectory, "../../apps/kello/src");

// Bundle the real loader with source server imports. The fixture's local kello
// package routes authored/virtual imports to those same source modules.
async function runLoaderTest(body: string) {
  const root = await mkdtemp(join(testsDirectory, ".rate-limits-loader-"));
  try {
    const sourcePackage = join(root, "node_modules/kello");
    await mkdir(sourcePackage, { recursive: true });
    const dependencies = resolve(sourceDirectory, "../node_modules");
    for (const name of await readdir(dependencies)) {
      if (name !== "kello") await symlink(join(dependencies, name), join(root, "node_modules", name));
    }
    await writeFile(
      join(sourcePackage, "package.json"),
      JSON.stringify({
        name: "kello",
        type: "module",
        exports: { "./server": "./server.ts", "./contract": "./contract.ts" },
      }),
    );
    await writeFile(
      join(sourcePackage, "server.ts"),
      `export * from ${JSON.stringify(join(sourceDirectory, "core/server/index.ts"))};`,
    );
    await writeFile(
      join(sourcePackage, "contract.ts"),
      `export * from ${JSON.stringify(join(sourceDirectory, "core/contract/index.ts"))};`,
    );
    const script = join(root, "test.ts");
    await writeFile(
      script,
      `
import { build } from "bun";
const server = await import(${JSON.stringify(join(sourceDirectory, "core/server/index.ts"))});
const { defineRateLimits, isRateLimitDefinitions, defineComponent, defineComponentPackage, getComponentPackage } = server;
import assert from "node:assert/strict";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
const root = ${JSON.stringify(root)};
const bundledLoader = await build({
  entrypoints: [${JSON.stringify(join(sourceDirectory, "tooling/project/load.ts"))}], target: "bun", format: "esm", packages: "external",
  plugins: [{ name: "rate-limits-loader-source-imports", setup(builder) {
    builder.onResolve({ filter: /^kello\\/server$/ }, () => ({ path: ${JSON.stringify(join(sourceDirectory, "core/server/index.ts"))}, external: true }));
  } }],
});
assert.equal(bundledLoader.success, true, JSON.stringify(bundledLoader.logs));
const loaderFile = join(root, "loader.mjs");
await writeFile(loaderFile, await bundledLoader.outputs[0].text());
const { loadProject } = await import(loaderFile);
const backend = join(root, "backend");
async function put(path, source) {
  const filename = join(root, path);
  await mkdir(join(filename, ".."), { recursive: true });
  await writeFile(filename, source);
}
await mkdir(join(backend, "functions"), { recursive: true });
await mkdir(join(backend, "contracts"), { recursive: true });
await put("kello.config.ts", 'export default { backend: "backend" };');
await put("backend/schema.ts", 'import { defineSchema } from "kello/server"; export default defineSchema(() => ({}), { namespace: "app" });');
await put("backend/app.config.ts", 'import { defineApplication } from "kello/server"; export default defineApplication({ rpc: ({ os }) => ({ os }) });');
const quota = { version: 1, mode: "quota", scope: "user", limit: 10, windowMs: 60000 };
const policySource = (limit = 10) => 'import { defineRateLimits } from "kello/server"; export default defineRateLimits({ createItem: ' + JSON.stringify({ ...quota, limit }) + ' });';
const empty = defineRateLimits({});
const descriptor = {
  formatVersion: 1, definitionVersion: "1.0.0", entry: "rate-loader-fixture",
  contractRegistry: "rate-loader-fixture/contracts", contracts: [], procedures: [], bindings: {},
};
${body}
`,
    );
    const result = await execute("bun", [script], { cwd: root, timeout: 30_000 });
    expect(result.stderr).toBe("");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// Each case launches a bounded 30-second loader subprocess; allow its cleanup
// to finish before the test runner times out under concurrent workspace load.
test("absent root policy module loads a validated empty registry", async () => {
  await runLoaderTest(`
const project = await loadProject(root);
assert.equal(isRateLimitDefinitions(project.rateLimits), true);
assert.deepEqual(project.rateLimits, empty);
`);
}, 35_000);

test("root policies use the rateLimits alias, canonical definitions and generation hash", async () => {
  await runLoaderTest(`
await put("backend/rate-limits.ts", policySource());
const first = await loadProject(root);
assert.deepEqual(first.rateLimits, defineRateLimits({ createItem: quota }));
assert.equal(first.rateLimits.fingerprint, defineRateLimits({ createItem: { ...quota } }).fingerprint);
assert.equal((await loadProject(root)).version, first.version);
await put("backend/rate-limits.ts", 'import { defineRateLimits } from "kello/server"; export default defineRateLimits({ createItem: { windowMs: 60000, limit: 10, scope: "user", mode: "quota", version: 1 } });');
const independent = await loadProject(root);
assert.notEqual(independent.version, first.version);
assert.notEqual(independent.rateLimits, first.rateLimits);
assert.equal(isRateLimitDefinitions(independent.rateLimits), true);
assert.equal(independent.rateLimits.fingerprint, first.rateLimits.fingerprint);
await put("backend/rate-limits.ts", policySource(11));
const changed = await loadProject(root);
assert.equal(changed.rateLimits.policies.createItem.limit, 11);
assert.notEqual(changed.version, first.version);
assert.notEqual(changed.rateLimits.fingerprint, first.rateLimits.fingerprint);
`);
}, 35_000);

test("present malformed root policy modules fail closed, including null and undefined", async () => {
  await runLoaderTest(`
for (const source of [
  "export default undefined;", "export default null;", "export default {};",
  'import { defineRateLimits } from "kello/server"; const definitions = defineRateLimits({}); export default { ...definitions, fingerprint: "0".repeat(64) };',
  'import { defineRateLimits } from "kello/server"; export default defineRateLimits({ bad: { version: 1, mode: "quota", scope: "user", limit: 0, windowMs: 60000 } });',
  "export const missingDefault = true;", "export default (;",
]) {
  await put("backend/rate-limits.ts", source);
  await assert.rejects(loadProject(root));
}
`);
}, 35_000);

test("local component registries stay bound to stable mounts and participate in the bundle hash", async () => {
  await runLoaderTest(`
await put("backend/components/shared/setup.ts", 'import { defineComponent } from "kello/server"; export default defineComponent({ name: "shared" });');
await put("backend/components/empty/setup.ts", 'import { defineComponent } from "kello/server"; export default defineComponent({ name: "empty" });');
await put("backend/app.config.ts", 'import { defineApplication } from "kello/server"; import shared from "./components/shared/setup"; import empty from "./components/empty/setup"; const app = defineApplication({ rpc: ({ os }) => ({ os }) }); app.use(shared, { name: "left" }); app.use(shared, { name: "right" }); app.use(empty); export default app;');
await put("backend/components/shared/rate-limits.ts", policySource());
const first = await loadProject(root);
assert.deepEqual(first.componentScopes.map(scope => scope.mountPath), ["left", "right", "empty"]);
assert.deepEqual(first.rateLimits, empty);
assert.deepEqual(first.componentScopes.find(scope => scope.mountPath === "empty").rateLimits, empty);
for (const mountPath of ["left", "right"]) {
  const scope = first.componentScopes.find(scope => scope.mountPath === mountPath);
  assert.equal(isRateLimitDefinitions(scope.rateLimits), true);
  assert.deepEqual(scope.rateLimits, defineRateLimits({ createItem: quota }));
}
await put("backend/components/shared/rate-limits.ts", policySource(12));
const changed = await loadProject(root);
assert.notEqual(changed.version, first.version);
assert.deepEqual(changed.componentScopes.map(scope => scope.mountPath), first.componentScopes.map(scope => scope.mountPath));
assert.deepEqual(changed.componentScopes.map(scope => scope.namespace), first.componentScopes.map(scope => scope.namespace));
for (const value of ["undefined", "null", "{}"] ) {
  await put("backend/components/shared/rate-limits.ts", "export default " + value + ";");
  await assert.rejects(loadProject(root));
}
`);
}, 35_000);

test("published format-1 descriptors load optional policies and preserve old descriptors", async () => {
  await runLoaderTest(`
await put("node_modules/rate-loader-fixture/package.json", JSON.stringify({ name: "rate-loader-fixture", type: "module", exports: { ".": "./setup.js", "./new": "./new.js", "./contracts": "./contracts.js", "./rate-limits": "./rate-limits.js" } }));
await put("node_modules/rate-loader-fixture/contracts.js", "export default {};");
async function publishedSetup(extra) {
  await put("node_modules/rate-loader-fixture/setup.js", 'import { defineComponent, defineComponentPackage } from "kello/server"; export default defineComponentPackage(defineComponent({ name: "published" }), ' + JSON.stringify({ ...descriptor, ...extra }) + ');');
}
await put("backend/app.config.ts", 'import { defineApplication } from "kello/server"; import published from "rate-loader-fixture"; const app = defineApplication({ rpc: ({ os }) => ({ os }) }); app.use(published); export default app;');
await publishedSetup({});
await put("node_modules/rate-loader-fixture/new.js", 'import { defineComponent, defineComponentPackage } from "kello/server"; export default defineComponentPackage(defineComponent({ name: "newPublished" }), ' + JSON.stringify({ ...descriptor, entry: "rate-loader-fixture/new", rateLimits: "rate-loader-fixture/rate-limits" }) + ');');
await put("node_modules/rate-loader-fixture/rate-limits.js", policySource());
const old = await loadProject(root);
assert.deepEqual(old.componentScopes[0].rateLimits, empty);
// Import cache must not hide a descriptor change: use a new owning package entry.
await put("backend/app.config.ts", 'import { defineApplication } from "kello/server"; import published from "rate-loader-fixture/new"; const app = defineApplication({ rpc: ({ os }) => ({ os }) }); app.use(published); export default app;');
const current = await loadProject(root);
assert.deepEqual(current.componentScopes[0].rateLimits, defineRateLimits({ createItem: quota }));
await put("node_modules/rate-loader-fixture/rate-limits.js", policySource(13));
const changed = await loadProject(root);
assert.notEqual(changed.version, current.version);
assert.equal(changed.componentScopes[0].rateLimits.policies.createItem.limit, 13);
await put("node_modules/rate-loader-fixture/rate-limits.js", "export default undefined;");
await assert.rejects(loadProject(root));
`);
}, 35_000);

test("descriptor policy entries reject invalid paths and resolution outside the owning package", async () => {
  await runLoaderTest(`
for (const rateLimits of ["../source", "/private/module", "file:///source", "rate-loader-fixture/../secret"]) {
  assert.throws(() => defineComponentPackage(defineComponent({ name: "invalid" }), { ...descriptor, rateLimits }));
}
const definition = defineComponentPackage(defineComponent({ name: "valid" }), { ...descriptor, rateLimits: "rate-loader-fixture/rate-limits" });
assert.equal(getComponentPackage(definition).rateLimits, "rate-loader-fixture/rate-limits");
await put("node_modules/rate-loader-fixture/package.json", JSON.stringify({ name: "rate-loader-fixture", type: "module", exports: { ".": "./setup.js", "./contracts": "./contracts.js" } }));
await put("node_modules/rate-loader-fixture/contracts.js", "export default {};");
await put("node_modules/rate-loader-fixture/setup.js", 'import { defineComponent, defineComponentPackage } from "kello/server"; export default defineComponentPackage(defineComponent({ name: "published" }), ' + JSON.stringify({ ...descriptor, rateLimits: "another-package/rate-limits" }) + ');');
await put("backend/app.config.ts", 'import { defineApplication } from "kello/server"; import published from "rate-loader-fixture"; const app = defineApplication({ rpc: ({ os }) => ({ os }) }); app.use(published); export default app;');
await assert.rejects(loadProject(root), /declaring package/);
`);
}, 35_000);
