import assert from "node:assert/strict";
import { test } from "bun:test";
import { channel } from "node:diagnostics_channel";
import { randomInt } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DiagnosticsRecord } from "kello/tooling";

const e2e = fileURLToPath(new URL("../", import.meta.url));

// Temp fixtures resolve only public package exports through the existing install.
async function fixture(source: string) {
  const root = await mkdtemp(join(tmpdir(), "kello-diagnostics-"));
  try {
    await symlink(join(e2e, "node_modules"), join(root, "node_modules"), "dir");
    const script = join(root, "child.mjs");
    await writeFile(script, source);
    return { root, script };
  } catch (cause) {
    await rm(root, { recursive: true, force: true });
    throw cause;
  }
}

const nativeServer = String.raw`
import assert from "node:assert/strict";
import { open } from "node:fs/promises";
import { createProjectProcedures, defineSchema } from "kello/server";
import { startDiagnostics, startDevelopmentServer } from "kello/tooling";
import { RPCLink } from "@orpc/client/fetch";

const file = await open(process.argv[2], "wx", 0o600);
let diagnostics;
let server;
let written = 0;
const stops = [];
const origin = "http://localhost:4321";
function runtime(generation) {
  const { procedure } = createProjectProcedures(defineSchema(() => ({})));
  const router = {
    tasks: {
      generation: procedure.handler(() => generation),
      fail: procedure.handler(() => { throw new Error("private-handler-canary"); }),
    },
  };
  return {
    auth: { origins: [origin], allowAnonymous: true, verify: async () => { throw new Error("unused verifier"); } },
    version: String(generation + 1).repeat(64),
    router,
    snapshots: router,
    tickets: {
      issue: async () => ({ ticket: "t".repeat(43), expiresAt: Math.floor(Date.now() / 1000) + 60 }),
      redeem: async () => { throw new Error("unused ticket"); },
    },
    realtime: { heartbeatMs: 1000, maxBufferedBytes: 1024 },
    stop: async () => { stops.push(generation); },
  };
}
try {
  diagnostics = await startDiagnostics({ output: {
    format: "jsonl",
    async write(chunk, signal) {
      if (signal.aborted) return;
      await file.writeFile(chunk);
      if (signal.aborted) return;
      written++;
    },
  } });
  server = await startDevelopmentServer(runtime(0), { port: 0 });
  // Parent publishes its canary while this child's subscriber is active.
  process.stdout.write("ready\n");
  for await (const chunk of process.stdin) break;
  for (let generation = 0; generation < 3; generation++) {
    if (generation > 0) assert.deepEqual(await server.replace(runtime(generation)), { retired: true });
    const link = new RPCLink({
      origin: server.url.origin,
      url: "/api/kello/rpc",
      headers: { origin, "x-loom-protocol": "loom-orpc-2", "x-loom-version": String(generation + 1).repeat(64) },
    });
    assert.equal(await link.call(["tasks", "generation"], undefined, { context: {} }), generation);
    await assert.rejects(link.call(["tasks", "fail"], undefined, { context: {} }), /Internal server error/);
    const deadline = Date.now() + 2000;
    while (written < (generation + 1) * 2 && Date.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(written, (generation + 1) * 2);
    assert.deepEqual(diagnostics.snapshot(), {
      accepted: (generation + 1) * 2, invalid: 0, dropped: 0, outputFailures: 0, exportFailures: 0,
    });
  }
  await server.stop();
  assert.deepEqual(stops, [0, 1, 2]);
  await diagnostics.stop();
} finally {
  try { await server?.stop(); }
  finally {
    try { await diagnostics?.stop(); }
    finally { await file.close(); }
  }
}
`;

