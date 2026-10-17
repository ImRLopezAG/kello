import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, lstat, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { basename, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";
import {
  packedFullTextBrowser,
  packedFullTextFiles,
  packedFullTextNegativeCases,
  packedFullTextPositive,
  packedFullTextRuntime,
} from "../fixtures/packed-search-full-text";

// The parent must build the accepted package before invoking this gate. This
// test does not build source, connect to a database, or claim browser/provider
// behavior. Its browser proof is the actual generated public bundle only.
test("packed generated full-text search preserves native inference and public boundaries", async () => {
  assert.notEqual(process.platform, "win32", "this owned-process-group fixture requires POSIX");
  const root = await realpath(await mkdtemp(join(tmpdir(), "kello-packed-full-text-")));
  const deadline = Date.now() + 600_000;
  let ownershipSettled = true;
  let completed = false;
  let commands = 0;
  const receipts = join(root, "commands.jsonl");

  function groupExists(pid: number) {
    try {
      process.kill(-pid, 0);
      return true;
    } catch (cause) {
      if (cause instanceof Error && "code" in cause && cause.code === "ESRCH") return false;
      throw cause;
    }
  }
  function killGroup(pid: number) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch (cause) {
      if (!(cause instanceof Error && "code" in cause && cause.code === "ESRCH")) throw cause;
    }
  }
  type CommandFailure = { kind: string; cause: unknown };
  async function recordCommand<Receipt extends object>(receipt: Receipt, failures: CommandFailure[]) {
    const describeFailures = () =>
      failures.map(({ kind, cause }) => ({
        kind,
        error: cause instanceof Error ? (cause.stack ?? String(cause)) : String(cause),
      }));
    commands++;
    try {
      await appendFile(receipts, JSON.stringify({ ...receipt, failures: describeFailures() }) + "\n");
    } catch (cause) {
      failures.push({ kind: "receipt-write", cause });
    }
    console.info(JSON.stringify({ ...receipt, failures: describeFailures() }));
    if (failures.length) {
      throw new AggregateError(
        failures.map(({ kind, cause }) => new Error(kind, { cause })),
        `packed command failed: ${JSON.stringify(receipt)}; failures: ${JSON.stringify(describeFailures())}`,
      );
    }
  }
  async function run(command: string[], cwd = root, requireSuccess = false) {
    const remaining = deadline - Date.now();
    assert.ok(remaining > 0, "packed full-text fixture exhausted its finite ten-minute deadline");
    const executable = command[0];
    assert.ok(executable);
    const started = Date.now();
    const startedAt = new Date(started).toISOString();
    const monotonicStart = performance.now();
    const failures: CommandFailure[] = [];
    type GroupObservation = {
      phase: string;
      observedAt: string;
      monotonicElapsedMs: number;
      pgid: number | null;
      state: "no-child" | "unknown" | "present" | "group-absent" | "query-error";
      error?: string;
    };
    const groupObservations: GroupObservation[] = [];
    // POSIX detached spawn makes the direct child's PID its initial PGID.
    // This is an assumption from spawn's contract, not a getpgid observation.
    // kill(-PGID, 0) observes only that group, not full descendant ancestry.
    let childPid: number | null = null;
    let initialPgid: number | null = null;
    let groupState: GroupObservation["state"] = "unknown";
    function observeGroup(phase: string) {
      const observation: GroupObservation = {
        phase,
        observedAt: new Date().toISOString(),
        monotonicElapsedMs: performance.now() - monotonicStart,
        pgid: initialPgid,
        state: initialPgid === null ? "no-child" : "unknown",
      };
      try {
        if (initialPgid !== null) observation.state = groupExists(initialPgid) ? "present" : "group-absent";
        return observation.state === "present";
      } catch (cause) {
        observation.state = "query-error";
        observation.error = cause instanceof Error ? (cause.stack ?? String(cause)) : String(cause);
        throw cause;
      } finally {
        groupState = observation.state;
        groupObservations.push(observation);
      }
    }
    function provenance() {
      return {
        startedAt,
        endedAt: new Date().toISOString(),
        monotonicElapsedMs: performance.now() - monotonicStart,
        childPid,
        initialPgid,
        pgidBasis: "POSIX detached spawn: initial PGID assumed equal to direct child PID",
        groupProbe: "kill(-initialPgid, 0); ESRCH means group absent at observation time",
        groupState,
        groupObservations,
      };
    }
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(executable, command.slice(1), { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (cause) {
      failures.push({ kind: "spawn", cause });
      observeGroup("spawn-threw");
      await recordCommand(
        {
          proof: "packed-full-text-command",
          command,
          cwd,
          ...provenance(),
          code: null,
          signal: null,
          stdout: "",
          stderr: "",
          timedOut: false,
          closeObservation: null,
          closed: false,
          ownershipSettled,
          elapsedMs: Date.now() - started,
        },
        failures,
      );
      throw cause;
    }
    ownershipSettled = false;
    childPid = child.pid ?? null;
    initialPgid = childPid;
    try {
      observeGroup("after-spawn");
    } catch (cause) {
      failures.push({ kind: "group-observation", cause });
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let closed = false;
    let closeObservation: {
      observedAt: string;
      monotonicElapsedMs: number;
      code: number | null;
      signal: NodeJS.Signals | null;
    } | null = null;
    child.stdout!.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr!.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    const closedResult = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once("error", (cause) => {
        failures.push({ kind: "spawn", cause });
      });
      child.once("close", (code, signal) => {
        closed = true;
        closeObservation = {
          observedAt: new Date().toISOString(),
          monotonicElapsedMs: performance.now() - monotonicStart,
          code,
          signal,
        };
        resolve({ code, signal });
      });
    });
    const timeout = setTimeout(
      () => {
        timedOut = true;
        failures.push({ kind: "primary", cause: new Error("subprocess exceeded its finite deadline") });
        try {
          if (child.pid !== undefined) killGroup(child.pid);
        } catch (cause) {
          failures.push({ kind: "kill", cause });
        }
        try {
          observeGroup("after-timeout-kill-attempt");
        } catch (cause) {
          failures.push({ kind: "group-observation", cause });
        }
      },
      Math.min(120_000, remaining),
    );
    // SIGKILL must be followed by observed close, never a race that deletes a
    // directory while a compiler/install child still owns it. A pipe-holding
    // descendant also prevents close; the second deadline retains the fixture.
    let settlementTimer: ReturnType<typeof setTimeout> | undefined;
    const unsettled = new Promise<never>((_, reject) => {
      settlementTimer = setTimeout(
        () => reject(new Error("subprocess did not close after its kill deadline")),
        Math.min(120_000, remaining) + 5_000,
      );
    });
    let result: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    try {
      result = await Promise.race([closedResult, unsettled]);
    } catch (cause) {
      failures.push({ kind: "pending-close", cause });
    } finally {
      clearTimeout(timeout);
      if (settlementTimer !== undefined) clearTimeout(settlementTimer);
    }
    if (result !== undefined) {
      try {
        if (observeGroup("post-close") && child.pid !== undefined) {
          try {
            killGroup(child.pid);
          } catch (cause) {
            failures.push({ kind: "kill", cause });
          }
          const settleDeadline = Date.now() + 5_000;
          while (observeGroup("settlement-poll") && Date.now() < settleDeadline)
            await new Promise((resolve) => setTimeout(resolve, 25));
          assert.equal(
            observeGroup("settlement-final"),
            false,
            "subprocess descendants remain owned; retain temporary fixture",
          );
        }
        ownershipSettled = closed;
      } catch (cause) {
        failures.push({ kind: "settlement", cause });
      }
    } else {
      try {
        observeGroup("close-unresolved");
      } catch (cause) {
        failures.push({ kind: "group-observation", cause });
      }
    }
    if (!ownershipSettled)
      failures.push({
        kind: "ownership",
        cause: new Error("subprocess ownership remains unresolved; retain temporary fixture"),
      });
    if (result?.signal != null)
      failures.push({ kind: "primary", cause: new Error(`subprocess terminated by signal ${result.signal}`) });
    if (requireSuccess && result !== undefined && result.code !== 0)
      failures.push({ kind: "primary", cause: new Error(`subprocess exited ${result.code}\n${stdout}${stderr}`) });
    const receipt = {
      proof: "packed-full-text-command",
      command,
      cwd,
      ...result,
      stdout,
      stderr,
      timedOut,
      ...provenance(),
      closeObservation,
      closed,
      ownershipSettled,
      elapsedMs: Date.now() - started,
    };
    await recordCommand(receipt, failures);
    assert.ok(result, "subprocess close result must be observed");
    return { code: result.code, output: stdout + stderr };
  }
  async function succeed(command: string[], cwd = root) {
    return run(command, cwd, true);
  }

  try {
    const packageRoot = fileURLToPath(new URL("../../../apps/kello/", import.meta.url));
    const tarball = join(root, "kello.tgz");
    await succeed(["bun", "pm", "pack", "--filename", tarball, "--ignore-scripts"], packageRoot);
    const bytes = await readFile(tarball);
    console.info(
      JSON.stringify({
        proof: "packed-full-text-package",
        algorithm: "sha256",
        checksum: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.byteLength,
      }),
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
        devDependencies: {
          "vite-plus": "1.0.0",
          typescript: "7.0.2",
          "@types/node": "24.19.0",
          "@types/react": "19.3.0",
        },
      }),
    );
    await succeed(["bun", "install", "--ignore-scripts", "--linker", "isolated"]);
    const installed = await realpath(join(root, "node_modules/kello"));
    assert.ok(installed.startsWith(root + sep), "consumer must resolve its isolated tarball, not a workspace link");
    await writeFile(
      join(root, "initialize.mjs"),
      `import { initializeProject, saveResolvedProject } from "kello/tooling";
await initializeProject("./app", "packed-full-text");
await saveResolvedProject("./app", { format: 1, projectId: "fixture", branchId: "br-fixture", branchName: "dev", protected: false, isDefault: false, databaseName: "neondb", migrationRole: "neondb_owner", public: { serviceUrl: "https://packed-full-text.example.test" } });
`,
    );
    await succeed(["bun", "initialize.mjs"]);
    for (const [path, source] of Object.entries(packedFullTextFiles)) {
      assert.doesNotMatch(source, /apps\/kello\/src|@ts-ignore|@ts-expect-error/);
      await writeFile(join(root, path), source);
    }
    // Sole generation route: the installed public CLI, with authored contracts
    // and real paginate/watch handlers. No source tooling import substitution.
    await succeed([join(root, "node_modules/.bin/kello"), "generate", "--cwd", join(root, "app")]);
    const generated = join(root, "app/kello/_generated");
    const current = join(generated, "current");
    assert.equal((await lstat(current)).isSymbolicLink(), true, "public generation must activate its current symlink");
    const generations = await realpath(join(root, "app/.kello/generations"));
    const currentTarget = await realpath(current);
    assert.ok(generations.startsWith(root + sep), "generation storage must stay in the isolated consumer");
    assert.ok(currentTarget.startsWith(root + sep), "current must resolve inside the isolated consumer");
    assert.match(
      relative(generations, currentTarget),
      /^[a-f0-9]{64}$/,
      "current must target an owned generation version",
    );
    assert.equal((await stat(currentTarget)).isDirectory(), true);
    const checkedDeclarations: string[] = [];
    async function checkDeclarations(directory: string) {
      assert.ok((await realpath(directory)).startsWith(root + sep), "declaration traversal must stay isolated");
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isSymbolicLink()) assert.equal(path, current, "only the verified current symlink may be traversed");
        else if (entry.isDirectory()) await checkDeclarations(path);
        else if (entry.name.endsWith(".d.ts")) {
          const source = await readFile(path, "utf8");
          assert.doesNotMatch(source, /apps\/kello\/src/);
          const checked = path.replace(/\.d\.ts$/, ".checked.ts");
          await writeFile(checked, source);
          checkedDeclarations.push(checked);
        }
      }
    }
    await checkDeclarations(generated);
    // Dirent.isDirectory() excludes symlinks. Traverse this verified public
    // entry explicitly and list its copies as compiler roots below.
    await checkDeclarations(current);
    assert.ok(
      checkedDeclarations.some((path) => path.endsWith(`${sep}current${sep}api.checked.ts`)),
      "generated native declarations must be checked as source",
    );
    assert.doesNotMatch(packedFullTextPositive, /@ts-ignore|@ts-expect-error|apps\/kello\/src|\bas (?!const\b)/);
    await writeFile(join(root, "positive.ts"), packedFullTextPositive);
    // Legal counterparts catch same-line false reds (for example a missing
    // native infinite option). They compile with the positive inference proof.
    await writeFile(
      join(root, "controls.ts"),
      `import { createClient } from "./app/kello/_generated/api";
const { client, rpc } = createClient({ getToken: async () => null });
const literal = { fullText: { document: "content", query: "database" }, columns: { title: true } } as const;
${packedFullTextNegativeCases.map((item, index) => `function control${index}() { ${item.control} }`).join("\n")}
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
    let negativeCompiles = 0;
    for (const exactOptionalPropertyTypes of [true, false]) {
      await writeFile(
        join(root, "positive.json"),
        JSON.stringify({
          compilerOptions: { ...compilerOptions, exactOptionalPropertyTypes },
          files: checkedDeclarations,
          include: ["positive.ts", "controls.ts", "app/kello/**/*.ts"],
        }),
      );
      await succeed([compiler, "--pretty", "false", "-p", "positive.json"]);
      console.info(
        JSON.stringify({
          proof: "packed-full-text-positive-types",
          exactOptionalPropertyTypes,
          controls: packedFullTextNegativeCases.length,
          checkedDeclarations: checkedDeclarations.length,
        }),
      );
      for (const item of packedFullTextNegativeCases) {
        const prelude = "prelude" in item ? item.prelude : "";
        const prefix = `import { createClient } from "./app/kello/_generated/api";\nimport { keepPreviousData } from "@tanstack/react-query";\nconst { client, rpc } = createClient({ getToken: async () => null });\nconst literal = { fullText: { document: "content", query: "database" }, columns: { title: true } } as const;\n${prelude}\n`;
        const line = prefix.split("\n").length;
        const filename = `negative-${item.name}.ts`;
        await writeFile(join(root, filename), prefix + item.statement + "\n");
        await writeFile(
          join(root, "negative.json"),
          JSON.stringify({
            compilerOptions: { ...compilerOptions, exactOptionalPropertyTypes },
            files: checkedDeclarations,
            include: [filename, "app/kello/**/*.ts"],
          }),
        );
        const result = await run([compiler, "--pretty", "false", "-p", "negative.json"]);
        assert.ok(
          result.code === 1 || result.code === 2,
          `${item.name}: expected a compiler diagnostic exit, not an execution failure\n${result.output}`,
        );
        const diagnostics = [...result.output.matchAll(/^(.+)\((\d+),(\d+)\): error (TS\d+): (.*)$/gm)];
        assert.ok(diagnostics.length > 0, `${item.name}: no compiler diagnostics captured\n${result.output}`);
        assert.equal(
          (result.output.match(/error TS\d+:/g) ?? []).length,
          diagnostics.length,
          "unlocated/global compiler diagnostics cannot establish a negative case",
        );
        for (const diagnostic of diagnostics) {
          assert.equal(
            basename(diagnostic[1]!),
            filename,
            `${item.name}: unrelated source cannot satisfy this red case\n${result.output}`,
          );
          assert.equal(
            Number(diagnostic[2]),
            line,
            `${item.name}: failure must be at its forbidden call/access\n${result.output}`,
          );
          const allowed =
            item.name === "unselected-output" ? ["TS2339"] : ["TS2322", "TS2345", "TS2353", "TS2375", "TS2769"];
          assert.ok(
            allowed.includes(diagnostic[4]!),
            `${item.name}: unrelated compiler diagnostic ${diagnostic[4]}\n${result.output}`,
          );
        }
        negativeCompiles++;
        console.info(
          JSON.stringify({
            proof: "packed-full-text-negative-types",
            case: item.name,
            exactOptionalPropertyTypes,
            diagnostics: diagnostics.map((match) => ({
              line: Number(match[2]),
              column: Number(match[3]),
              code: match[4],
              message: match[5],
            })),
          }),
        );
        // Keep the per-case receipt, but don't include old negative sources in
        // subsequent compilation. Each invocation owns precisely one red case.
      }
    }
    await writeFile(join(root, "runtime.mjs"), packedFullTextRuntime);
    await succeed(["bun", "runtime.mjs"]);
    await writeFile(join(root, "browser.mjs"), packedFullTextBrowser);
    await succeed(["bun", "browser.mjs"]);
    console.info(
      JSON.stringify({
        proof: "packed-full-text-complete",
        positiveCompiles: 2,
        negativeCases: packedFullTextNegativeCases.length,
        negativeCompiles,
        runtimeProofs: 1,
        browserBundles: 1,
        commands,
        ownershipSettled,
      }),
    );
    completed = true;
  } catch (cause) {
    console.error(
      JSON.stringify({ proof: "packed-full-text-failure", root, receipts, ownershipSettled, error: String(cause) }),
    );
    throw cause;
  } finally {
    // Failed gates retain the tarball, sources and full command logs. Cleanup
    // happens only after success and observed settlement of every owned group.
    if (completed && ownershipSettled) await rm(root, { recursive: true, force: true });
  }
}, 650_000);
