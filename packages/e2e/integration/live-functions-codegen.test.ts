import assert from "node:assert/strict";
import { test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateProject, initializeProject } from "kello/tooling";

test("live functions generate a public React entry and preserve contract inference", async () => {
  const root = await mkdtemp(join(tmpdir(), "loom-live-functions-"));
  try {
    await initializeProject(root, "live-functions");
    await symlink(
      await realpath(fileURLToPath(new URL("../../tests/node_modules", import.meta.url))),
      join(root, "node_modules"),
    );
    await writeFile(
      join(root, "kello/contracts/tasks.ts"),
      `import { defineContract, oc } from "kello/contract";
import * as v from "valibot";
export default defineContract({ list: oc.input(v.object({ limit: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100)) })).output(v.array(v.object({ title: v.string() }))).live() });`,
    );
    await writeFile(
      join(root, "kello/functions/tasks.ts"),
      `import { os } from "../_generated/rpc";
export default os.tasks.router({ list: os.tasks.list.live(({ context, input }) => context.db.select({ title: context.tables.tasks.title }).from(context.tables.tasks).orderBy(context.tables.tasks._id).limit(input.limit)) });`,
    );
    await generateProject(root);
    assert.equal(
      await readFile(join(root, "kello/_generated/react.js"), "utf8"),
      'export * from "./current/react.js";\n',
    );
    assert.equal(
      await readFile(join(root, "kello/_generated/react.d.ts"), "utf8"),
      'export * from "./current/react.js";\n',
    );
    await mkdir(join(root, "src"));
    await writeFile(
      join(root, "src/live.ts"),
      `import { createClient } from "../kello/_generated/react";
declare const connection: ReturnType<typeof createClient>;
export function useTasks() {
  const tasks = connection.api.tasks.list.useLiveQuery({ limit: 20 });
  const rows: readonly { title: string }[] | undefined = tasks.data;
  // @ts-expect-error Pagination retains the native contract's input.
  connection.api.tasks.list.useLiveQuery({ limit: "twenty" });
  // @ts-expect-error A live capability must not enter the ordinary query cache.
  connection.rpc.tasks.list.queryOptions({ input: { limit: 20 } });
  return rows;
}`,
    );
    await writeFile(
      join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: "ES2023",
          module: "ESNext",
          moduleResolution: "Bundler",
          skipLibCheck: true,
        },
        include: ["src/**/*.ts", "kello/**/*.ts"],
      }),
    );
    const result = Bun.spawnSync(
      [fileURLToPath(new URL("../../../node_modules/.bin/tsc", import.meta.url)), "-p", join(root, "tsconfig.json")],
      { cwd: root, timeout: 30_000 },
    );
    assert.equal(result.exitCode, 0, result.stdout.toString() + result.stderr.toString());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
