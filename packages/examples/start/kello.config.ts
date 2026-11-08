import { defineConfig } from "kello-cli";

export default defineConfig({
  database: {
    migrations: "kello/migrations",
    namespace: "start_app",
    metadataNamespace: "kello_start",
  },
});