test("built diagnostics observe only child-native HTTP RPC once across development generations", async () => {
  const { root, script } = await fixture(nativeServer);
  const artifact = join(root, "diagnostics.jsonl");
  const child = Bun.spawn([process.execPath, script, artifact], {
    cwd: e2e,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = new Response(child.stderr).text();
  const reader = child.stdout.getReader();
  const timeout = setTimeout(() => child.kill("SIGKILL"), 10000);
  try {
    let output = "";
    while (!output.includes("ready\n")) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`Child exited before diagnostics started: ${await stderr}`);
      output += new TextDecoder().decode(chunk.value);
    }
    const canary = randomInt(1_000_000_000, 2_000_000_000);
    channel("kello.runtime.metric").publish({
      type: "rpc.procedure",
      mode: "mutation",
      status: "success",
      durationMs: canary,
    });
    await child.stdin.write("continue\n");
    await child.stdin.end();
    assert.equal(await child.exited, 0, await stderr);
    const text = await readFile(artifact, "utf8");
    assert.ok(!text.includes("private-handler-canary"));
    const records: DiagnosticsRecord[] = text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(records.length, 6);
    assert.deepEqual(
      records.map((record) => record.sequence),
      [1, 2, 3, 4, 5, 6],
    );
    for (const [index, record] of records.entries()) {
      assert.equal(record.schemaVersion, 1);
      assert.equal(record.scope, "local-process");
      assert.equal(record.source, "runtime");
      assert.equal(record.event.type, "rpc.procedure");
      if (record.source !== "runtime" || record.event.type !== "rpc.procedure")
        throw new Error("Expected native RPC event");
      assert.equal(record.event.mode, "finite");
      assert.equal(record.event.status, index % 2 === 0 ? "success" : "error");
      assert.ok(Number.isFinite(record.event.durationMs) && record.event.durationMs >= 0);
      assert.notEqual(record.event.durationMs, canary);
    }
  } finally {
    clearTimeout(timeout);
    child.kill("SIGKILL");
    await child.exited;
    reader.releaseLock();
    await rm(root, { recursive: true, force: true });
  }
}, 15000);

const normalization = String.raw`
import assert from "node:assert/strict";
import { channel } from "node:diagnostics_channel";
import { startDiagnostics } from "kello/tooling";

assert.equal(Number(process.versions.node.split(".")[0]), 24, "Native Node 24 is required");
const outcome = process.argv[2];
const replace = process.argv[3] === "true";
const errors = [];
process.on("unhandledRejection", error => errors.push(String(error)));
const wait = () => new Promise(resolve => setTimeout(resolve, 30));
const pending = Promise.withResolvers();
const observed = Promise.withResolvers();
let reads = 0;
let calls = 0;
let session;
let replacement;
try {
  session = await startDiagnostics({ output: { format: "jsonl", write(chunk, signal) {
    calls++;
    signal.addEventListener("abort", () => observed.resolve(), { once: true });
    return pending.promise;
  } } });
  Object.defineProperty(pending.promise, "constructor", { get() {
    reads++;
    void session.stop();
    return Promise;
  } });
  channel("kello.runtime.metric").publish({ type: "rpc.procedure", mode: "finite", status: "success", durationMs: 1 });
  await observed.promise;
  assert.ok(reads > 0, "Promise constructor getter must actually trigger stop");
  await session.stop();
  let replacementCalls = 0;
  if (replace) replacement = await startDiagnostics({ output: { format: "jsonl", write() { replacementCalls++; } } });
  const before = replacement?.snapshot();
  if (outcome === "resolve") pending.resolve();
  else pending.reject(new Error("late-writer-canary"));
  await wait();
  assert.equal(calls, 1);
  assert.equal(replacementCalls, 0);
  assert.deepEqual(replacement?.snapshot(), before);
  assert.deepEqual(errors, []);
} finally {
  pending.resolve();
  await session?.stop();
  await replacement?.stop();
}
await wait();
assert.deepEqual(errors, []);
`;

for (const outcome of ["resolve", "reject"] as const) {
  for (const replace of [false, true]) {
    test(`Node 24 built diagnostics consume late ${outcome} after constructor-getter stop (replacement=${replace})`, async () => {
      const { root, script } = await fixture(normalization);
      const child = Bun.spawn(["node", script, outcome, String(replace)], {
        cwd: e2e,
        stdout: "pipe",
        stderr: "pipe",
      });
      const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
      try {
        const [stdout, stderr, exit] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        assert.equal(exit, 0, stderr);
        assert.equal(stdout, "");
        assert.equal(stderr, "");
      } finally {
        clearTimeout(timeout);
        child.kill("SIGKILL");
        await child.exited;
        await rm(root, { recursive: true, force: true });
      }
    }, 10000);
  }
}
