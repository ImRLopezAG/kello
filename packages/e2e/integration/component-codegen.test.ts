import assert from "node:assert/strict";
import { test, expect } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateProject, initializeProject, loadProject } from "kello-cli";

test("generation discovers only mounted components and emits isolated current facades", async () => {
  const root = await mkdtemp(join(tmpdir(), "loom-components-"));
  try {
    await initializeProject(root, "components");
    await mkdir(join(root, "node_modules"));
    for (const name of ["kello", "valibot", "zod", "drizzle-orm"]) {
      await symlink(
        await realpath(fileURLToPath(new URL(`../../tests/node_modules/${name}`, import.meta.url))),
        join(root, "node_modules", name),
      );
    }
    for (const name of ["identity", "unused"]) await mkdir(join(root, "kello/components", name), { recursive: true });
    await writeFile(
      join(root, "kello/components/identity/setup.ts"),
      `import { defineComponent } from "kello";
import { z } from "zod";
export default defineComponent({ name: "identity", env: { KEY: z.string() }, services: () => { throw new Error("SDK must not initialize during generation"); } });`,
    );
    await writeFile(
      join(root, "kello/components/unused/setup.ts"),
      `import { defineComponent } from "kello";
import { z } from "zod";
export default defineComponent({ name: "unused", env: { REQUIRED: z.string() } });`,
    );
    await writeFile(
      join(root, "kello/app.config.ts"),
      `import { defineApplication } from "kello";
import identity from "./components/identity/setup";
import { z } from "zod";
const app = defineApplication({ env: { CUSTOMER_KEY: z.string() }, rpc: ({ os }) => ({ os }) });
app.use(identity, { env: { KEY: app.env.CUSTOMER_KEY } });
app.use(identity, { name: "staff" });
export default app;`,
    );
    const project = await loadProject(root);
    expect(project.components.map((entry) => entry.path)).toEqual(["identity", "staff"]);
    const generated = await generateProject(root);
    const server = await readFile(join(root, "kello/components/identity/_generated/server.ts"), "utf8");
    expect(server).toContain("env");
    expect(server).not.toContain('declare module "kello/contract"');
    expect(await Bun.file(join(root, "kello/components/unused/_generated/server.ts")).exists()).toBe(false);
    expect((await generateProject(root)).version).toBe(generated.version);
    const output = join(root, "kello/components/identity/_generated");
    await writeFile(join(output, "contracts-stale.ts"), "stale");
    await generateProject(root);
    expect(await Bun.file(join(output, "contracts-stale.ts")).exists()).toBe(false);
    const before = await readFile(join(output, "server.ts"), "utf8");
    await writeFile(join(root, "kello/components/identity/setup.ts"), "invalid TypeScript !!!");
    await assert.rejects(generateProject(root));
    expect(await readFile(join(output, "server.ts"), "utf8")).toBe(before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("component RPC bindings use component tables and contracts without ambient application registration", async () => {
  const root = await mkdtemp(join(tmpdir(), "loom-component-rpc-"));
  try {
    await initializeProject(root, "componentrpc");
    await mkdir(join(root, "node_modules"));
    for (const name of ["kello", "valibot", "zod", "drizzle-orm"]) {
      await symlink(
        await realpath(fileURLToPath(new URL(`../../tests/node_modules/${name}`, import.meta.url))),
        join(root, "node_modules", name),
      );
    }
    for (const name of ["contracts", "functions", "contracts/internal", "internal"])
      await mkdir(join(root, "kello/components/catalog", name), { recursive: true });
    await writeFile(
      join(root, "kello/components/catalog/setup.ts"),
      `import { defineComponent } from "./_generated/setup";
export default defineComponent({ name: "catalog", rpc: ({ os }) => ({ os }) });`,
    );
    await writeFile(
      join(root, "kello/components/catalog/schema.ts"),
      `import { defineSchema } from "kello/server";
export default defineSchema((s) => ({ products: { title: s.text().notNull() } }));`,
    );
    await writeFile(
      join(root, "kello/components/catalog/contracts/products.ts"),
      `import { defineContract, oc } from "../_generated/contract";
import { z } from "zod";
import * as v from "valibot";
export default defineContract(({ validators }) => ({ get: oc.input(v.strictObject({ id: validators.id("products") })).output(z.string()) }));`,
    );
    await writeFile(
      join(root, "kello/components/catalog/contracts/internal/products.ts"),
      `import { defineContract, oc } from "../../_generated/contract";
import { z } from "zod";
export default defineContract({ title: oc.input(z.object({ id: z.string() })).output(z.string()) });`,
    );
    await writeFile(
      join(root, "kello/components/catalog/internal/products.ts"),
      `import { os } from "../_generated/rpc";
export default os.internal.products.router({ title: os.internal.products.title.handler(({ context }) => context.tables.products.title.name) });`,
    );
    await writeFile(
      join(root, "kello/components/catalog/functions/products.ts"),
      `import { os } from "../_generated/rpc";
export default os.products.router({ get: os.products.get.handler(({ context, input }) => context.internal.products.title({ id: input.id })) });`,
    );
    await mkdir(join(root, "kello/components/ledger"), { recursive: true });
    for (const folder of ["contracts", "functions"]) await mkdir(join(root, "kello/components/ledger", folder));
    await writeFile(
      join(root, "kello/components/ledger/contracts/balance.ts"),
      `import { defineContract, oc } from "../_generated/contract"; import { z } from "zod"; export default defineContract({ get: oc.output(z.number()) });`,
    );
    await writeFile(
      join(root, "kello/components/ledger/functions/balance.ts"),
      `import { os } from "../_generated/rpc"; export default os.balance.router({ get: os.balance.get.handler(() => 1) });`,
    );
    await writeFile(
      join(root, "kello/components/ledger/setup.ts"),
      `import { defineComponent } from "./_generated/setup"; export default defineComponent({ name: "ledger" });`,
    );
    await writeFile(
      join(root, "kello/components/ledger/schema.ts"),
      `import { defineSchema } from "kello/server"; export default defineSchema((s) => ({ entries: { amount: s.integer().notNull() } }));`,
    );
    await writeFile(
      join(root, "kello/app.config.ts"),
      `import { defineApplication } from "kello";
import ledger from "./components/ledger/setup";
import catalog from "./components/catalog/setup";
const app = defineApplication({ rpc: ({ os }) => ({ os }) });
const account = app.use(ledger); app.use(catalog, { public: "store", dependencies: { ledger: account } }); app.use(catalog, { name: "second", dependencies: { ledger: account } }); export default app;`,
    );
    const result = await generateProject(root);
    const project = await loadProject(root);
    expect(project.components).toHaveLength(3);
    expect(project.componentScopes.find((scope) => scope.directory.endsWith("catalog"))?.procedures).toHaveLength(2);
    expect(result.procedures.every((entry) => entry.path[0] !== "catalog")).toBe(true);
    const registration = await readFile(join(root, "kello/components/catalog/_generated/registration.ts"), "utf8");
    expect(registration).not.toContain("declare module");
    expect(registration).toContain("ComponentRegistration");
    await writeFile(
      join(root, "kello/components/catalog/typecheck.ts"),
      `import { os } from "./_generated/rpc";
import { validators } from "./_generated/schema";
import { validators as ledger } from "../ledger/_generated/schema";
ledger.id("entries");
// @ts-expect-error Component registrations never merge across scopes.
ledger.id("products");
// @ts-expect-error Only component tables are available.
validators.id("tasks");
os.products.get.handler(({ context, input }) => {
  const id: string = input.id;
  const balance: Promise<number> = context.components.ledger.rpc.balance.get();
  void balance;
  // @ts-expect-error Dependencies do not expose another scope's raw tables.
  void context.components.ledger.tables;
  // @ts-expect-error Application tables must not leak into components.
  void context.tables.tasks;
  // @ts-expect-error The contract input is not numeric.
  const wrong: number = input.id;
  void wrong;
  return id;
});`,
    );
    await writeFile(
      join(root, "kello/component-types.ts"),
      `import { os } from "./_generated/rpc";
os.use(({ context, next }) => {
  const result: Promise<string> = context.components.catalog.rpc.products.get({ id: "id" });
  // @ts-expect-error Native contract input is preserved.
  context.components.second.rpc.products.get({ id: 12 });
  // @ts-expect-error Private contracts are excluded from mounted exports.
  void context.components.catalog.rpc.internal;
  void result;
  return next();
});`,
    );
    await writeFile(
      join(root, "kello/client-projection-types.ts"),
      `import type { Client } from "./_generated/api";
import { createTanstackQueryUtils } from "kello/client";
declare const client: Client;
const result: Promise<string> = client.store.products.get({ id: "id" });
const rpc = createTanstackQueryUtils(client);
rpc.store.products.get.queryOptions({ input: { id: "id" }, enabled: false });
// @ts-expect-error Backend-only mounts are absent from the browser client.
void client.second;
// @ts-expect-error Internal procedures are never projected.
void client.store.internal;
void result;`,
    );
    const tsc = Bun.spawn(
      [fileURLToPath(new URL("../../../node_modules/.bin/tsc", import.meta.url)), "-p", join(root, "tsconfig.json")],
      { stdout: "pipe", stderr: "pipe" },
    );
    const output = (await new Response(tsc.stdout).text()) + (await new Response(tsc.stderr).text());
    assert.equal(await tsc.exited, 0, output);
    expect((await generateProject(root)).version).toBe(result.version);
    const applicationSource = join(root, "kello/app.config.ts");
    await writeFile(
      applicationSource,
      (await readFile(applicationSource, "utf8")).replace('name: "second"', 'name: "second", public: "store"'),
    );
    await assert.rejects(generateProject(root), /Conflicting public component prefix/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
