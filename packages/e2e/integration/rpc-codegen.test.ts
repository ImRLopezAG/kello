import assert from "node:assert/strict";
import { expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, symlink, writeFile, readFile, readlink, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { generateProject, initializeProject, loadProject } from "kello-cli";

test("native generation bootstraps, isolates internal routes, and atomically replaces bounded artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "loom-rpc-codegen-"));
  try {
    await initializeProject(root, "rpc");
    await mkdir(join(root, "node_modules/@kello"), { recursive: true });
    await mkdir(join(root, "node_modules/@orpc"), { recursive: true });
    for (const name of ["kello", "valibot", "drizzle-orm", "@orpc/tanstack-query"]) {
      await symlink(
        await realpath(
          fileURLToPath(
            new URL(`../../${name === "@orpc/tanstack-query" ? "e2e" : "tests"}/node_modules/${name}`, import.meta.url),
          ),
        ),
        join(root, "node_modules", name),
      );
    }
    const migration = join(root, "kello/_generated/migrations/history.sql");
    await mkdir(join(root, "kello/_generated/migrations"), { recursive: true });
    await writeFile(migration, "-- committed migration history\n");
    const initialized = await generateProject(root);
    expect(await readFile(migration, "utf8")).toBe("-- committed migration history\n");
    await mkdir(join(root, "kello/migrations"));
    await assert.rejects(loadProject(root), /Move existing migrations/);
    await writeFile(join(root, "kello.config.ts"), 'export default { project: "rpc", backend: "server" };');
    await assert.rejects(loadProject(root), /Move existing migrations from kello\/migrations/);
    await rm(join(root, "kello.config.ts"));
    await rm(join(root, "kello/migrations"), { recursive: true });
    expect(initialized.protocol).toBe("loom-orpc-2");
    expect(initialized.procedures).toEqual([{ path: ["tasks", "list"], visibility: "public" }]);
    const initialLink = await readlink(join(root, "kello/_generated/current"));
    expect(initialLink).toBe("../../.kello/generations/" + initialized.version);
    expect(await readFile(join(root, "kello/_generated/.kello-generated"), "utf8")).toBe("kello-generated-v1\n");
    expect(await readdir(root)).not.toContain(".loom");
    const generatedClientImport = join(root, "kello/functions/recursive.ts");
    await writeFile(generatedClientImport, 'export { createClient } from "../_generated/api";');
    await assert.rejects(generateProject(root), /[Bb]undl(?:e|ing) failed/);
    expect(await readlink(join(root, "kello/_generated/current"))).toBe(initialLink);
    await rm(generatedClientImport);

    await writeFile(
      join(root, "kello.config.ts"),
      'import { defineConfig } from "kello-cli"; export default defineConfig({ project: "rpc", openapi: true });',
    );
    const contract = (
      name: string,
      live = false,
    ) => `import { defineContract, oc, eventIterator } from "kello/contract";
import * as v from "valibot";
export default defineContract(({ validators }) => ({ ${name}: oc.input(validators.id("tasks")).output(${live ? "eventIterator(" : ""}v.object({ id: v.string(), title: v.string() })${live ? ")" : ""}) }));`;
    const source = (name: string, streaming = false) => `import { os } from "../_generated/rpc";
export default os.tasks.router({ ${name}: os.tasks.${name}.handler(({ input, context }) => ${streaming ? "(async function* () { yield { id: input, title: context.tables.tasks.title.name }; })()" : "({ id: input, title: context.tables.tasks.title.name })"}) });
export const helper = () => "PRIVATE_HELPER_SENTINEL";
`;
    await writeFile(join(root, "kello/contracts/tasks.ts"), contract("list"));
    await writeFile(join(root, "kello/functions/tasks.ts"), source("list"));
    await mkdir(join(root, "kello/internal"));
    await mkdir(join(root, "kello/contracts/internal"), { recursive: true });
    await writeFile(
      join(root, "kello/contracts/internal/admin.ts"),
      `import { defineContract, oc } from "kello/contract"; import * as v from "valibot"; export default defineContract({ inspect: oc.output(v.string()) });`,
    );
    await writeFile(
      join(root, "kello/internal/admin.ts"),
      `import { os } from "../_generated/rpc"; export default os.internal.admin.router({ inspect: os.internal.admin.inspect.handler(() => "INTERNAL_SENTINEL") });`,
    );
    await writeFile(
      join(root, "kello/upgrade.ts"),
      `import * as v from "valibot";
import { defineJobMigration } from "kello/server";
import router from "./internal/admin";
export default [defineJobMigration({
  from: { protocol: "loom-legacy-1", version: "${"1".repeat(64)}", name: "admin:inspect", kind: "action" },
  input: v.null(), to: router.inspect, transform: () => undefined,
})];`,
    );
    const first = await generateProject(root);
    expect(first.protocol).toBe("loom-orpc-2");
    expect(first.procedures).toEqual([
      { path: ["admin", "inspect"], visibility: "internal" },
      { path: ["tasks", "list"], visibility: "public" },
    ]);
    expect((await generateProject(root)).version).toBe(first.version);
    expect(await readFile(migration, "utf8")).toBe("-- committed migration history\n");
    const generated = join(root, "kello/_generated");
    const originalLink = await readlink(join(generated, "current"));
    const router = await readFile(join(generated, "current/router.js"), "utf8");
    expect(router).toContain('"list": project.module0["default"]["list"]');
    expect(router).toContain('"inspect": project.module1["default"]["inspect"]');
    const generatedRuntime = await import(pathToFileURL(join(generated, "current/runtime.js")).href);
    const options = generatedRuntime.runtimeOptions();
    expect(options.config.openapi).toBe(true);
    expect(options.jobMigrations).toHaveLength(1);
    expect(
      options.procedures.map((entry: { path: string[]; visibility: string }) => ({
        path: entry.path,
        visibility: entry.visibility,
      })),
    ).toEqual(first.procedures);
    expect(options.auth.allowAnonymous).toBe(false);
    expect(await readFile(join(generated, "current/service.js"), "utf8")).toContain("createNeonRpcService");
    expect(await readFile(join(generated, "current/worker.js"), "utf8")).toContain("createNeonRpcWorker");
    const apiTypes = await readFile(join(generated, "current/api.d.ts"), "utf8");
    expect(apiTypes).toContain("RouterContractClient");
    await writeFile(
      join(root, "kello/client-types.ts"),
      `import { createClient } from "./_generated/api";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
// @ts-expect-error legacy function builders are no longer generated
import { query } from "./_generated/server";
void query;
declare const options: Parameters<typeof createClient>[0];
const { client } = createClient(options);
const rpc = createTanstackQueryUtils(client);
rpc.tasks.list.queryOptions({ input: "00000000-0000-0000-0000-000000000000", select: value => value.title.length });
// @ts-expect-error options preserve the schema output type
rpc.tasks.list.queryOptions({ input: "00000000-0000-0000-0000-000000000000", select: (value: number) => value });
const result: Promise<{ id: string; title: string }> = client.tasks.list("00000000-0000-0000-0000-000000000000");
void result;
// @ts-expect-error public client excludes internal routes
client.internal.admin.inspect();
// @ts-expect-error native input is inferred from the contract schema
client.tasks.list(123);
// @ts-expect-error helpers are not procedures
client.tasks.helper();
`,
    );
    const tsc = Bun.spawn(
      [fileURLToPath(new URL("../../../node_modules/.bin/tsc", import.meta.url)), "-p", join(root, "tsconfig.json")],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect((await new Response(tsc.stdout).text()) + (await new Response(tsc.stderr).text())).toBe("");
    expect(await tsc.exited).toBe(0);
    await rm(join(root, "kello/client-types.ts"));
    const browser = await Bun.build({ entrypoints: [join(generated, "api.js")], target: "browser", minify: true });
    expect(browser.success).toBe(true);
    const browserText = await Promise.all(browser.outputs.map((file) => file.text()));
    for (const text of browserText) {
      for (const forbidden of [
        "PRIVATE_HELPER_SENTINEL",
        "INTERNAL_SENTINEL",
        "DATABASE_URL",
        "pg-protocol",
        "kello.config",
        "effect/Context",
      ])
        expect(text).not.toContain(forbidden);
    }
    await writeFile(join(root, "kello/functions/tasks.ts"), "export const router = { broken: 42 };\n");
    await assert.rejects(generateProject(root), /tasks.broken/);
    expect(await readlink(join(generated, "current"))).toBe(originalLink);
    expect(await readFile(join(generated, "current/router.js"), "utf8")).toBe(router);
    await writeFile(join(root, "kello/contracts/tasks.ts"), contract("renamed", true));
    await writeFile(join(root, "kello/functions/tasks.ts"), source("renamed", true));
    const second = await generateProject(root);
    expect(second.version).not.toBe(first.version);
    await writeFile(
      join(root, "kello/client-types.ts"),
      `import { createClient } from "./_generated/api";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
declare const options: Parameters<typeof createClient>[0];
const session = createClient(options);
const rpc = createTanstackQueryUtils(session.client);
const query = rpc.tasks.renamed.liveOptions({ input: "00000000-0000-0000-0000-000000000000", select: (row) => row.title.length });
const raw: Promise<AsyncIteratorObject<{ id: string; title: string }>> = session.client.tasks.renamed("00000000-0000-0000-0000-000000000000");
void [query, raw];
// @ts-expect-error live options do not accept mutation callbacks
rpc.tasks.renamed.liveOptions({ onSuccess: () => {} });
`,
    );
    const liveTypes = Bun.spawn(
      [fileURLToPath(new URL("../../../node_modules/.bin/tsc", import.meta.url)), "-p", join(root, "tsconfig.json")],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect((await new Response(liveTypes.stdout).text()) + (await new Response(liveTypes.stderr).text())).toBe("");
    expect(await liveTypes.exited).toBe(0);
    await rm(join(root, "kello/client-types.ts"));
    expect(await readFile(join(generated, "current/api.d.ts"), "utf8")).not.toContain('["list"]');
    await rm(join(root, "kello/functions/tasks.ts"));
    await rm(join(root, "kello/contracts/tasks.ts"));
    await writeFile(join(generated, "contracts/user-note.txt"), "user-owned");
    await generateProject(root);
    await assert.rejects(readFile(join(generated, "contracts/tasks.ts")), { code: "ENOENT" });
    expect(await readFile(join(generated, "contracts/user-note.txt"), "utf8")).toBe("user-owned");
    expect(await readFile(join(generated, "current/api.d.ts"), "utf8")).not.toContain('"tasks"');
    expect((await readdir(join(root, ".kello/generations"))).length).toBe(2);
    expect((await readdir(generated)).filter((name) => /^[a-f0-9]{64}$/.test(name))).toEqual([]);
    expect((await loadProject(root)).procedures.length).toBe(1);
    await rm(join(root, "kello/upgrade.ts"));
    await rm(join(root, "kello/internal/admin.ts"));
    await rm(join(root, "kello/contracts/internal/admin.ts"));
    const empty = await generateProject(root);
    expect(empty.protocol).toBe("loom-orpc-2");
    expect(empty.procedures).toEqual([]);
    const retainedContracts = join(root, "user-contracts");
    await mkdir(retainedContracts);
    const retainedBinding = 'export { contract0 as default } from "../contract-registry";\n';
    await writeFile(join(retainedContracts, "keep.ts"), retainedBinding);
    await rm(join(generated, "contracts"), { recursive: true });
    await symlink(retainedContracts, join(generated, "contracts"));
    await assert.rejects(generateProject(root), /non-directory generated contracts/);
    expect(await readFile(join(retainedContracts, "keep.ts"), "utf8")).toBe(retainedBinding);
    await rm(join(generated, "contracts"));
    const protectedFile = join(root, "user-owned.ts");
    await writeFile(protectedFile, "user-owned");
    await rm(join(generated, "server.ts"));
    await symlink(protectedFile, join(generated, "server.ts"));
    await assert.rejects(generateProject(root), /non-file generated server/);
    expect(await readFile(protectedFile, "utf8")).toBe("user-owned");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30000);

test("native capability modules resolve internal objects and reject invalid target changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "loom-rpc-capabilities-"));
  try {
    await initializeProject(root, "capabilities");
    await mkdir(join(root, "node_modules/@kello"), { recursive: true });
    await mkdir(join(root, "node_modules/@orpc"), { recursive: true });
    for (const name of ["kello", "valibot", "drizzle-orm", "@orpc/tanstack-query"]) {
      await symlink(
        await realpath(
          fileURLToPath(
            new URL(`../../${name === "@orpc/tanstack-query" ? "e2e" : "tests"}/node_modules/${name}`, import.meta.url),
          ),
        ),
        join(root, "node_modules", name),
      );
    }
    await mkdir(join(root, "kello/internal"));
    await mkdir(join(root, "kello/contracts/internal"), { recursive: true });
    await writeFile(
      join(root, "kello/contracts/internal/jobs.ts"),
      `import { defineContract, oc } from "kello/contract";
import { storageObjectCreatedValidator } from "kello/server";
import * as v from "valibot";
export default defineContract({ tick: oc.input(v.number()).output(v.number()), uploaded: oc.input(storageObjectCreatedValidator).output(v.null()) });`,
    );
    await writeFile(
      join(root, "kello/internal/jobs.ts"),
      `import { os } from "../_generated/rpc";
export default os.internal.jobs.router({ tick: os.internal.jobs.tick.handler(({ input }) => input), uploaded: os.internal.jobs.uploaded.handler(() => null) });`,
    );
    await writeFile(
      join(root, "kello/auth.config.ts"),
      `import { defineRpcAuth } from "kello/server";
export default defineRpcAuth({ allowAnonymous: true, authorize: () => {} });`,
    );
    await writeFile(
      join(root, "kello/crons.ts"),
      `import { procedureCron } from "kello/server";
import jobs from "./internal/jobs"; const tick = jobs.tick;
export default { minute: procedureCron("* * * * *", tick, 1) };`,
    );
    await writeFile(
      join(root, "kello/storage.ts"),
      `import { defineProcedureStorage, procedureObjectCreated } from "kello/server";
import jobs from "./internal/jobs"; const uploaded = jobs.uploaded;
export default defineProcedureStorage({ buckets: { uploads: { onObjectCreated: procedureObjectCreated(uploaded) } } });`,
    );
    const generated = await generateProject(root);
    const project = await loadProject(root);
    if (project.protocol !== "loom-orpc-2") throw new Error("Expected native project");
    expect(project.auth.allowAnonymous).toBe(true);
    expect(project.crons.minute?.call.path).toEqual(["jobs", "tick"]);
    const runtime = await import(pathToFileURL(join(root, ".kello/generations", generated.version, "runtime.js")).href);
    const options = runtime.runtimeOptions();
    expect(options.crons.minute.procedure).toBe(
      options.procedures.find((entry: { path: string[] }) => entry.path.join(".") === "jobs.tick").procedure,
    );
    const link = await readlink(join(root, "kello/_generated/current"));
    await writeFile(
      join(root, "kello/crons.ts"),
      `import { procedureCron } from "kello/server";
import tasks from "./functions/tasks"; const list = tasks.list;
export default { minute: procedureCron("* * * * *", list, undefined) };`,
    );
    await assert.rejects(generateProject(root), /registered internal procedure/);
    expect(await readlink(join(root, "kello/_generated/current"))).toBe(link);
    await writeFile(join(root, "kello/auth.config.ts"), "export default null;");
    await assert.rejects(generateProject(root), /defineRpcAuth/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
