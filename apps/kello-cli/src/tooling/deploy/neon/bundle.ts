import { dirname, resolve } from "node:path";
import { zipSync } from "fflate";

const DRIZZLE_TRANSPORT_REGISTRATION = /[\\/]drizzle-orm[\\/]postgres[\\/]client[\\/]dist[\\/]index\.js$/;

/** Builds a self-contained Node 24 function with the application's development toolchain. */
export async function buildNeonFunctionBundle(source: string): Promise<Uint8Array> {
  let pack: typeof import("vite-plus/pack");
  try {
    pack = await import("vite-plus/pack");
  } catch (cause) {
    throw new Error("Deploying Neon Functions requires vite-plus in your project's devDependencies", { cause });
  }
  const entry = resolve(source);
  const handle = await pack.build({
    config: false,
    cwd: dirname(entry),
    entry: { index: entry },
    platform: "node",
    target: "node24",
    format: "esm",
    outExtensions: () => ({ js: ".mjs" }),
    deps: { alwaysBundle: [/.*/], onlyBundle: false, onlyImport: [] },
    // drizzle-orm declares `sideEffects: false`, so tree shaking drops the module that registers the
    // driver's Node TCP transport and connections fail with "no transport" (drizzle-team/drizzle-orm#6715).
    // Remove this override once upstream marks that module as having side effects.
    treeshake: { moduleSideEffects: (id) => (DRIZZLE_TRANSPORT_REGISTRATION.test(id) ? true : undefined) },
    dts: false,
    sourcemap: false,
    minify: true,
    write: false,
    clean: false,
    report: false,
  });
  try {
    const files: Record<string, Uint8Array> = {};
    for (const bundle of handle.bundles) {
      for (const chunk of bundle.chunks) {
        files[chunk.fileName] =
          chunk.type === "chunk"
            ? new TextEncoder().encode(chunk.code)
            : chunk.source instanceof Uint8Array
              ? chunk.source
              : new TextEncoder().encode(chunk.source);
      }
    }
    if (!files["index.mjs"]) throw new Error("Neon function build did not produce index.mjs");
    return zipSync(files, { level: 6 });
  } finally {
    for (const bundle of handle.bundles) await bundle[Symbol.asyncDispose]();
  }
}
