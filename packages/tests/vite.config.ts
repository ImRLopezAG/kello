import { defineConfig } from "vite-plus";
import { fileURLToPath } from "node:url";

// Source unit tests must share runtime registries and branded types with source tooling.
// Packed integration tests separately verify the published package boundaries.
const entries = {
  "kello/react/neon": "core/react/neon.ts",
  "kello/internal/tooling": "internal/tooling.ts",
  "kello/neon": "core/adapters/neon/index.ts",
  "kello/better-auth": "core/better-auth/index.ts",
  "kello/contract": "core/contract/index.ts",
  "kello/server": "core/server/index.ts",
  "kello/client": "core/client/index.ts",
  "kello/react": "core/react/index.ts",
  "kello-cli": "../../kello-cli/src/tooling/index.ts",
  kello: "index.ts",
};

export default defineConfig({
  resolve: {
    alias: Object.entries(entries).map(([name, entry]) => ({
      find: new RegExp(`^${name}$`),
      replacement: fileURLToPath(new URL(`../../apps/kello/src/${entry}`, import.meta.url)),
    })),
  },
  test: { include: ["unit/**/*.test.{ts,tsx}"], maxWorkers: 4 },
});
