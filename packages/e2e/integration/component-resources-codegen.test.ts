import assert from "node:assert/strict";
import { test, expect } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateProject, initializeProject, loadProject } from "kello-cli";

test("generation aggregates scoped cron and storage resources and rejects root collisions", async () => {
  const root = await mkdtemp(join(tmpdir(), "loom-component-resources-"));
  try {
    await initializeProject(root, "resources");
    await mkdir(join(root, "node_modules"));
    for (const name of ["kello", "kello-cli", "valibot", "drizzle-orm"])
      await symlink(
        await realpath(fileURLToPath(new URL(`../../tests/node_modules/${name}`, import.meta.url))),
        join(root, "node_modules", name),
      );
    const directory = join(root, "kello/components/jobs");
    for (const folder of ["contracts/internal", "internal"]) await mkdir(join(directory, folder), { recursive: true });
    await writeFile(
      join(directory, "setup.ts"),
      `import { defineComponent } from "./_generated/setup"; export default defineComponent({ name: "jobs" });`,
    );
    await writeFile(
      join(directory, "contracts/internal/work.ts"),
      `import { defineContract, oc } from "../../_generated/contract"; import * as v from "valibot"; export default defineContract({ tick: oc.input(v.string()).output(v.string()) });`,
    );
    await writeFile(
      join(directory, "internal/work.ts"),
      `import { os } from "../_generated/rpc"; export default os.internal.work.router({ tick: os.internal.work.tick.handler(({ input }) => input) });`,
    );
    await writeFile(
      join(directory, "crons.ts"),
      `import { procedureCron } from "kello/server"; import work from "./internal/work"; export default { tick: procedureCron("* * * * *", work.tick, "tick") };`,
    );
    await writeFile(
      join(directory, "storage.ts"),
      `import { defineProcedureStorage } from "kello/server"; export default defineProcedureStorage({ buckets: { files: {} } });`,
    );
    await writeFile(
      join(root, "kello/app.config.ts"),
      `import { defineApplication } from "kello"; import jobs from "./components/jobs/setup"; const app = defineApplication({ rpc: ({ os }) => ({ os }) }); app.use(jobs, { name: "left" }); app.use(jobs, { name: "right" }); export default app;`,
    );
    const project = await loadProject(root);
    expect(project.storageBuckets).toEqual(["files"]);
    expect(
      Object.values(project.crons)
        .map((cron) => cron.call.scope)
        .sort((left, right) => (left ?? "").localeCompare(right ?? "")),
    ).toEqual(["left", "right"]);
    expect(project.componentScopes.every((scope) => scope.cronsFile && scope.storageFile)).toBe(true);
    await generateProject(root);
    const collision = Object.keys(project.crons)[0]!;
    await mkdir(join(root, "kello/contracts/internal"), { recursive: true });
    await mkdir(join(root, "kello/internal"), { recursive: true });
    await writeFile(
      join(root, "kello/contracts/internal/work.ts"),
      `import { defineContract, oc } from "kello/contract"; import * as v from "valibot"; export default defineContract({ tick: oc.input(v.string()).output(v.string()) });`,
    );
    await writeFile(
      join(root, "kello/internal/work.ts"),
      `import { os } from "../_generated/rpc"; export default os.internal.work.router({ tick: os.internal.work.tick.handler(({ input }) => input) });`,
    );
    await writeFile(
      join(root, "kello/crons.ts"),
      `import { procedureCron } from "kello/server"; import work from "./internal/work"; export default { ${JSON.stringify(collision)}: procedureCron("* * * * *", work.tick, "tick") };`,
    );
    await assert.rejects(loadProject(root), /Conflicting cron identity/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
