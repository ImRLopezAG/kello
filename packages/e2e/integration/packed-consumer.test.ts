import assert from "node:assert/strict";
import { test } from "bun:test";
import { access, cp, mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("fresh workspace installation links the CLI before compiled output exists", async () => {
  const source = fileURLToPath(new URL("../../../apps/kello/", import.meta.url));
  const manifest = await Bun.file(join(source, "package.json")).json();
  const workspaceLock = await readFile(new URL("../../../bun.lock", import.meta.url), "utf8");
  assert.match(workspaceLock, /"bin":\s*\{\s*"kello": "cli\.js"/);
  const root = await mkdtemp(join(tmpdir(), "loom-workspace-bin-"));
  try {
    await mkdir(join(root, "apps/kello"), { recursive: true });
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ private: true, workspaces: ["apps/*"], dependencies: { kello: "workspace:*" } }),
    );
    await writeFile(
      join(root, "apps/kello/package.json"),
      JSON.stringify({ name: manifest.name, version: manifest.version, bin: manifest.bin, type: "module" }),
    );
    // Copy committed package files, with no prebuilt dist output.
    if (!manifest.bin.kello.startsWith("./bin/")) {
      await cp(join(source, manifest.bin.kello), join(root, "apps/kello", manifest.bin.kello));
    }
    assert.equal(await Bun.file(join(root, "apps/kello/bin/kello.js")).exists(), false);
    const child = Bun.spawn(["bun", "install", "--ignore-scripts"], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 60000,
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    assert.equal(code, 0, `${stdout}\n${stderr}`);
    await access(join(root, "node_modules/.bin/kello"));
    assert.equal(await Bun.file(join(root, "apps/kello/dist/cli.js")).exists(), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("packed tooling preserves migration and bucket privacy patches without consumer configuration", async () => {
  const publicManifest = await Bun.file(new URL("../../../apps/kello/package.json", import.meta.url)).json();
  assert.equal(publicManifest.name, "kello");
  assert.match(publicManifest.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  assert.equal(publicManifest.bin.kello, "cli.js");
  assert(!Object.keys(publicManifest.dependencies).some((name) => name.startsWith("@kello/")));
  const root = await mkdtemp(join(tmpdir(), "loom-packed-consumer-"));
  async function run(command: string[], cwd = root) {
    const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe", timeout: 60000 });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    assert.equal(code, 0, `${command.join(" ")}\n${stdout}\n${stderr}`);
    return stdout;
  }
  try {
    await run(
      ["bun", "pm", "pack", "--filename", join(root, "kello.tgz"), "--ignore-scripts"],
      fileURLToPath(new URL("../../../apps/kello/", import.meta.url)),
    );
    const entries = (await run(["tar", "-tzf", join(root, "kello.tgz")])).trim().split("\n");
    assert(
      entries.every(
        (path) =>
          path === "package/package.json" ||
          path.startsWith("package/dist/") ||
          path === "package/cli.js" ||
          path === "package/README.md" ||
          path === "package/LICENSE",
      ),
    );
    for (const required of ["package/README.md", "package/LICENSE"]) assert(entries.includes(required), required);
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        private: true,
        type: "module",
        dependencies: { kello: "file:./kello.tgz" },
        devDependencies: { "@types/node": "24.13.6" },
      }),
    );
    await run(["bun", "install", "--ignore-scripts", "--linker", "isolated"]);
    await run(["bun", "install", "--ignore-scripts", "--frozen-lockfile"]);
    const frontend = join(root, "frontend");
    await mkdir(frontend);
    await writeFile(join(frontend, "package.json"), '{"name":"existing-next","private":true}\n');
    const executable = join(root, "node_modules/.bin/kello");
    const preview = JSON.parse(await run([executable, "integrate", "--cwd", frontend, "--json"]));
    assert.equal(preview.applied, false);
    assert(preview.files.includes("kello/app.config.ts"));
    const integrated = JSON.parse(await run([executable, "integrate", "--cwd", frontend, "--apply", "--json"]));
    assert.equal(integrated.applied, true);
    assert.equal(await readFile(join(frontend, "package.json"), "utf8"), '{"name":"existing-next","private":true}\n');
    assert.deepEqual(
      JSON.parse(await run([executable, "integrate", "--cwd", frontend, "--apply", "--json"])).files,
      [],
    );
    await run([executable, "generate", "--cwd", frontend]);
    const proposed = JSON.parse(
      await run([
        executable,
        "create",
        "--cwd",
        root,
        "--name",
        "preview",
        "--region",
        "aws-us-east-1",
        "--dry-run",
        "--json",
      ]),
    );
    assert.equal(proposed.dryRun, true);
    assert.match(await readFile(join(root, "node_modules/kello/dist/cli.js"), "utf8"), /^#!\/usr\/bin\/env bun/);
    assert.match(await readFile(join(root, "node_modules/kello/dist/core/react/index.js"), "utf8"), /^"use client";/);
    const browserForbidden = [
      "startDiagnostics",
      "kello.diagnostics.session.v1",
      "kello.runtime.metric",
      "kello.deployment.metric",
      "resourceMetrics",
      "otlp-http-json",
      "node:",
    ];
    await writeFile(
      join(root, "browser-exports.mjs"),
      'export * as client from "kello/client"; export * as react from "kello/react";\n',
    );
    // Retain every public export; optional UI peers are outside the Kello boundary.
    const browserExports = await Bun.build({
      entrypoints: [join(root, "browser-exports.mjs")],
      target: "browser",
      external: ["react", "@tanstack/react-query"],
    });
    assert.equal(browserExports.success, true);
    assert(browserExports.outputs.length > 0);
    for (const output of browserExports.outputs) {
      const code = await output.text();
      for (const forbidden of browserForbidden) assert(!code.includes(forbidden), forbidden);
    }
    await writeFile(
      join(root, "diagnostics.ts"),
      `import assert from "node:assert/strict";
import { channel } from "node:diagnostics_channel";
import { startDiagnostics } from "kello/tooling";
import type {
  DiagnosticsOptions, DiagnosticsSession, DiagnosticsStats, DiagnosticsRecord,
  DiagnosticsRuntimeEvent, DiagnosticsDeploymentEvent,
} from "kello/tooling";
// @ts-expect-error diagnostics are tooling-only, including their declaration surface
import type { startDiagnostics as ClientDiagnostics } from "kello/client";
// @ts-expect-error diagnostics are not a React export
import type { startDiagnostics as ReactDiagnostics } from "kello/react";
if (process.argv[2] === "node") {
  assert.equal("Bun" in globalThis, false);
  assert.equal(process.versions.node.split(".")[0], "24");
} else assert.equal("Bun" in globalThis, true);
const runtime = channel("kello.runtime.metric");
const deployment = channel("kello.deployment.metric");
assert.equal(runtime.hasSubscribers, false);
assert.equal(deployment.hasSubscribers, false);
const runtimeEvent: DiagnosticsRuntimeEvent = { type: "rpc.procedure", mode: "finite", status: "success", durationMs: 7 };
const deploymentEvent: DiagnosticsDeploymentEvent = { type: "release.acknowledgement", stage: "complete", status: "recorded" };
const lines: string[] = [];
const signals: AbortSignal[] = [];
const { promise: observed, resolve: received } = Promise.withResolvers<void>();
const options: DiagnosticsOptions = { output: { format: "jsonl", write(chunk, signal) {
  lines.push(chunk);
  signals.push(signal);
  if (lines.length === 2) received();
} } };
// Exercise the telemetry option declaration without enabling a network sink.
const telemetry: NonNullable<DiagnosticsOptions["telemetry"]> = {
  protocol: "otlp-http-json", endpoint: "http://127.0.0.1:4318/v1/metrics", bearerToken: "fixture-only",
};
assert.equal(telemetry.protocol, "otlp-http-json");
const session: DiagnosticsSession = await startDiagnostics(options);
try {
  assert.equal(runtime.hasSubscribers, true);
  assert.equal(deployment.hasSubscribers, true);
  runtime.publish({ ...runtimeEvent, secret: "PACKED_DIAGNOSTICS_SECRET" });
  deployment.publish({ ...deploymentEvent, secret: "PACKED_DIAGNOSTICS_SECRET" });
  await observed;
  const records: DiagnosticsRecord[] = lines.map(line => {
    assert(line.endsWith("\\n"));
    return JSON.parse(line);
  });
  assert.deepEqual(records.map(record => ({ source: record.source, event: record.event })), [
    { source: "runtime", event: runtimeEvent }, { source: "deployment", event: deploymentEvent },
  ]);
  records.forEach((record, index) => {
    assert.deepEqual(Object.keys(record).sort(), ["event", "schemaVersion", "scope", "sequence", "source", "timestamp"]);
    assert.equal(record.schemaVersion, 1);
    assert.equal(record.scope, "local-process");
    assert.equal(record.sequence, index + 1);
    assert.equal(new Date(record.timestamp).toISOString(), record.timestamp);
  });
  assert(!lines.join("").includes("PACKED_DIAGNOSTICS_SECRET"));
  const stats = session.snapshot();
  const publicStats: Readonly<DiagnosticsStats> = stats;
  assert.deepEqual(publicStats, { accepted: 2, invalid: 0, dropped: 0, outputFailures: 0, exportFailures: 0 });
  // @ts-expect-error snapshots are readonly in the public declarations
  stats.accepted = 0;
  assert.equal(session.snapshot().accepted, 2);
} finally {
  const stopping: Promise<void> = session.stop();
  assert.equal(session.stop(), stopping);
  assert(signals.every(signal => signal.aborted));
  assert.equal(runtime.hasSubscribers, false);
  assert.equal(deployment.hasSubscribers, false);
  await stopping;
}
const stopped = session.snapshot();
runtime.publish(runtimeEvent);
deployment.publish(deploymentEvent);
assert.deepEqual(session.snapshot(), stopped);
assert.equal(lines.length, 2);
const replacement: DiagnosticsSession = await startDiagnostics(options);
try {
  assert.deepEqual(replacement.snapshot(), { accepted: 0, invalid: 0, dropped: 0, outputFailures: 0, exportFailures: 0 });
} finally { await replacement.stop(); }
assert.equal(runtime.hasSubscribers, false);
assert.equal(deployment.hasSubscribers, false);
`,
    );
    await writeFile(
      join(root, "diagnostics.tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ESNext",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          exactOptionalPropertyTypes: true,
          skipLibCheck: true,
          types: ["node"],
          outDir: "diagnostics-dist",
          noEmitOnError: true,
        },
        include: ["diagnostics.ts"],
      }),
    );
    await run([
      fileURLToPath(new URL("../../../node_modules/.bin/tsc", import.meta.url)),
      "-p",
      join(root, "diagnostics.tsconfig.json"),
    ]);
    await run(["bun", "diagnostics-dist/diagnostics.js", "bun"]);
    await run(["node", "diagnostics-dist/diagnostics.js", "node"]);
    await writeFile(
      join(root, "without-react.mjs"),
      `
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { realpathSync, rmSync } from "node:fs";
import { dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
// Neon SDK peers can install React; remove it to prove backend exports work without it.
try {
  const react = dirname(realpathSync(require.resolve("react/package.json")));
  assert(react.startsWith(dirname(fileURLToPath(import.meta.url)) + sep));
  rmSync(react, { recursive: true });
} catch (error) {
  if (error.code !== "MODULE_NOT_FOUND") throw error;
}
assert.throws(() => import.meta.resolve("react"));
await import("kello/client");
await import("kello/contract");
await import("kello/server");
`,
    );
    await run(["node", "without-react.mjs"]);
    for (const name of [
      "README.md",
      "neon-config.LICENSE",
      "neon-config-runtime.LICENSE",
      "drizzle-kit@1.0.0-rc.4.patch",
      "@neon%2Fconfig@1.9.2.patch",
    ]) {
      assert((await readFile(join(root, "node_modules/kello/dist/third-party", name), "utf8")).length > 0);
    }
    await writeFile(
      join(root, "verify.mjs"),
      `import assert from "node:assert/strict";
import { defineSchema, defineTable } from "kello/server";
import { createEffectRuntime, Invocation } from "kello/server";
import { defineContract, resolveContract, oc } from "kello/contract";
import { call, implement } from "@orpc/server";
import { Effect, Layer } from "effect";
import { z } from "zod";
import * as v from "valibot";
import { createSnapshot, planMigration, defineConfig, prepareNeonStorageBuckets } from "kello/tooling";
if (!("Bun" in globalThis)) assert.equal(process.versions.node.split(".")[0], "24");
const contract = resolveContract(defineContract({ hello: oc.input(z.object({ name: z.string() })).output(v.string()) }), { validators: { tables: {}, id: () => v.string() } });
const hello = implement(contract).hello.handler(({ input }) => input.name);
assert.equal(await call(hello, { name: "Kello" }), "Kello");
await assert.rejects(call(hello, { name: 42 }), { code: "BAD_REQUEST" });
await assert.rejects(call(implement(contract).hello.handler(() => 42), { name: "Kello" }), { code: "INTERNAL_SERVER_ERROR" });
const runtime = createEffectRuntime(Layer.empty);
try {
  const owners = await Promise.all(["alice", "bob"].map(subject => runtime.run({ identity: { issuer: "packed", subject }, requestId: subject }, Effect.gen(function* () { return (yield* Invocation).identity.subject; }))));
  assert.deepEqual(owners, ["alice", "bob"]);
} finally { await runtime.stop(); }
const before = await createSnapshot(defineSchema(s => ({ notes: defineTable({ title: s.text().notNull() }) }), { namespace: "app" }));
const after = defineSchema(s => ({ notes: defineTable({ heading: s.text().notNull() }) }), { namespace: "app" });
await assert.rejects(planMigration(before, after));
const renamed = await planMigration(before, after, [{type:"rename",kind:"column",from:["app","notes","title"],to:["app","notes","heading"]}]);
assert.match(renamed.statements.join("\\n"), /RENAME COLUMN/);
assert.doesNotMatch(renamed.statements.join("\\n"), /DROP COLUMN/);
const originalFetch = globalThis.fetch;
let access = "private";
let reads = 0;
process.env.NEON_API_KEY = "packed-fixture-only";
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  assert.equal(request.method, "GET");
  assert.equal(request.headers.get("authorization"), "Bearer packed-fixture-only");
  const path = new URL(request.url).pathname;
  if (path.endsWith("/buckets")) { reads += 1; return Response.json({ buckets: [{ name: "uploads", ...(access === "missing" ? {} : { access_level: access }) }] }); }
  if (path.endsWith("/branches")) return Response.json({ branches: [{ id:"br-preview",name:"preview",default:false,protected:false }] });
  if (path.endsWith("/endpoints")) return Response.json({ endpoints: [{ id:"ep-preview",branch_id:"br-preview",type:"read_write",suspend_timeout_seconds:300 }] });
  if (path.endsWith("/projects/project")) return Response.json({ project: { id:"project",name:"example",region_id:"aws-us-east-1",pg_version:18 } });
  throw new Error("Unexpected fixture request");
};
try {
  const config = defineConfig({ project:"example", provider:{projectId:"project",targets:{preview:{branchId:"br-preview",protected:false}}} });
  const options = { config, environment:"preview", buckets:["uploads"] };
  assert.equal((await prepareNeonStorageBuckets(options)).buckets[0].accessLevel, "private");
  for (access of ["public_write", "missing", "public_read"]) {
    const before = reads;
    await assert.rejects(prepareNeonStorageBuckets(options));
    assert(reads > before);
  }
} finally { globalThis.fetch = originalFetch; delete process.env.NEON_API_KEY; }

`,
    );
    await run(["bun", "verify.mjs"]);
    await run(["node", "verify.mjs"]);
    await run([join(root, "node_modules/.bin/kello"), "--help"]);
    const login = Bun.spawn([join(root, "node_modules/.bin/kello"), "login", "--json"], {
      cwd: root,
      env: { ...process.env, CI: "true" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    assert.equal(await login.exited, 6);
    assert.equal(JSON.parse(await new Response(login.stderr).text()).error.code, "NEON_LOGIN_REQUIRED");
    const worker = Bun.spawn(["bun", join(root, "node_modules/kello/dist/tooling/neon/credential-worker.js")], {
      cwd: root,
      env: {
        ...process.env,
        CI: "true",
        DEBUG: "",
        LOOM_NEON_CREDENTIAL_REQUEST: JSON.stringify({
          profile: "DEFAULT",
          configDir: join(root, "empty-neon-profile"),
        }),
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    assert.equal(await worker.exited, 0);
    assert.deepEqual(JSON.parse(await new Response(worker.stdout).text()), { code: "NEON_LOGIN_REQUIRED" });
    await writeFile(
      join(root, "generate-native.mjs"),
      `import assert from "node:assert/strict";
import { initializeProject, generateProject, saveResolvedProject } from "kello/tooling";
await initializeProject("./native", "native");
await saveResolvedProject("./native", {
  format: 1, projectId: "project-fixture", branchId: "br-fixture", branchName: "dev", protected: false, isDefault: false,
  databaseName: "neondb", migrationRole: "neondb_owner", public: { serviceUrl: "https://functions.example.test/service", authUrl: "https://auth.example.test/auth" },
});
const result = await generateProject("./native");
assert.equal(result.protocol, "loom-orpc-2");
const { configuration } = await import("./native/kello/_generated/api.js");
assert.deepEqual(configuration, { serviceUrl: "https://functions.example.test/service", authUrl: "https://auth.example.test/auth" });
await saveResolvedProject("./native", {
  format: 1, projectId: "project-fixture", branchId: "br-fixture", branchName: "dev", protected: false, isDefault: false,
  databaseName: "neondb", migrationRole: "neondb_owner", public: { serviceUrl: "https://functions.example.test/updated" },
});
assert.equal((await generateProject("./native")).version, result.version);
assert.deepEqual(result.procedures, [{path:["tasks","list"],visibility:"public"}]);
const browser = await Bun.build({entrypoints:["./native/kello/_generated/api.js"],target:"browser"});
assert.equal(browser.success, true);
assert(browser.outputs.length > 0);
for (const output of browser.outputs) {
  const code = await output.text();
  for (const forbidden of ${JSON.stringify(browserForbidden)}) assert(!code.includes(forbidden), forbidden);
}
`,
    );
    await run(["bun", "generate-native.mjs"]);
    await run([join(root, "node_modules/.bin/kello"), "generate", "--cwd", join(root, "native")]);
    await run([
      fileURLToPath(new URL("../../../node_modules/.bin/tsc", import.meta.url)),
      "-p",
      join(root, "native/tsconfig.json"),
    ]);
    const variants = join(root, "variants");
    await cp(fileURLToPath(new URL("../../examples/integrations/", import.meta.url)), variants, {
      recursive: true,
      filter: (path) =>
        !["node_modules", "_generated", ".loom", ".turbo", "dist", "package.json", "tsconfig.json"].includes(
          path.split("/").at(-1) ?? "",
        ),
    });
    await writeFile(
      join(variants, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ESNext",
          module: "Preserve",
          moduleResolution: "Bundler",
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          types: ["node"],
          exactOptionalPropertyTypes: true,
        },
        include: ["kello/**/*.ts", "types/**/*.ts", "kello.config.ts"],
      }),
    );
    await writeFile(
      join(root, "generate-variants.mjs"),
      'import { generateProject } from "kello/tooling"; await generateProject("./variants");',
    );
    await run(["bun", "generate-variants.mjs"]);
    await run([
      fileURLToPath(new URL("../../../node_modules/.bin/tsc", import.meta.url)),
      "-p",
      join(variants, "tsconfig.json"),
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 120000);
