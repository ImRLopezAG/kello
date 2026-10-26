import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { cpus, platform, release, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Layer } from "effect";
import { createComponentServiceRegistry, createEffectRuntime } from "kello/server";
import { generateProject, initializeProject } from "kello-cli";

// Run from the repository with: bun packages/e2e/benchmarks/components.ts
// This uses the already compiled public package. It does not build or access Neon.
const samples = 3;
const sizes = [1, 10, 50];
const compiler = fileURLToPath(new URL("../../../node_modules/.bin/tsc", import.meta.url));

function median(values: readonly number[]) {
  const ordered = [...values].sort((left, right) => left - right);
  const result = ordered[Math.floor(ordered.length / 2)];
  assert(result !== undefined);
  return result;
}

async function timed<Result>(work: () => Promise<Result>) {
  const start = performance.now();
  await work();
  return performance.now() - start;
}

async function fixture(root: string, count: number) {
  await initializeProject(root, "benchmark");
  await mkdir(join(root, "node_modules"));
  for (const name of ["kello", "kello-cli", "valibot", "zod", "drizzle-orm", "effect"]) {
    await symlink(
      await realpath(fileURLToPath(new URL(`../../tests/node_modules/${name}`, import.meta.url))),
      join(root, "node_modules", name),
    );
  }
  const directory = join(root, "kello/components/catalog");
  for (const folder of ["contracts/internal", "functions", "internal"])
    await mkdir(join(directory, folder), { recursive: true });
  const files = {
    "setup.ts": `import { defineComponent } from "./_generated/setup";
export default defineComponent({ name: "catalog", services: () => ({ sdk: { prefix: "item" } }), rpc: ({ os }) => ({ os }) });`,
    "schema.ts": `import { defineSchema } from "kello/server";
export default defineSchema((s) => ({ items: { title: s.text().notNull() } }));`,
    "contracts/items.ts": `import { defineContract, oc } from "../_generated/contract";
import * as v from "valibot";
export default defineContract({ get: oc.input(v.object({ id: v.string() })).output(v.string()) });`,
    "contracts/internal/items.ts": `import { defineContract, oc } from "../../_generated/contract";
import * as v from "valibot";
export default defineContract({ get: oc.input(v.object({ id: v.string() })).output(v.string()) });`,
    "internal/items.ts": `import { os } from "../_generated/rpc";
export default os.internal.items.router({ get: os.internal.items.get.handler(({ context, input }) => context.tables.items.title.name + input.id) });`,
    "functions/items.ts": `import { os } from "../_generated/rpc";
export default os.items.router({ get: os.items.get.handler(({ context, input }) => context.internal.items.get(input)) });`,
  };
  for (const [name, source] of Object.entries(files)) await writeFile(join(directory, name), source);
  const mounts = Array.from({ length: count }, (_, index) => `mount${index}`);
  await writeFile(
    join(root, "kello/app.config.ts"),
    `import { defineApplication } from "kello";
import catalog from "./components/catalog/setup";
const app = defineApplication({ rpc: ({ os }) => ({ os }) });
${mounts.map((name) => `app.use(catalog, { name: "${name}", public: "${name}" });`).join("\n")}
export default app;`,
  );
  await writeFile(
    join(root, "kello/typechecks.ts"),
    `import type { Components } from "./_generated/components";
declare const components: Components;
${mounts.map((name) => `const ${name}: Promise<string> = components.${name}.rpc.items.get({ id: "id" }); void ${name};`).join("\n")}
// @ts-expect-error Input type remains exact through the mounted caller.
components.mount0.rpc.items.get({ id: 1 });
// @ts-expect-error Private routes never enter mounted exports.
void components.mount0.rpc.internal;`,
  );
  await writeFile(
    join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        incremental: false,
        target: "ES2023",
        module: "ESNext",
        moduleResolution: "Bundler",
        skipLibCheck: true,
      },
      include: ["kello/**/*.ts"],
    }),
  );
}

async function generation(count: number) {
  const observations = [];
  for (let sample = 0; sample < samples; sample++) {
    const root = await mkdtemp(join(tmpdir(), "loom-components-benchmark-"));
    try {
      await fixture(root, count);
      const freshGenerationMs = await timed(() => generateProject(root));
      const repeatGenerationMs = await timed(() => generateProject(root));
      const typecheckMs = await timed(async () => {
        const process = Bun.spawn([compiler, "-p", join(root, "tsconfig.json")], {
          cwd: root,
          stdout: "pipe",
          stderr: "pipe",
        });
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(process.stdout).text(),
          new Response(process.stderr).text(),
          process.exited,
        ]);
        assert.equal(exitCode, 0, stdout + stderr);
      });
      observations.push({ freshGenerationMs, repeatGenerationMs, typecheckMs });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
  return {
    count,
    observations,
    median: {
      freshGenerationMs: median(observations.map((value) => value.freshGenerationMs)),
      repeatGenerationMs: median(observations.map((value) => value.repeatGenerationMs)),
      typecheckMs: median(observations.map((value) => value.typecheckMs)),
    },
  };
}

async function services(count: number) {
  const observations = [];
  for (let sample = 0; sample < samples; sample++) {
    let acquired = 0;
    let released = 0;
    const runtime = createEffectRuntime(Layer.empty);
    const factories = Object.fromEntries(
      Array.from({ length: count }, (_, index) => [
        `mount${index}`,
        () =>
          Effect.acquireRelease(
            Effect.sync(() => {
              acquired++;
              return { index };
            }),
            () =>
              Effect.sync(() => {
                released++;
              }),
          ),
      ]),
    );
    const registry = createComponentServiceRegistry(runtime, factories);
    const batch = () =>
      registry.run("allowed", () => Promise.all(Object.keys(factories).map((key) => registry.get(key))));
    try {
      const coldBatchMs = await timed(batch);
      // Same acquisition workload; only registry readiness differs.
      const warmBatches = [];
      for (let repeat = 0; repeat < 100; repeat++) warmBatches.push(await timed(batch));
      assert.equal(acquired, count);
      observations.push({ coldBatchMs, warmBatchMedianMs: median(warmBatches), acquired });
    } finally {
      await runtime.stop();
    }
    assert.equal(released, count);
  }
  return {
    count,
    observations,
    median: {
      coldBatchMs: median(observations.map((value) => value.coldBatchMs)),
      warmBatchMs: median(observations.map((value) => value.warmBatchMedianMs)),
    },
  };
}

const generationResults = [];
const serviceResults = [];
for (const size of sizes) {
  generationResults.push(await generation(size));
  serviceResults.push(await services(size));
}
console.log(
  JSON.stringify(
    {
      environment: {
        bun: Bun.version,
        nodeCompatibility: process.version,
        platform: platform(),
        release: release(),
        cpu: cpus()[0]?.model,
        logicalCpus: cpus().length,
      },
      methodology:
        "Three fresh directories per mount count, one shared component definition with schema, public/private contracts, generated typed callers. Fresh means absent generated files; OS and dependency caches are not flushed. Generation runs in the same Bun process. Repeat generation uses the same unchanged directory. Each typecheck starts a new TS process without incremental cache and verifies negative assertions. Service batches acquire every mounted instance concurrently in a new runtime generation; 100 equivalent warm batches follow each cold batch. Registry-only timings exclude transport, database and vendor network latency. No before/after performance claim.",
      samples,
      generation: generationResults,
      services: serviceResults,
    },
    null,
    2,
  ),
);
