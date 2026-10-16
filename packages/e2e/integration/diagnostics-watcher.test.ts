import assert from "node:assert/strict";
import { test } from "bun:test";
import { channel } from "node:diagnostics_channel";
import { watch } from "node:fs";
import { mkdtemp, mkdir, open, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout } from "node:timers/promises";
import { initializeProject } from "../../../apps/loom/src/tooling/project/initialize";
import { prepareProject, activateProject } from "../../../apps/loom/src/tooling/codegen/generate";
import { watchDevelopmentWithOwnedOutput } from "../../../apps/loom/src/tooling/dev/watcher";
import { startDiagnostics } from "../../../apps/loom/src/tooling/diagnostics/session";
import { createFileOutput } from "../../../apps/loom/src/tooling/diagnostics/output";
import type { DiagnosticsRecord } from "../../../apps/loom/src/tooling/diagnostics/types";

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, "Watcher did not observe the source update");
    await setTimeout(10);
  }
}

async function acknowledgeSetup(root: string): Promise<void> {
  let ready = false;
  const observer = watch(await realpath(root), { recursive: true }, (_event, filename) => {
    if (filename?.toString().replaceAll("\\", "/") === ".loom/watch-ready") ready = true;
  });
  const closed = new Promise<void>((resolve) => observer.once("close", resolve));
  try {
    await until(async () => {
      if (!ready) await writeFile(join(root, ".loom/watch-ready"), "ready");
      return ready;
    });
  } finally {
    observer.close();
    await closed;
  }
}

test("owned diagnostics writes leave preparations idle and source activation progresses through a symlinked root", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "kello-diagnostics-watch-"));
  const root = join(workspace, "project");
  const alias = join(workspace, "alias");
  await initializeProject(root, "tasks");
  await mkdir(join(root, "node_modules"));
  for (const name of ["kello", "valibot", "drizzle-orm"])
    await symlink(
      await realpath(fileURLToPath(new URL(`../../tests/node_modules/${name}`, import.meta.url))),
      join(root, "node_modules", name),
    );
  await mkdir(join(root, "logs"));
  await mkdir(join(root, "other"));
  await mkdir(join(root, ".loom"), { recursive: true });
  await symlink(root, alias);
  await prepareProject(alias);
  // Accepted 003 setup pattern: acknowledge native registration/delivery after
  // directory creation, before starting the watcher whose exclusions we measure.
  await acknowledgeSetup(root);
  const ownedPath = join(alias, "logs/events.jsonl");
  const output = createFileOutput(await open(ownedPath, "wx", 0o600));
  try {
    const diagnostics = await startDiagnostics({ output: { format: "jsonl", write: output.write } });
    try {
      const runtime = channel("kello.runtime.metric");
      let preparations = 0;
      let active = "";
      const watcher = await watchDevelopmentWithOwnedOutput(
        alias,
        async (revision) => {
          preparations++;
          const candidate = await prepareProject(alias);
          revision.assertCurrent();
          await activateProject(alias, candidate.version, revision.signal, () => {
            active = candidate.version;
          });
        },
        { debounceMs: 75 },
        ownedPath,
      );
      let streaming = true;
      let published = 0;
      const stream = (async () => {
        while (streaming) {
          runtime.publish({ type: "rpc.procedure", mode: "finite", status: "success", durationMs: ++published });
          await setTimeout(10);
        }
      })();
      try {
        await watcher.flush();
        assert.match(active, /^[a-f0-9]{64}$/);
        const firstVersion = active;
        const before = preparations;
        const firstBytes = (await readFile(ownedPath)).byteLength;
        await setTimeout(250);
        assert.ok((await readFile(ownedPath)).byteLength > firstBytes, "The actual file sink must keep writing");
        assert.equal(preparations, before, "Owned writes alone must not schedule preparation");

        const schema = join(root, "kello/schema.ts");
        const source = await readFile(schema, "utf8");
        const changed = source.replace("title: s.text().notNull()", "title: s.text().notNull(), description: s.text()");
        assert.notEqual(changed, source);
        const atSave = published;
        await writeFile(schema, changed);
        await until(() => active !== firstVersion);
        await watcher.settled();
        assert.ok(published > atSave, "Activation must finish while the diagnostics stream continues");
        assert.equal(watcher.failure, null);

        // Exact ownership excludes neither the parent directory nor nearby files.
        for (const path of ["logs/sibling.jsonl", "other/events.jsonl", "logs/new-directory"]) {
          const previous = preparations;
          if (path.endsWith("new-directory")) await mkdir(join(root, path));
          else await writeFile(join(root, path), "watched");
          await until(() => preparations > previous);
          await watcher.settled();
        }
        assert.equal(watcher.watchError, null);
        streaming = false;
        await stream;
        await until(async () => {
          const content = await readFile(ownedPath, "utf8");
          return content.endsWith("\n") && content.trim().split("\n").length === diagnostics.snapshot().accepted;
        });
        const records: DiagnosticsRecord[] = (await readFile(ownedPath, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        assert.ok(records.length > 0);
        assert.deepEqual(
          records.map((record) => record.sequence),
          records.map((_record, index) => index + 1),
        );
        assert.equal(diagnostics.snapshot().outputFailures, 0);
      } finally {
        streaming = false;
        await stream;
        await watcher.stop();
      }
    } finally {
      await diagnostics.stop();
    }
  } finally {
    await output.close();
    await rm(workspace, { recursive: true, force: true });
  }
}, 15000);
