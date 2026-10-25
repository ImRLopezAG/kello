import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, appendFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";
import * as v from "valibot";
import {
  packedFullTextNodeConsumer,
  packedFullTextNodeFiles,
  packedFullTextNodeInitialize,
  packedFullTextNodePreflight,
} from "../fixtures/packed-search-full-text-node";

// SOURCE-ONLY until the parent freezes/reviews this unit and grants execution.
// Prerequisite: parent-built/frozen dist and dependencies. Never build here.
// Parent must supply an absolute KELLO_NODE24_EXECUTABLE; no PATH guess/npx.
test("packed public full-text consumer executes under independently pinned Node 24", async () => {
  const errors: unknown[] = [];
  const started = performance.now();
  const deadline = started + 360_000;
  let createdRoot: string | undefined;
  let root: string | undefined;
  let receiptPath: string | undefined;
  let ownershipSettled = true;
  let completed = false;
  let commands = 0;
  let packageChecksum: string | undefined;
  const stamp = () => ({ observedAt: new Date().toISOString(), monotonicElapsedMs: performance.now() - started });
  const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  function summary(cause: unknown) {
    const code = v.safeParse(v.object({ code: v.pipe(v.string(), v.regex(/^[A-Z0-9_]+$/)) }), cause);
    // No env values, arbitrary error messages/stacks or subprocess argv/output.
    return {
      name: cause instanceof Error ? cause.name : "UnknownError",
      code: cause instanceof Error && code.success ? code.output.code : undefined,
    };
  }
  async function emit<Receipt extends object>(record: Receipt, failures: unknown[]) {
    const value = { ...record, ...stamp() };
    if (receiptPath !== undefined) {
      try {
        await appendFile(receiptPath, JSON.stringify(value) + "\n");
      } catch (cause) {
        failures.push(new Error("receipt append failed", { cause }));
      }
    }
    // Parent's log retains these receipts after successful root removal.
    try {
      console.info(JSON.stringify(value));
    } catch (cause) {
      failures.push(new Error("receipt publication failed", { cause }));
    }
  }
  function requireNoErrors(failures: unknown[], message: string) {
    if (failures.length) throw new AggregateError(failures, message);
  }
  function contained(parent: string, child: string) {
    const path = relative(parent, child);
    return path !== "" && !isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`);
  }

  try {
    assert.notEqual(
      process.platform,
      "win32",
      "POSIX detached group ownership is required; no platform success inferred",
    );
    assert.ok(process.versions.bun, "this orchestrator is Bun; the consumer is a separate Node child");
    createdRoot = await mkdtemp(join(tmpdir(), "kello-packed-full-text-node-"));
    // Record exact returned root inside try, before canonicalization can fail.
    await emit({ proof: "packed-full-text-node-root-created", root: createdRoot }, errors);
    requireNoErrors(errors, "root creation receipt failed");
    root = await realpath(createdRoot);
    const ownedRoot = root;
    receiptPath = join(root, "commands.jsonl");
    await writeFile(receiptPath, "", { flag: "wx" });
    await emit({ proof: "packed-full-text-node-root-owned", createdRoot, root, receiptPath }, errors);
    requireNoErrors(errors, "root ownership receipt failed");
    const requestedNode = process.env.KELLO_NODE24_EXECUTABLE;
    assert.ok(requestedNode && isAbsolute(requestedNode), "supply an absolute pinned KELLO_NODE24_EXECUTABLE");
    const nodeExecutable = await realpath(requestedNode);
    const bunExecutable = await realpath(process.execPath);
    assert.notEqual(nodeExecutable, bunExecutable, "Node consumer must not reuse the Bun executable");
    for (const executable of [nodeExecutable, bunExecutable]) {
      assert.equal((await stat(executable)).isFile(), true);
      await access(executable, constants.X_OK);
    }
    await mkdir(join(root, "home"));
    await mkdir(join(root, "tmp"));
    await mkdir(join(root, "cache"));
    // Do not forward provider/DB credentials or NODE_OPTIONS/loader injections.
    // Package install cache/home/temp writes stay inside this owned root.
    const childEnvironment = {
      PATH: `${dirname(bunExecutable)}${sep === "/" ? ":" : ";"}${process.env.PATH ?? ""}`,
      HOME: join(root, "home"),
      TMPDIR: join(root, "tmp"),
      XDG_CACHE_HOME: join(root, "cache"),
      BUN_INSTALL_CACHE_DIR: join(root, "cache/bun"),
    };
    await emit(
      {
        proof: "packed-full-text-node-orchestrator",
        runtime: "Bun",
        execPath: bunExecutable,
        bun: process.versions.bun,
        version: process.version,
        nodeExecutable,
        ownershipScope: "direct child close and initial detached group only; no full ancestry/PID-reuse proof",
      },
      errors,
    );
    requireNoErrors(errors, "orchestrator receipt failed");

    async function run(label: string, argv: string[], limitMs: number, cwd: string) {
      assert.ok(ownershipSettled, "never start dependent work while ownership is unresolved");
      const remaining = deadline - performance.now();
      // Reserve close and group settlement inside the overall deadline.
      assert.ok(remaining > 10_000, "finite fixture command deadline exhausted");
      const commandLimitMs = Math.min(limitMs, remaining - 10_000);
      const failures: unknown[] = [];
      type FailureCategory =
        | "group-observation"
        | "group-kill"
        | "output-limit"
        | "pipe"
        | "execution-timeout"
        | "close-unresolved"
        | "spawn"
        | "unexpected"
        | "ownership-unresolved"
        | "exit"
        | "stdout-persistence"
        | "stderr-persistence";
      const failureCategories: FailureCategory[] = [];
      function fail(category: FailureCategory, cause: unknown) {
        failureCategories.push(category);
        failures.push(cause);
      }
      const commandStarted = performance.now();
      const commandStartedAt = new Date().toISOString();
      const observations: object[] = [];
      let numericPid: number | null = null;
      let numericPgid: number | null = null;
      let groupState: "no-child" | "unknown" | "present" | "absent" | "unavailable" = "unknown";
      let closed = false;
      let closeObservation: object | null = null;
      let stdout = "";
      let stderr = "";
      let outputBytes = 0;
      let outputExceeded = false;
      let captureIncomplete = false;
      let timedOut = false;
      function observe(phase: string) {
        let error: ReturnType<typeof summary> | undefined;
        groupState = numericPgid === null ? "no-child" : "unknown";
        if (numericPgid !== null) {
          try {
            process.kill(-numericPgid, 0);
            groupState = "present";
          } catch (cause) {
            if (cause instanceof Error && "code" in cause && cause.code === "ESRCH") groupState = "absent";
            else {
              groupState = "unavailable";
              error = summary(cause);
              fail("group-observation", new Error("group observation unavailable", { cause }));
            }
          }
        }
        observations.push({
          phase,
          numericPgid,
          state: groupState,
          error,
          observedAt: new Date().toISOString(),
          monotonicElapsedMs: performance.now() - commandStarted,
        });
        return groupState;
      }
      function killOwnedGroup() {
        if (numericPgid === null) return;
        try {
          process.kill(-numericPgid, "SIGKILL");
        } catch (cause) {
          if (!(cause instanceof Error && "code" in cause && cause.code === "ESRCH"))
            fail("group-kill", new Error("owned group kill failed", { cause }));
        }
      }
      function cancel(category: FailureCategory, reason: string) {
        fail(category, new Error(reason));
        killOwnedGroup();
        observe("after-cancellation");
      }
      const executable = argv[0];
      assert.ok(executable);
      let child: ReturnType<typeof spawn> | undefined;
      let result: { code: number | null; signal: NodeJS.Signals | null } | undefined;
      let commandTimer: ReturnType<typeof setTimeout> | undefined;
      let closeTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        child = spawn(executable, argv.slice(1), {
          cwd,
          env: childEnvironment,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
        ownershipSettled = false;
        numericPid = child.pid ?? null;
        numericPgid = numericPid;
        const closedResult = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
          child!.once("error", (cause) => {
            fail("spawn", new Error("spawn failed", { cause }));
          });
          child!.once("close", (code, signal) => {
            closed = true;
            closeObservation = {
              code,
              signal,
              observedAt: new Date().toISOString(),
              monotonicElapsedMs: performance.now() - commandStarted,
            };
            resolve({ code, signal });
          });
        });
        observe("after-spawn");
        function collect(chunk: string, stream: "stdout" | "stderr") {
          outputBytes += Buffer.byteLength(chunk);
          if (outputBytes > 1_048_576) {
            if (!outputExceeded) {
              outputExceeded = true;
              cancel("output-limit", "subprocess output exceeded one MiB");
            }
            return;
          }
          if (stream === "stdout") stdout += chunk;
          else stderr += chunk;
        }
        child.stdout!.setEncoding("utf8").on("data", (chunk: string) => collect(chunk, "stdout"));
        child.stderr!.setEncoding("utf8").on("data", (chunk: string) => collect(chunk, "stderr"));
        for (const stream of [child.stdout!, child.stderr!]) {
          stream.on("error", (cause) => {
            captureIncomplete = true;
            fail("pipe", new Error("subprocess pipe failed", { cause }));
            cancel("pipe", "subprocess pipe failure requires cancellation");
          });
        }
        commandTimer = setTimeout(() => {
          timedOut = true;
          cancel("execution-timeout", "subprocess finite deadline exceeded");
        }, commandLimitMs);
        const closeDeadline = new Promise<undefined>((resolve) => {
          closeTimer = setTimeout(() => resolve(undefined), commandLimitMs + 5_000);
        });
        result = await Promise.race([closedResult, closeDeadline]);
        // The command/close race has ended. Its timers must not fire during
        // the separate, unchanged group-settlement allowance below.
        clearTimeout(commandTimer);
        clearTimeout(closeTimer);
        if (result === undefined) {
          captureIncomplete = true;
          cancel("close-unresolved", "direct child close unresolved; retain root");
          // No more commands or cleanup; pending promise has no rejection and
          // remains explicitly unresolved. Detach pipe/event-loop authority.
          child.stdout!.destroy();
          child.stderr!.destroy();
          child.unref();
        } else {
          const state = observe("post-close");
          if (state === "present") {
            killOwnedGroup();
            const groupDeadline = performance.now() + 5_000;
            while (observe("settlement-poll") === "present" && performance.now() < groupDeadline) {
              await new Promise<void>((resolve) => setTimeout(resolve, 25));
            }
          }
          const finalState = observe("settlement-final");
          ownershipSettled = closed && (finalState === "absent" || (numericPid === null && finalState === "no-child"));
        }
      } catch (cause) {
        fail("unexpected", cause);
        // A synchronous spawn throw creates no child. Anything after a launch
        // stays unresolved and retained; never assume catch implies settlement.
        if (child === undefined) {
          observe("spawn-threw");
          ownershipSettled = true;
        } else {
          captureIncomplete = true;
          killOwnedGroup();
          observe("unexpected-error");
          child.stdout?.destroy();
          child.stderr?.destroy();
          child.unref();
        }
      } finally {
        if (commandTimer !== undefined) clearTimeout(commandTimer);
        if (closeTimer !== undefined) clearTimeout(closeTimer);
      }
      if (!ownershipSettled)
        fail("ownership-unresolved", new Error("known process ownership unresolved; root retained"));
      if (result?.code !== 0 || result?.signal != null) fail("exit", new Error("subprocess did not exit successfully"));
      commands++;
      // Keep arbitrary child diagnostics private, bounded and recoverable.
      // Each write is attempted independently; neither can mask primary errors.
      // These are captured snapshots, not a claim that unresolved streams ended.
      const captureFlags = { truncated: outputExceeded, incomplete: captureIncomplete || !closed };
      const captures = [
        { stream: "stdout", bytes: Buffer.from(stdout, "utf8"), ...captureFlags },
        { stream: "stderr", bytes: Buffer.from(stderr, "utf8"), ...captureFlags },
      ] as const;
      const outputs = [];
      for (const { stream, bytes, truncated, incomplete } of captures) {
        const path = join(ownedRoot, `command-${commands}-${stream}.log`);
        let persisted = false;
        try {
          await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
          persisted = true;
        } catch (cause) {
          fail(
            stream === "stdout" ? "stdout-persistence" : "stderr-persistence",
            new Error("private output persistence failed", { cause }),
          );
        }
        outputs.push({
          stream,
          path,
          sha256: hash(bytes),
          retainedBytes: bytes.byteLength,
          persisted,
          truncated,
          incomplete,
        });
      }
      await emit(
        {
          proof: "packed-full-text-node-command",
          ordinal: commands,
          label,
          argv,
          cwd,
          commandStartedAt,
          commandEndedAt: new Date().toISOString(),
          commandElapsedMs: performance.now() - commandStarted,
          commandLimitMs,
          closeAllowanceMs: 5_000,
          groupAllowanceMs: 5_000,
          numericPid,
          numericPgid,
          pgidBasis: "POSIX detached spawn; initial PGID assumed equal to direct PID",
          groupState,
          observations,
          closeObservation,
          closed,
          ownershipSettled,
          code: result?.code ?? null,
          signal: result?.signal ?? null,
          timedOut,
          outputExceeded,
          outputBytes,
          stdoutSha256: hash(stdout),
          stderrSha256: hash(stderr),
          outputs,
          failureCategories,
          failures: failures.map(summary),
        },
        failures,
      );
      requireNoErrors(failures, `owned command failed: ${label}`);
      return stdout;
    }

    function parseProof(stdout: string, expected: string) {
      const lines = stdout.trim().split("\n");
      assert.equal(lines.length, 1, "Node child must emit exactly one structured proof");
      const proof = JSON.parse(lines[0]!);
      assert.equal(proof.proof, expected);
      return proof;
    }
    const preflight = parseProof(
      await run(
        "node24-preflight",
        [nodeExecutable, "--input-type=module", "-e", packedFullTextNodePreflight],
        10_000,
        root,
      ),
      "packed-full-text-node-runtime",
    );
    assert.equal(preflight.phase, "preflight");
    assert.match(preflight.version, /^v24\./);
    assert.match(preflight.node, /^24\./);
    assert.equal(await realpath(preflight.execPath), nodeExecutable);
    await emit(preflight, errors);
    requireNoErrors(errors, "Node preflight receipt failed");
    const packageRoot = fileURLToPath(new URL("../../../apps/kello/", import.meta.url));
    const tarball = join(root, "kello.tgz");
    await run(
      "pack-built-public-package",
      [bunExecutable, "pm", "pack", "--filename", tarball, "--ignore-scripts"],
      30_000,
      packageRoot,
    );
    const bytes = await readFile(tarball);
    packageChecksum = hash(bytes);
    await emit(
      {
        proof: "packed-full-text-node-package",
        tarball,
        algorithm: "sha256",
        checksum: packageChecksum,
        bytes: bytes.byteLength,
      },
      errors,
    );
    requireNoErrors(errors, "package checksum receipt failed");
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        private: true,
        type: "module",
        dependencies: {
          kello: "file:./kello.tgz",
          "drizzle-orm": "1.0.0-rc.4",
          "@orpc/client": "2.0.0-beta.46",
          "@orpc/server": "2.0.0-beta.46",
          "@orpc/tanstack-query": "2.0.0-beta.46",
          "@tanstack/react-query": "5.104.3",
          react: "19.3.0",
          "react-dom": "19.3.0",
          valibot: "1.5.0",
          effect: "4.0.5",
        },
      }),
      { flag: "wx" },
    );
    await run(
      "isolated-public-install",
      [bunExecutable, "install", "--ignore-scripts", "--linker", "isolated"],
      120_000,
      root,
    );
    const installedPackage = await realpath(join(root, "node_modules/kello"));
    assert.ok(contained(root, installedPackage), "installed tarball must stay inside owned root");
    await writeFile(join(root, "initialize.mjs"), packedFullTextNodeInitialize, { flag: "wx" });
    await run("public-initialize-Bun", [bunExecutable, "initialize.mjs"], 30_000, root);
    for (const [path, source] of Object.entries(packedFullTextNodeFiles)) {
      assert.doesNotMatch(source, /apps\/kello\/src|@ts-ignore|@ts-expect-error/);
      await writeFile(join(root, path), source);
    }
    // Explicit Bun runtime for the public CLI's documented Bun shebang.
    await run(
      "public-cli-generate-Bun",
      [bunExecutable, join(root, "node_modules/kello/cli.js"), "generate", "--cwd", join(root, "app")],
      60_000,
      root,
    );
    const current = join(root, "app/kello/_generated/current");
    assert.equal((await lstat(current)).isSymbolicLink(), true);
    const generations = await realpath(join(root, "app/.kello/generations"));
    const currentGeneration = await realpath(current);
    assert.ok(contained(root, generations));
    assert.ok(contained(root, currentGeneration));
    const generationVersion = relative(generations, currentGeneration);
    assert.match(generationVersion, /^[a-f0-9]{64}$/);
    assert.equal((await stat(currentGeneration)).isDirectory(), true);
    for (const name of ["api.js", "config.js"]) {
      assert.ok(contained(root, await realpath(join(root, "app/kello/_generated", name))));
    }
    await emit(
      {
        proof: "packed-full-text-node-generation",
        current,
        currentGeneration,
        generations,
        generationVersion,
        installedPackage,
      },
      errors,
    );
    requireNoErrors(errors, "generation receipt failed");
    await writeFile(
      join(root, "identity.json"),
      JSON.stringify({ nodeExecutable, installedPackage, currentGeneration, generationVersion }),
      { flag: "wx" },
    );
    assert.doesNotMatch(packedFullTextNodeConsumer, /apps\/kello\/src|@ts-ignore|@ts-expect-error|\bas (?!const\b)/);
    await writeFile(join(root, "consumer.mjs"), packedFullTextNodeConsumer, { flag: "wx" });
    const consumer = parseProof(
      await run("actual-node24-mjs-consumer", [nodeExecutable, join(root, "consumer.mjs")], 30_000, root),
      "packed-full-text-node-consumer",
    );
    assert.match(consumer.runtime.version, /^v24\./);
    assert.match(consumer.runtime.node, /^24\./);
    assert.equal(await realpath(consumer.runtime.execPath), nodeExecutable);
    assert.equal(consumer.currentGeneration, currentGeneration);
    assert.equal(consumer.generationVersion, generationVersion);
    assert.equal(consumer.databaseExecution, false);
    assert.equal(consumer.caseCount, 34);
    assert.equal(consumer.cases.length, 34);
    assert.equal(new Set(consumer.cases).size, 34);
    assert.equal(commands, 6);
    await emit(consumer, errors);
    requireNoErrors(errors, "consumer receipt failed");
    completed = true;
  } catch (cause) {
    errors.push(cause);
  } finally {
    if (createdRoot !== undefined) {
      if (completed && ownershipSettled && errors.length === 0) {
        try {
          // Await filesystem settlement. No timeout race abandons an in-flight
          // rm, and no cleanup receipt is emitted before this promise resolves.
          await rm(createdRoot, { recursive: true, force: true, maxRetries: 0 });
          receiptPath = undefined;
          await emit(
            { proof: "packed-full-text-node-root-cleanup", root: createdRoot, canonicalRoot: root, removed: true },
            errors,
          );
        } catch (cause) {
          errors.push(new Error("owned root removal failed; root state unresolved", { cause }));
          await emit(
            {
              proof: "packed-full-text-node-root-retained",
              root: createdRoot,
              canonicalRoot: root,
              state: "removal-failed-may-be-partial",
              ownershipSettled,
              errors: errors.map(summary),
            },
            errors,
          );
        }
      } else {
        await emit(
          {
            proof: "packed-full-text-node-root-retained",
            root: createdRoot,
            canonicalRoot: root,
            state: "retained-no-removal-attempt",
            ownershipSettled,
            completed,
            errors: errors.map(summary),
          },
          errors,
        );
      }
    }
  }
  requireNoErrors(errors, "packed Node consumer gate failed; inspect retained ownership receipts");
  // Positive completion follows successful awaited cleanup and publication.
  await emit(
    {
      proof: "packed-full-text-node-complete",
      commands,
      caseCount: 34,
      packageChecksum,
      ownershipSettled,
      rootRemoved: true,
      databaseExecution: false,
    },
    errors,
  );
  requireNoErrors(errors, "completion receipt publication failed");
}, 420_000);
