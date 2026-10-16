import assert from "node:assert/strict";
import { test } from "bun:test";
import { access, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Writable } from "node:stream";
import * as diagnosticsOutput from "../../../apps/loom/src/tooling/diagnostics/output";

const cli = fileURLToPath(new URL("../../../apps/loom/src/cli.ts", import.meta.url));

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

test("telemetry routing and configuration fail before project evaluation or output creation", async () => {
  const root = await mkdtemp(join(tmpdir(), "kello-telemetry-config-"));
  const secret = "TELEMETRY_SECRET_CANARY";
  const env = { ...process.env, KELLO_TELEMETRY_ENDPOINT: undefined, KELLO_TELEMETRY_BEARER_TOKEN: secret };
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
      ["--telemetry", "otlp"],
      ["dev", "--telemetry", ""],
      ["dev", "--telemetry", "invalid"],
      ["dev", "quarantine", "--telemetry", "otlp"],
      ["doctor", "--telemetry", "otlp"],
      ["login", "--telemetry", "otlp"],
      ["profile", "list", "--telemetry", "otlp"],
      ["generate", "--telemetry", "otlp"],
      ["dev", "extra", "--telemetry", "otlp"],
      ["dev", "--name", "ignored", "--telemetry", "otlp"],
      ["dev", "--diagnostics", "jsonl", "--telemetry", "otlp"],
    ]) {
      const result = await runDiagnosticsCli(root, args, env);
      assert.equal(result.exit, 2, JSON.stringify({ args, ...result }));
      assert.equal(JSON.parse(result.stderr).error.code, "USAGE");
      assert.equal(result.stdout, "");
      assert.ok(!result.stderr.includes(secret));
      await assert.rejects(access(join(root, "evaluated")));
    }
    for (const endpoint of [
      undefined,
      "",
      `https://${secret}.example`,
      `https://user:${secret}@collector.example/v1/metrics`,
      `http://localhost/${secret}`,
      `http://127.1/${secret}`,
      `ftp://127.0.0.1/${secret}`,
      `https://collector.example/v1/metrics?${secret}`,
      `https://collector.example/v1/metrics#${secret}`,
    ]) {
      const result = await runDiagnosticsCli(
        root,
        ["dev", "--telemetry", "otlp", "--diagnostics", "jsonl", "--diagnostics-file", "events.jsonl"],
        { ...env, KELLO_TELEMETRY_ENDPOINT: endpoint },
      );
      assert.equal(result.exit, 2, result.stderr);
      assert.equal(JSON.parse(result.stderr).error.code, "TELEMETRY_CONFIG_INVALID");
      assert.equal(JSON.parse(result.stderr).error.message, "Telemetry configuration is invalid.");
      assert.equal(result.stdout, "");
      assert.ok(!result.stderr.includes(secret));
      await assert.rejects(access(join(root, "evaluated")));
      await assert.rejects(access(join(root, "events.jsonl")));
    }
    const invalidToken = await runDiagnosticsCli(root, ["dev", "--telemetry", "otlp"], {
      ...env,
      KELLO_TELEMETRY_ENDPOINT: "https://collector.example/custom/metrics",
      KELLO_TELEMETRY_BEARER_TOKEN: `${secret}\r\nInjected: value`,
    });
    assert.equal(invalidToken.exit, 2, invalidToken.stderr);
    assert.equal(JSON.parse(invalidToken.stderr).error.code, "TELEMETRY_CONFIG_INVALID");
    assert.ok(!invalidToken.stderr.includes(secret));
    await assert.rejects(access(join(root, "evaluated")));

    const disabled = await runDiagnosticsCli(root, ["dev"], {
      ...env,
      KELLO_TELEMETRY_ENDPOINT: `http://localhost/${secret}`,
    });
    assert.equal(disabled.exit, 5, disabled.stderr);
    assert.equal(JSON.parse(disabled.stderr).error.code, "DEVELOPMENT_FAILED");
    assert.equal(await readFile(join(root, "evaluated"), "utf8"), "evaluated");
    assert.ok(!disabled.stderr.includes(secret));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60000);

