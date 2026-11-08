import { defineConfig } from "kello-cli";

export default defineConfig({
  database: {
    migrations: "kello/migrations",
    namespace: "next_app",
    metadataNamespace: "kello_next",
  },
});
