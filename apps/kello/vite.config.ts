import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    tsconfig: "tsconfig.build.json",
    outExtensions: () => ({ js: ".js", dts: ".d.ts" }),
    report: false,
    entry: [
      "src/index.ts",
      "src/cli.ts",
      "src/core/contract/index.ts",
      "src/core/server/index.ts",
      "src/core/client/index.ts",
      "src/core/react/index.ts",
      "src/core/react/neon.ts",
      "src/core/better-auth/index.ts",
      "src/core/next/server.ts",
      "src/core/start/server.ts",
      "src/core/adapters/neon/index.ts",
      "src/tooling/index.ts",
      "src/tooling/neon/credential-worker.ts",
    ],
    root: "src",
    unbundle: false,
    format: "esm",
    platform: "node",
    target: "es2023",
    dts: true,
    sourcemap: true,
    deps: {
      neverBundle: true,
      alwaysBundle: [/^(drizzle-kit|zod|@neon\/config(?:-runtime)?|@neon\/realtime-drizzle)(\/|$)/],
      onlyBundle: [/^(drizzle-kit|zod|@neon\/config(?:-runtime)?|@neon\/realtime-drizzle)(\/|$)/],
    },
  },
});
