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
    const api = await readFile(join(root, "kello/_generated/current/api.js"), "utf8");
    const declarations = await readFile(join(root, "kello/_generated/current/api.d.ts"), "utf8");
    // One HTTP transport carries ordinary calls and live issuance/renewal.
    assert.doesNotMatch(api, /createRpcTransport\b/);
    assert.doesNotMatch(declarations, /createRpcTransport\b/);
    assert.match(api, /options\.realtimeUrl \?\? configuration\.realtimeUrl/);
    const generated = await import(join(root, "kello/_generated/current/api.js"));
    const options = { url: "https://service.example.test", getToken: async () => "token" };
    assert.throws(() => generated.createClient(options), /Neon Realtime URL is missing/);
    const connection = generated.createClient({ ...options, realtimeUrl: "wss://realtime.example.test" });
    try {
      assert.ok("open" in connection.live);
    } finally {
      connection.dispose();
    }
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
}
import { createClient as createApiClient } from "../kello/_generated/api";
const api = createApiClient({ getToken: async () => null });
const verified: ReturnType<typeof api.verifySession> = api.verifySession();
void verified;`,
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

test("Next declares a real live read with a generated browser row validator", async () => {
  const { loadProject } = await import("kello/tooling");
  const { applicationClientArtifacts } = await import("../../../apps/kello/src/tooling/codegen/application");
  const root = fileURLToPath(new URL("../../examples/next/", import.meta.url));
  const project = await loadProject(root);
  const artifacts = applicationClientArtifacts(project, join(project.backend, "_generated/current"));
  assert.match(artifacts["react.js"] ?? "", /examples.*watch/);
  assert.doesNotMatch(artifacts["react.js"] ?? "", /kello\/server|nrt_live_/);
});
