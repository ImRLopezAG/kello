import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    tsconfig: "./tsconfig.json",
    outExtensions: () => ({ js: ".js", dts: ".d.ts" }),
    report: false,
    entry: ["src/cli.ts", "src/tooling/index.ts", "src/tooling/neon/credential-worker.ts"],
    root: "src",
    unbundle: false,
    format: "esm",
    platform: "node",
    target: "es2023",
    dts: true,
    sourcemap: false,
    minify: {
      compress: { keepNames: { function: true, class: true } },
      mangle: { keepNames: true },
      codegen: { legalComments: "inline" },
    },
    deps: {
      neverBundle: true,
      alwaysBundle: [/^(drizzle-kit|zod|@neon\/config(?:-runtime)?)(\/|$)/],
      onlyBundle: [/^(drizzle-kit|zod|@neon\/config(?:-runtime)?)(\/|$)/],
    },
  },
});
