import assert from "node:assert/strict";
import { test } from "bun:test";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Writable } from "node:stream";
import * as diagnosticsOutput from "../../../apps/kello-cli/src/tooling/diagnostics/output";

const cli = fileURLToPath(new URL("../../../apps/kello-cli/src/cli.ts", import.meta.url));

async function runDiagnosticsCli(root: string, args: string[], env?: Record<string, string | undefined>) {
  const child = Bun.spawn([process.execPath, cli, ...args, "--cwd", root, "--json"], {
    stdout: "pipe",
    stderr: "pipe",
    env: env ?? process.env,
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exit };
}

test("telemetry disabled does not read its environment secrets", async () => {
  const root = await mkdtemp(join(tmpdir(), "kello-telemetry-disabled-"));
  try {
    await writeFile(join(root, "kello.config.ts"), 'throw new Error("CONFIG_SECRET"); export default {};');
    const runner = join(root, "runner.ts");
    await writeFile(
      runner,
      `
      import { runCli } from ${JSON.stringify(cli)};
      let reads = 0;
      process.env = new Proxy(process.env, {
        get(target, key) {
          if (key === "KELLO_TELEMETRY_ENDPOINT" || key === "KELLO_TELEMETRY_BEARER_TOKEN") {
            reads++;
            throw new Error("TELEMETRY_SECRET_READ");
          }
          return target[key];
        }
      });
      const exit = await runCli(["dev", "--cwd", ${JSON.stringify(root)}, "--json"]);
      console.log(JSON.stringify({ exit, reads }));
    `,
    );
    const child = Bun.spawn([process.execPath, runner], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    assert.equal(exit, 0, stderr);
    assert.deepEqual(JSON.parse(stdout), { exit: 5, reads: 0 });
    assert.ok(!stderr.includes("TELEMETRY_SECRET_READ"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("owned file output completes partial writes and never submits a suffix after cancellation", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<{ bytesWritten: number }>();
  const chunks: string[] = [];
  let closes = 0;
  const file = diagnosticsOutput.createFileOutput({
    async write(bytes) {
      chunks.push(new TextDecoder().decode(bytes));
      if (chunks.length === 1) {
        entered.resolve();
        return release.promise;
      }
      return { bytesWritten: bytes.byteLength };
    },
    async close() {
      closes++;
    },
  });
  const controller = new AbortController();
  const writing = file.write("abcdef", controller.signal);
  await entered.promise;
  controller.abort();
  const rejected = assert.rejects(writing);
  release.resolve({ bytesWritten: 2 });
  await rejected;
  assert.deepEqual(chunks, ["abcdef"]);
  assert.equal(await file.close(), "closed");
  assert.equal(closes, 1);

  const complete: string[] = [];
  const partial = diagnosticsOutput.createFileOutput({
    async write(bytes) {
      complete.push(new TextDecoder().decode(bytes));
      return { bytesWritten: Math.min(2, bytes.byteLength) };
    },
    async close() {},
  });
  await partial.write("abcdef", new AbortController().signal);
  assert.deepEqual(complete, ["abcdef", "cdef", "ef"]);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(partial.write("never", aborted.signal));
  assert.equal(complete.length, 3);
  await partial.close();
});

test("owned stderr output waits for callback and drain and removes listeners on abort or error", async () => {
  let callback: ((error?: Error | null) => void) | undefined;
  const stream = new Writable({
    highWaterMark: 1,
    write(_chunk, _encoding, done) {
      callback = done;
    },
  });
  const controller = new AbortController();
  let settled = false;
  const writing = diagnosticsOutput.writeStderrOutput(stream, "line", controller.signal).then(() => {
    settled = true;
  });
  stream.emit("drain");
  await Promise.resolve();
  assert.equal(settled, false);
  callback?.();
  await writing;
  assert.equal(stream.listenerCount("drain"), 0);
  assert.equal(stream.listenerCount("error"), 0);
  assert.equal(stream.destroyed, false);

  const blocked = diagnosticsOutput.writeStderrOutput(stream, "blocked", controller.signal);
  const rejected = assert.rejects(blocked);
  controller.abort();
  await rejected;
  assert.equal(stream.listenerCount("drain"), 0);
  assert.equal(stream.listenerCount("error"), 1);
  callback?.();
  assert.equal(stream.listenerCount("error"), 0);
  await assert.rejects(diagnosticsOutput.writeStderrOutput(stream, "never", controller.signal));
  assert.equal(stream.destroyed, false);
  const failed = diagnosticsOutput.writeStderrOutput(stream, "error", new AbortController().signal);
  const failure = assert.rejects(failed);
  stream.emit("error", new Error("fixture"));
  await failure;
  callback?.();
  assert.equal(stream.listenerCount("drain"), 0);
  assert.equal(stream.listenerCount("error"), 0);

  const unpressured = new Writable({
    write(_chunk, _encoding, done) {
      callback = done;
    },
  });
  settled = false;
  const completed = diagnosticsOutput.writeStderrOutput(unpressured, "line", new AbortController().signal).then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false);
  callback?.();
  await completed;
  assert.equal(unpressured.listenerCount("drain"), 0);
  assert.equal(unpressured.listenerCount("error"), 0);
  const callbackError = new Writable({
    write(_chunk, _encoding, done) {
      queueMicrotask(() => done(new Error("fixture callback")));
    },
  });
  await assert.rejects(diagnosticsOutput.writeStderrOutput(callbackError, "error", new AbortController().signal));
  assert.equal(callbackError.listenerCount("drain"), 0);
  assert.equal(callbackError.listenerCount("error"), 0);
});

test("stderr cancellation contains a submitted write's late native error", async () => {
  let callback: ((error?: Error | null) => void) | undefined;
  const stream = new Writable({
    write(_chunk, _encoding, done) {
      callback = done;
    },
  });
  const controller = new AbortController();
  const rejected = assert.rejects(diagnosticsOutput.writeStderrOutput(stream, "line", controller.signal));
  controller.abort();
  await rejected;
  assert.equal(stream.listenerCount("drain"), 0);
  callback?.(new Error("late-stream-error"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(stream.listenerCount("error"), 0);
});

test("owned file output reports a pending close at its deadline and closes only after settlement", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<{ bytesWritten: number }>();
  const closed = Promise.withResolvers<void>();
  let submissions = 0;
  let closes = 0;
  const file = diagnosticsOutput.createFileOutput({
    async write() {
      submissions++;
      entered.resolve();
      return release.promise;
    },
    async close() {
      closes++;
      closed.resolve();
    },
  });
  const controller = new AbortController();
  const writing = file.write("abcdef", controller.signal);
  const rejected = assert.rejects(writing);
  await entered.promise;
  controller.abort();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    assert.equal(
      await Promise.race([
        file.close(performance.now() - 1),
        new Promise((resolve) => {
          timeout = setTimeout(() => resolve("budget-restarted"), 100);
        }),
      ]),
      "pending",
    );
    assert.equal(closes, 0);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    release.resolve({ bytesWritten: 2 });
    await rejected;
  }
  await closed.promise;
  assert.equal(closes, 1);
  assert.equal(submissions, 1);
}, 5000);

test("development CLI refuses invalid declarations before watching and never leaks their contents", async () => {
  const root = await mkdtemp(join(tmpdir(), "loom-dev-cli-"));
  const cli = fileURLToPath(new URL("../../../apps/kello-cli/src/cli.ts", import.meta.url));
  const env = {
    ...process.env,
    LOOM_TEST_DEV_TOKEN: "a".repeat(64),
    LOOM_TEST_STORAGE_ACCESS: "fixture-access",
    LOOM_TEST_STORAGE_SECRET: "sensitive-fixture-value",
  };
  async function run(args: string[], expected: number, code: string) {
    const child = Bun.spawn([process.execPath, cli, ...args, "--cwd", root, "--json"], {
      stdout: "pipe",
      stderr: "pipe",
      env,
    });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    assert.equal(exit, expected);
    assert.equal(stdout, "");
    assert.ok(stderr.includes(`"code":"${code}"`), stderr);
    assert.ok(!stderr.includes("sensitive-fixture-value"));
  }
  try {
    await writeFile(join(root, "kello.dev.json"), '{"activationToken":"sensitive-fixture-value"}');
    await run(["dev"], 5, "DEVELOPMENT_FAILED");
    await run(["dev", "--development", "kello.dev.json"], 5, "DEVELOPMENT_FAILED");
    for (const args of [
      ["dev", "extra"],
      // Local database quarantine was removed with local backend serving.
      ["dev", "quarantine"],
      ["dev", "--dry-run"],
      ["dev", "--name", "ignored"],
      ["doctor", "--development", "kello.dev.json"],
    ])
      await run(args, 2, "USAGE");
    await run(["dev", "--development", "../outside.json"], 5, "DEVELOPMENT_FAILED");
    await writeFile(join(root, "kello.config.ts"), 'throw new Error("sensitive-fixture-value"); export default {};');
    await run(["dev"], 5, "DEVELOPMENT_FAILED");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 15000);
test("diagnostics routing rejects invalid options before evaluating config", async () => {
  const root = await mkdtemp(join(tmpdir(), "loom-diagnostics-routing-"));
  try {
    await writeFile(
      join(root, "kello.config.ts"),
      `
      import { writeFileSync } from "node:fs";
      writeFileSync(${JSON.stringify(join(root, "evaluated"))}, "evaluated");
      throw new Error("CONFIG_SECRET");
      export default {};
    `,
    );
    for (const args of [
      ["--diagnostics", "text"],
      ["dev", "--diagnostics", "jsonl"],
      ["dev", "--diagnostics-file", "events.jsonl"],
      ["dev", "--diagnostics", "text", "--diagnostics-file", "events.jsonl"],
      ["dev", "--diagnostics", "invalid"],
      ["dev", "--diagnostics", "jsonl", "--diagnostics-file", ""],
      ["dev", "quarantine", "--diagnostics", "text"],
      ["doctor", "--diagnostics", "text"],
      ["login", "--diagnostics", "text"],
      ["profile", "list", "--diagnostics-file", "events.jsonl"],
      ["generate", "--diagnostics", "text"],
    ]) {
      const result = await runDiagnosticsCli(root, args);
      assert.equal(result.exit, 2, JSON.stringify({ args, ...result }));
      assert.equal(result.stdout, "");
      assert.equal(JSON.parse(result.stderr).error.code, "USAGE");
      await assert.rejects(access(join(root, "evaluated")));
      await assert.rejects(access(join(root, "events.jsonl")));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 15000);

test("removed dev diagnostics and telemetry flags fail before config, file creation or network access", async () => {
  const root = await mkdtemp(join(tmpdir(), "kello-dev-removed-options-"));
  try {
    await writeFile(join(root, "kello.config.ts"), 'throw new Error("CONFIG_CANARY");');
    for (const flags of [
      ["--diagnostics", "text"],
      ["--diagnostics", "jsonl", "--diagnostics-file", "events.jsonl"],
      ["--telemetry", "otlp"],
    ]) {
      const result = await runDiagnosticsCli(root, ["dev", ...flags]);
      assert.equal(result.exit, 2);
      assert.equal(result.stdout, "");
      assert.ok(result.stderr.includes('"code":"USAGE"'));
      assert.ok(!result.stderr.includes("CONFIG_CANARY"));
      await assert.rejects(access(join(root, "events.jsonl")));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
