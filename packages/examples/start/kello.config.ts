import { defineConfig } from "kello-cli";

export default defineConfig({
  database: {
    migrations: "kello/migrations",
    namespace: "start_app",
    metadataNamespace: "loom_start",
  },
});