test("telemetry failures preserve the disabled CLI exit and explicit consent controls network traffic", async () => {
  const root = await mkdtemp(join(tmpdir(), "kello-telemetry-exit-"));
  let requests = 0;
  let authorization: string | null = null;
  const collector = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests++;
      authorization = request.headers.get("authorization");
      await request.arrayBuffer();
      return new Response("REMOTE_ERROR_CANARY", { status: 503 });
    },
  });
  try {
    await writeFile(join(root, "kello.config.ts"), 'throw new Error("CONFIG_SECRET"); export default {};');
    const env = {
      ...process.env,
      KELLO_TELEMETRY_ENDPOINT: new URL("/v1/metrics", collector.url).href,
      KELLO_TELEMETRY_BEARER_TOKEN: "BEARER_CANARY",
    };
    const disabled = await runDiagnosticsCli(root, ["dev"], env);
    assert.equal(disabled.exit, 5, disabled.stderr);
    assert.equal(requests, 0, "Environment alone never opts in");
    const enabled = await runDiagnosticsCli(root, ["dev", "--telemetry", "otlp"], env);
    assert.equal(enabled.exit, disabled.exit, enabled.stderr);
    assert.equal(JSON.parse(enabled.stderr).error.code, JSON.parse(disabled.stderr).error.code);
    assert.equal(requests, 1, "Startup unwind owns one bounded final export");
    assert.equal(authorization, "Bearer BEARER_CANARY");
    assert.ok(!enabled.stderr.includes("BEARER_CANARY"));
    assert.ok(!enabled.stderr.includes("REMOTE_ERROR_CANARY"));
    assert.equal(enabled.stdout, disabled.stdout);
  } finally {
    await collector.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});

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

