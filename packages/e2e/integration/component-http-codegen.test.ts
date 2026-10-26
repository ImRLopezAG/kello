import assert from "node:assert/strict";
import { test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateProject, initializeProject } from "kello-cli";

test("generated HTTP handlers retain own SDK, environment and private caller types", async () => {
  const root = await mkdtemp(join(tmpdir(), "loom-http-types-"));
  try {
    await initializeProject(root, "services");
    await mkdir(join(root, "node_modules"));
    for (const name of ["kello", "kello-cli", "valibot", "zod", "drizzle-orm", "effect"])
      await symlink(
        await realpath(fileURLToPath(new URL(`../../tests/node_modules/${name}`, import.meta.url))),
        join(root, "node_modules", name),
      );
    const directory = join(root, "kello/components/vendor");
    for (const folder of ["contracts/internal", "internal"]) await mkdir(join(directory, folder), { recursive: true });
    await writeFile(
      join(directory, "setup.ts"),
      `import { defineComponent } from "./_generated/setup";
import { Effect } from "effect";
import * as v from "valibot";
export class Vendor {
  lookup(id: string): string;
  lookup(id: number): number;
  lookup(id: string | number) { return id; }
}
export default defineComponent({
  name: "vendor", env: { API_KEY: v.string() },
  services: () => Effect.succeed({ sdk: new Vendor() }), rpc: ({ os }) => ({ os }),
  http: [{ method: "GET", path: "/health", access: { kind: "anonymous" }, handle: async ({ context }) => {
    const key: string = context.env.API_KEY;
    const number: number = context.services.sdk.lookup(1);
    // @ts-expect-error SDK overloads reject boolean.
    context.services.sdk.lookup(false);
    // @ts-expect-error Undeclared environment stays private.
    context.env.OTHER_SECRET;
    // @ts-expect-error Siblings are absent from this scope.
    context.components.sibling;
    const value: string = await context.internal.use.get();
    return Response.json({ key, number, value });
  } }],
});`,
    );
    await writeFile(
      join(directory, "contracts/internal/use.ts"),
      `import { defineContract, oc } from "../../_generated/contract";
import * as v from "valibot";
export default defineContract({ get: oc.output(v.string()) });`,
    );
    await writeFile(
      join(directory, "internal/use.ts"),
      `import { os } from "../_generated/rpc";
export default os.internal.use.router({ get: os.internal.use.get.handler(({ context }) => {
  const numeric: number = context.services.sdk.lookup(1);
  // @ts-expect-error SDK overload does not accept boolean.
  context.services.sdk.lookup(false);
  return context.services.sdk.lookup(String(numeric));
}) });`,
    );
    await writeFile(
      join(root, "kello/app.config.ts"),
      `import { defineApplication } from "kello";
import vendor from "./components/vendor/setup";
const app = defineApplication({ rpc: ({ os }) => ({ os }) });
app.use(vendor);
export default app;`,
    );
    await generateProject(root);
    await writeFile(
      join(root, "kello/service-types.ts"),
      `import type { Components } from "./_generated/components";
declare const components: Components;
const text: string = components.vendor.services.sdk.lookup("a");
const number: number = components.vendor.services.sdk.lookup(1);
// @ts-expect-error Exact SDK overloads reject boolean.
components.vendor.services.sdk.lookup(true);
void text; void number;`,
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
        include: ["kello/**/*.ts"],
      }),
    );
    const result = Bun.spawnSync(
      [fileURLToPath(new URL("../../../node_modules/.bin/tsc", import.meta.url)), "-p", join(root, "tsconfig.json")],
      { cwd: root },
    );
    assert.equal(result.exitCode, 0, result.stdout.toString() + result.stderr.toString());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
