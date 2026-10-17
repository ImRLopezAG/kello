import assert from "node:assert/strict";
import { test, expect } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { generateProject, initializeProject, loadProject } from "kello/tooling";
import { readProjectRelease } from "../../../apps/kello/src/tooling/deploy/neon/project";

test("contract-first generation bootstraps typed builders and a native browser client without secrets", async () => {
  const root = await mkdtemp(join(tmpdir(), "loom-application-"));
  try {
    await initializeProject(root, "application");
    await mkdir(join(root, "node_modules/@kello"), { recursive: true });
    await mkdir(join(root, "node_modules/@orpc"), { recursive: true });
    for (const name of ["kello", "@orpc/tanstack-query", "valibot", "zod", "drizzle-orm"]) {
      const workspace = name === "@orpc/tanstack-query" ? "e2e" : "tests";
      await symlink(
        await realpath(fileURLToPath(new URL(`../../${workspace}/node_modules/${name}`, import.meta.url))),
        join(root, "node_modules", name),
      );
    }
    await rm(join(root, "kello/app.config.ts"));
    await assert.rejects(loadProject(root), /app.config.ts is required/);
    await mkdir(join(root, "kello/contracts/internal"), { recursive: true });
    await mkdir(join(root, "kello/internal"));
    await writeFile(
      join(root, "kello/contracts/internal/jobs.ts"),
      `import { defineContract, oc } from "kello/contract";
import * as v from "valibot";
export default defineContract({ run: oc.errors({ UNAUTHORIZED: {} }).output(v.boolean()) });`,
    );
    await writeFile(
      join(root, "kello/internal/jobs.ts"),
      `import { os } from "../_generated/rpc";
export default os.internal.jobs.router({ run: os.internal.jobs.run.handler(() => true) });`,
    );
    await writeFile(
      join(root, "kello/contracts/tasks.ts"),
      `import { defineContract, oc, eventIterator } from "kello/contract";
import { z } from "zod";
import * as v from "valibot";
export default defineContract(({ validators }) => ({
  get: oc.errors({ UNAUTHORIZED: {} }).input(v.object({ id: validators.id("tasks") })).output(z.object({ title: z.string() })),
  update: oc.errors({ UNAUTHORIZED: {} }).input(z.object({ title: z.string() })).output(v.boolean()),
  watch: oc.errors({ UNAUTHORIZED: {} }).output(eventIterator(z.object({ title: z.string() }))),
}));`,
    );
    await writeFile(
      join(root, "kello/app.config.ts"),
      `import { defineApplication } from "kello/server";
import { z } from "zod";
export default defineApplication({
 env: { PRIVATE_TOKEN: z.string() },
 rpc: ({ os }) => ({ os, auth: os.use(({ context, next, errors }) => {
   if (!context.identity) throw errors.UNAUTHORIZED();
   return next({ context: { user: { id: context.identity.subject } } });
 }) }),
});`,
    );
    await writeFile(
      join(root, "kello/auth.config.ts"),
      `import { defineRpcAuth } from "kello/server";
export default defineRpcAuth({ allowAnonymous: true, authorize: async () => {} });`,
    );
    const functions = `import { os, auth } from "../_generated/rpc";
export default os.tasks.router({
 get: auth.tasks.get.handler(({ context, input }) => ({ title: context.user.id + input.id + context.tables.tasks.title.name + context.env.PRIVATE_TOKEN })),
 update: auth.tasks.update.handler(({ input }) => input.title.length > 0),
 watch: os.tasks.watch.handler(async function* ({ context }) {
   // @ts-expect-error only project tables exist in the ordinary procedure context
   context.tables.unknownTable;
   yield { title: context.tables.tasks.title.name + context.env.PRIVATE_TOKEN };
 }),
});`;
    await writeFile(join(root, "kello/functions/tasks.ts"), functions);
    const generated = await generateProject(root);
    expect(generated.procedures).toHaveLength(4);
    const runtime = await import(pathToFileURL(join(root, "kello/_generated/current/runtime.js")).href);
    expect(runtime.runtimeOptions().application.env.PRIVATE_TOKEN).toBeDefined();
    expect(runtime.runtimeOptions().auth.allowAnonymous).toBe(true);
    await writeFile(
      join(root, "release.json"),
      JSON.stringify({
        format: 1,
        releaseKey: "a".repeat(64),
        deployment: "test",
        version: generated.version,
        environment: "preview",
        databaseName: "application",
        migrationRole: "migration",
        runtimeRole: "runtime",
        quarantine: "clone",
        reviewedHashes: [],
        migrationHashes: [],
        schema: { minimum: "b".repeat(64), maximum: "b".repeat(64), target: "b".repeat(64) },
        slugs: { service: "service", worker: "worker" },
        activationTokenEnv: "DEPLOY_TOKEN",
        variables: { LOOM_DATABASE_URL: "RUNTIME_URL" },
      }),
    );
    const release = await readProjectRelease(root, "release.json");
    expect(release.declaration.variables).toEqual({ PRIVATE_TOKEN: "PRIVATE_TOKEN", LOOM_DATABASE_URL: "RUNTIME_URL" });
    await writeFile(
      join(root, "kello/client-types.ts"),
      `import { createClient } from "./_generated/api";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
const { client, dispose } = createClient({ url: "https://kello.test", getToken: async () => "token" });
const rpc = createTanstackQueryUtils(client);
rpc.tasks.get.queryOptions({ input: { id: "id" }, enabled: false, staleTime: 1000 });
rpc.tasks.update.mutationOptions({ onSuccess: (result, input) => { const value: boolean = result; const title: string = input.title; void [value, title]; } });
rpc.tasks.watch.liveOptions({ enabled: false, select: (event) => {
  const title: string = event.title;
  // @ts-expect-error Streaming values retain their declared payload.
  void event.missing;
  return title;
} });
// @ts-expect-error Native input types reject incorrect values.
rpc.tasks.get.queryOptions({ input: { id: 123 } });
// @ts-expect-error Only contract routes are public.
rpc.tasks.missing.queryOptions();
// @ts-expect-error Internal contracts never enter the public client.
client.internal.jobs.run();
void dispose;
`,
    );
    const tsc = Bun.spawn(
      [fileURLToPath(new URL("../../../node_modules/.bin/tsc", import.meta.url)), "-p", join(root, "tsconfig.json")],
      { stdout: "pipe", stderr: "pipe" },
    );
    const output = (await new Response(tsc.stdout).text()) + (await new Response(tsc.stderr).text());
    assert.equal(await tsc.exited, 0, output);
    const clientSource = await readFile(join(root, "kello/_generated/current/api.js"), "utf8");
    expect(clientSource).not.toContain("PRIVATE_TOKEN");
    expect(clientSource).not.toContain("createRpcQuery");
    const browser = await Bun.build({ entrypoints: [join(root, "kello/_generated/api.js")], target: "browser" });
    assert.ok(browser.success, "Generated client must bundle for browsers");
    const browserSource = await browser.outputs[0]!.text();
    expect(browserSource).not.toContain("PRIVATE_TOKEN");
    expect(browserSource).not.toContain("node:async_hooks");
    expect((await generateProject(root)).version).toBe(generated.version);
    await writeFile(
      join(root, "kello/functions/tasks.ts"),
      functions.replace("update: auth.tasks.update.handler(({ input }) => input.title.length > 0),", ""),
    );
    await assert.rejects(generateProject(root), /Missing contract implementations: tasks.update/);
    await writeFile(
      join(root, "kello/functions/tasks.ts"),
      `${functions}\nexport const extra = os.tasks.update.handler(() => true);`,
    );
    await assert.rejects(generateProject(root), /Procedure has no contract: tasks.extra/);
    await writeFile(
      join(root, "kello/functions/tasks.ts"),
      functions.replace("auth.tasks.update.handler", "auth.tasks.get.handler"),
    );
    await assert.rejects(generateProject(root), /Procedure does not implement its declared contract: tasks.update/);
    await writeFile(join(root, "kello/functions/tasks.ts"), functions);
    await rm(join(root, "kello/internal/jobs.ts"));
    await mkdir(join(root, "kello/functions/internal"));
    await writeFile(
      join(root, "kello/functions/internal/jobs.ts"),
      `import { os } from "../../_generated/rpc";
export default os.internal.jobs.router({ run: os.internal.jobs.run.handler(() => true) });`,
    );
    await assert.rejects(generateProject(root), /Public procedures cannot implement internal contracts/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