test("diagnostics files are cwd-relative exclusive private files and startup failure closes ownership", async () => {
  const root = await mkdtemp(join(tmpdir(), "loom-diagnostics-file-"));
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
    const created = await runDiagnosticsCli(root, [
      "dev",
      "--diagnostics",
      "jsonl",
      "--diagnostics-file",
      "events.jsonl",
    ]);
    assert.equal(created.exit, 5, created.stderr);
    assert.equal(JSON.parse(created.stderr).error.code, "DEVELOPMENT_FAILED");
    assert.equal((await stat(join(root, "events.jsonl"))).mode & 0o777, 0o600);
    assert.equal(await readFile(join(root, "events.jsonl"), "utf8"), "");
    await rm(join(root, "evaluated"));
    await writeFile(join(root, "events.jsonl"), "KEEP");
    await symlink(join(root, "events.jsonl"), join(root, "link.jsonl"));
    await symlink(join(root, "missing.jsonl"), join(root, "dangling.jsonl"));
    for (const file of ["events.jsonl", "link.jsonl", "dangling.jsonl", "missing/events.jsonl"]) {
      const result = await runDiagnosticsCli(root, ["dev", "--diagnostics", "jsonl", "--diagnostics-file", file]);
      assert.equal(result.exit, 2, result.stderr);
      assert.equal(JSON.parse(result.stderr).error.code, "DIAGNOSTICS_OUTPUT_UNAVAILABLE");
      assert.ok(!result.stderr.includes(file));
      assert.ok(!result.stderr.includes(root));
      await assert.rejects(access(join(root, "evaluated")));
    }
    assert.equal(await readFile(join(root, "events.jsonl"), "utf8"), "KEEP");
    await assert.rejects(access(join(root, "missing")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 15000);

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

test("runCli startup failures release diagnostics ownership and signal handlers between invocations", async () => {
  const root = await mkdtemp(join(tmpdir(), "loom-diagnostics-unwind-"));
  try {
    await writeFile(join(root, "kello.config.ts"), 'throw new Error("CONFIG_SECRET"); export default {};');
    const runner = join(root, "runner.ts");
    await writeFile(
      runner,
      `
      import { runCli } from ${JSON.stringify(cli)};
      import { channel } from "node:diagnostics_channel";
      const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
      const exits = [];
      for (const file of ["first.jsonl", "second.jsonl"]) {
        exits.push(await runCli(["dev", "--cwd", ${JSON.stringify(root)}, "--json", "--diagnostics", "jsonl", "--diagnostics-file", file]));
        if (channel("kello.runtime.metric").hasSubscribers || channel("kello.deployment.metric").hasSubscribers)
          throw new Error("Retained subscriber");
      }
      console.log(JSON.stringify({ before, after: [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")], exits }));
    `,
    );
    const child = Bun.spawn([process.execPath, runner], { stdout: "pipe", stderr: "pipe" });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
    try {
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      assert.equal(exit, 0, stderr);
      const result = JSON.parse(stdout);
      assert.deepEqual(result.exits, [5, 5]);
      assert.deepEqual(result.after, result.before);
      assert.equal((stderr.match(/DEVELOPMENT_FAILED/g) ?? []).length, 2);
      assert.ok(!stderr.includes("CONFIG_SECRET"));
    } finally {
      clearTimeout(timeout);
      child.kill("SIGKILL");
      await child.exited;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runCli keeps diagnostics in the owning child through failed edits and both signals", async () => {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    for (const mode of [undefined, "text", "jsonl"] as const) {
      const root = await mkdtemp(join(tmpdir(), "loom-diagnostics-lifetime-"));
      const structured = mode !== "text";
      try {
        await writeFile(
          join(root, "session.json"),
          JSON.stringify({
            format: 1,
            databaseName: "neondb",
            migrationRole: "owner",
            runtimeRole: "runtime",
            deployment: "local",
            activationTokenEnv: "LOOM_TEST_DEV_TOKEN",
            port: 0,
          }),
        );
        async function edit(durationMs: number) {
          await writeFile(
            join(root, "kello.config.ts"),
            `
            import { channel } from "node:diagnostics_channel";
            import { writeFileSync } from "node:fs";
            const metric = channel("kello.runtime.metric");
            writeFileSync(${JSON.stringify(join(root, "subscriber"))}, String(metric.hasSubscribers));
            metric.publish({ type: "rpc.procedure", mode: "finite", status: "success", durationMs: ${durationMs}, secret: "CONFIG_SECRET" });
            await new Promise(resolve => setTimeout(resolve, 30));
            throw new Error("CONFIG_SECRET");
            export default {};
          `,
          );
        }
        await edit(1);
        const flags = mode ? ["--diagnostics", mode] : [];
        if (mode === "jsonl") flags.push("--diagnostics-file", "events.jsonl");
        const child = Bun.spawn(
          [
            process.execPath,
            cli,
            "dev",
            "--development",
            "session.json",
            "--cwd",
            root,
            ...flags,
            ...(structured ? ["--json"] : []),
          ],
          {
            stdout: "pipe",
            stderr: "pipe",
            env: { ...process.env, LOOM_TEST_DEV_TOKEN: "a".repeat(64) },
          },
        );
        const output = new Response(child.stdout).text();
        const reader = child.stderr.getReader();
        let errors = "";
        const timeout = setTimeout(() => child.kill("SIGKILL"), 8000);
        try {
          for (let revision = 1; revision <= 2; revision++) {
            while ((errors.match(/DEVELOPMENT_UPDATE_FAILED/g) ?? []).length < revision) {
              const chunk = await reader.read();
              if (chunk.done) throw new Error(`CLI exited before edit ${revision}: ${errors}`);
              errors += new TextDecoder().decode(chunk.value);
            }
            if (revision === 1) await edit(2);
          }
          assert.equal(await readFile(join(root, "subscriber"), "utf8"), String(mode !== undefined));
          child.kill(signal);
          assert.equal(await child.exited, 0, errors);
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            errors += new TextDecoder().decode(chunk.value);
          }
          const stdout = await output;
          assert.ok(stdout.includes(structured ? '"event":"watching"' : "Watching development sources."));
          assert.ok(stdout.includes(structured ? '"event":"stopped"' : "Development stopped."));
          assert.ok(!stdout.includes("rpc.procedure"));
          assert.ok(!errors.includes("CONFIG_SECRET"));
          if (mode === "jsonl") {
            const lines = (await readFile(join(root, "events.jsonl"), "utf8"))
              .trim()
              .split("\n")
              .map((line) => JSON.parse(line));
            assert.equal(lines.length, 2);
            assert.deepEqual(
              lines.map((record) => record.event.durationMs),
              [1, 2],
            );
            assert.ok(
              lines.every(
                (record) =>
                  record.scope === "local-process" && record.source === "runtime" && record.schemaVersion === 1,
              ),
            );
            assert.ok(!errors.includes("rpc.procedure"));
          } else {
            assert.equal((errors.match(/rpc.procedure/g) ?? []).length, mode === "text" ? 2 : 0);
            await assert.rejects(access(join(root, "events.jsonl")));
          }
        } finally {
          clearTimeout(timeout);
          child.kill("SIGKILL");
          await child.exited;
          reader.releaseLock();
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  }
}, 30000);

test("development CLI validates declarations and keeps failed initial edits watchable until shutdown", async () => {
  const root = await mkdtemp(join(tmpdir(), "loom-dev-cli-"));
  const cli = fileURLToPath(new URL("../../../apps/loom/src/cli.ts", import.meta.url));
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
    await run(["dev", "quarantine"], 5, "DEVELOPMENT_QUARANTINE_FAILED");
    for (const args of [
      ["dev", "extra"],
      ["dev", "quarantine", "extra"],
      ["dev", "quarantine", "--dry-run"],
      ["dev", "--dry-run"],
      ["dev", "--name", "ignored"],
      ["doctor", "--development", "kello.dev.json"],
    ])
      await run(args, 2, "USAGE");
    const declaration = {
      format: 1,
      databaseName: "neondb",
      migrationRole: "owner",
      runtimeRole: "runtime",
      deployment: "local",
      activationTokenEnv: "LOOM_TEST_DEV_TOKEN",
      port: 0,
      storage: {
        projectId: "project",
        branchId: "br-development",
        endpoint: "https://br-development.storage.c-1.us-east-2.aws.neon.tech",
        region: "us-east-2",
        accessKeyIdEnv: "LOOM_TEST_STORAGE_ACCESS",
        secretAccessKeyEnv: "LOOM_TEST_STORAGE_SECRET",
      },
    };
    for (const invalid of [
      { ...declaration, format: 2 },
      { ...declaration, activationTokenEnv: "LOOM_MISSING_DEV_TEST_TOKEN" },
      { ...declaration, activationTokenEnv: "NEON_API_KEY" },
      { ...declaration, port: 65536 },
      { ...declaration, password: "sensitive-fixture-value" },
      { ...declaration, storage: { ...declaration.storage, secretAccessKeyEnv: "NEON_API_KEY" } },
      { ...declaration, storage: { ...declaration.storage, accessKeyIdEnv: "LOOM_TEST_DEV_TOKEN" } },
      { ...declaration, storage: { ...declaration.storage, accessKeyIdEnv: "LOOM_MISSING_DEV_TEST_TOKEN" } },
      { ...declaration, storage: { ...declaration.storage, secretAccessKeyEnv: "LOOM_TEST_STORAGE_ACCESS" } },
      {
        ...declaration,
        storage: { ...declaration.storage, endpoint: "https://br-other.storage.c-1.us-east-2.aws.neon.tech" },
      },
      { ...declaration, storage: { ...declaration.storage, secretAccessKey: "sensitive-fixture-value" } },
    ]) {
      await writeFile(join(root, "kello.dev.json"), JSON.stringify(invalid));
      await run(["dev"], 5, "DEVELOPMENT_FAILED");
    }
    await run(["dev", "--development", "../outside.json"], 5, "DEVELOPMENT_FAILED");
    await writeFile(join(root, "session.json"), JSON.stringify(declaration));
    await writeFile(join(root, "kello.config.ts"), 'throw new Error("sensitive-fixture-value"); export default {};');
    const child = Bun.spawn([process.execPath, cli, "dev", "--development", "session.json", "--cwd", root, "--json"], {
      stdout: "pipe",
      stderr: "pipe",
      env,
    });
    const output = new Response(child.stdout).text();
    const reader = child.stderr.getReader();
    let errors = "";
    const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
    try {
      while (!errors.includes("DEVELOPMENT_UPDATE_FAILED")) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error(`Development exited before reporting an edit failure: ${errors}`);
        errors += new TextDecoder().decode(chunk.value);
      }
      child.kill("SIGTERM");
      assert.equal(await child.exited, 0);
      const stdout = await output;
      assert.ok(stdout.includes('"event":"watching"'));
      assert.ok(stdout.includes('"event":"stopped"'));
      assert.ok(!errors.includes("sensitive-fixture-value"));
      assert.ok(!stdout.includes(env.LOOM_TEST_DEV_TOKEN));
    } finally {
      clearTimeout(timeout);
      child.kill("SIGKILL");
      await child.exited;
      reader.releaseLock();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 15000);
