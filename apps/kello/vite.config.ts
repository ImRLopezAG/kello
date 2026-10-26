import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    tsconfig: "tsconfig.build.json",
    outExtensions: () => ({ js: ".js", dts: ".d.ts" }),
    report: false,
    entry: [
      "src/index.ts",
      "src/internal/tooling.ts",
      "src/core/contract/index.ts",
      "src/core/server/index.ts",
      "src/core/client/index.ts",
      "src/core/react/index.ts",
      "src/core/react/neon.ts",
      "src/core/better-auth/index.ts",
      "src/core/adapters/neon/index.ts",
    ],
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
      alwaysBundle: [/^(@neon\/realtime-drizzle)(\/|$)/],
      onlyBundle: [/^(@neon\/realtime-drizzle)(\/|$)/],
    },
  },
});
