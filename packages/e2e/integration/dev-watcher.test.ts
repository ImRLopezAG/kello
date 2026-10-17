import { initializeProject } from "kello/tooling";
import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readlink, realpath, symlink, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { setTimeout } from "node:timers/promises";
import { watch } from "node:fs";
import { EventEmitter } from "node:events";
import { watchDevelopment, prepareProject, activateProject } from "kello/tooling";

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error("Watcher did not observe the source update");
    await setTimeout(10);
  }
}

async function prepareMigrationDirectory(root: string): Promise<void> {
  await mkdir(join(root, "_generated"), { recursive: true });
  let ready = false;
  let created = false;
  let observed = false;
  let closed = false;
  const observer = watch(root, { recursive: true, encoding: "utf8" }, (_event, filename) => {
    const path = filename?.replaceAll("\\", "/");
    if (path === "_generated/.watch-ready") ready = true;
    if (path === "_generated/migrations") observed = true;
  });
  try {
    if (!(observer instanceof EventEmitter)) throw new Error("Native watcher is not an EventEmitter");
    observer.once("close", () => {
      closed = true;
    });
    // Native watch registration is asynchronous. Probe an ignored artifact until
    // delivery proves registration before creating the directory we must drain.
    await until(async () => {
      if (!ready) {
        await writeFile(join(root, "_generated/.watch-ready"), "ready");
      } else if (!created) {
        await mkdir(join(root, "_generated/migrations"), { recursive: true });
        created = true;
      }
      return observed;
    });
  } finally {
    observer.close();
    try {
      await until(() => closed);
    } finally {
      if (!observed) await rm(root, { recursive: true, force: true });
    }
  }
}

test("development watcher observes edits and stops and restarts cleanly", async () => {
  const root = await mkdtemp(join(tmpdir(), "loom-watch-"));
  const source = join(root, "schema.ts");
  const output = join(root, "kello", "_generated");
  await mkdir(output, { recursive: true });
  await writeFile(source, "first");
  const activated: string[] = [];
  const update = async () => {
    const value = await readFile(source, "utf8");
    await writeFile(join(output, "manifest.json"), value);
    activated.push(value);
  };
  const watcher = await watchDevelopment(root, update, { debounceMs: 20 });
  try {
    await watcher.flush();
    expect(activated).toEqual(["first"]);
    await writeFile(source, "second");
    await until(() => activated.includes("second"));
    await watcher.stop();
    const count = activated.length;
    await writeFile(source, "third");
    await setTimeout(100);
    expect(activated).toHaveLength(count);
    const restarted = await watchDevelopment(root, update, { debounceMs: 20 });
    try {
      await restarted.flush();
      expect(activated.at(-1)).toBe("third");
      expect(restarted.watchError).toBeNull();
    } finally {
      await restarted.stop();
    }
  } finally {
    await watcher.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("development watcher ignores artifact directories while observing source files", async () => {
  const root = await mkdtemp(join(tmpdir(), "loom-watch-artifacts-"));
  await prepareMigrationDirectory(root);
  const artifacts = [
    ".git",
    ".kello",
    "_generated",
    "node_modules",
    "dist",
    ".astro",
    `_generated.staging-${crypto.randomUUID()}`,
    `_generated.previous-${crypto.randomUUID()}`,
  ];
  let updates = 0;
  const watcher = await watchDevelopment(
    root,
    async () => {
      updates++;
    },
    { debounceMs: 20 },
  );
  try {
    await watcher.flush();
    expect(updates).toBe(1);
    for (const directory of artifacts) {
      const nested = join(root, directory, "nested");
      await mkdir(nested, { recursive: true });
      await writeFile(join(nested, "generated.ts"), "ignored");
    }
    await setTimeout(100);
    expect(updates).toBe(1);
    const beforeOwnership = updates;
    await writeFile(join(root, "_generated/migrations/.auth-ownership.json"), "{}");
    await writeFile(join(root, `_generated/migrations/.auth-ownership-${crypto.randomUUID()}.tmp`), "{}");
    await setTimeout(100);
    expect(updates).toBe(beforeOwnership);
    const beforeSource = updates;
    await writeFile(join(root, "source.ts"), "observed");
    await until(() => updates > beforeSource);
    expect(watcher.failure).toBeNull();
  } finally {
    await watcher.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("development watcher observes migration history files", async () => {
  const root = await mkdtemp(join(tmpdir(), "loom-watch-migrations-"));
  await prepareMigrationDirectory(root);
  let updates = 0;
  const watcher = await watchDevelopment(
    root,
    async () => {
      updates++;
    },
    { debounceMs: 20 },
  );
  try {
    await watcher.flush();
    expect(updates).toBe(1);
    await writeFile(join(root, "_generated/migrations/initial.sql"), "-- observed history");
    await until(() => updates > 1);
    expect(watcher.failure).toBeNull();
  } finally {
    await watcher.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("watching a consumer preserves generated contracts through a failed edit and recovers on save", async () => {
  const root = await mkdtemp(join(tmpdir(), "loom-watch-consumer-"));
  await initializeProject(root, "tasks");
  await mkdir(join(root, "node_modules/@kello"), { recursive: true });
  for (const name of ["kello", "valibot", "drizzle-orm"]) {
    await symlink(
      await realpath(fileURLToPath(new URL(`../../tests/node_modules/${name}`, import.meta.url))),
      join(root, "node_modules", name),
    );
  }
  let activeVersion = "";
  const watcher = await watchDevelopment(
    root,
    async (revision) => {
      const candidate = await prepareProject(root);
      revision.assertCurrent();
      await activateProject(root, candidate.version, revision.signal, () => {
        activeVersion = candidate.version;
      });
    },
    { debounceMs: 20 },
  );
  try {
    await watcher.flush();
    expect(activeVersion).toMatch(/^[a-f0-9]{64}$/);
    const previous = activeVersion;
    const source = join(root, "kello/schema.ts");
    const content = await readFile(source, "utf8");
    await writeFile(source, "export default {");
    await until(() => watcher.failure !== null);
    expect(await readlink(join(root, "kello/_generated/current"))).toBe("../../.kello/generations/" + previous);
    await writeFile(
      source,
      content.replace("title: s.text().notNull()", "title: s.text().notNull(), description: s.text()"),
    );
    await until(() => activeVersion !== previous);
    await watcher.settled();
    expect(watcher.failure).toBeNull();
    expect(await readlink(join(root, "kello/_generated/current"))).toBe("../../.kello/generations/" + activeVersion);
  } finally {
    await watcher.stop();
    await rm(root, { recursive: true, force: true });
  }
});
