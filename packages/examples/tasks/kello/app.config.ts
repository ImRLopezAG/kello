import titles from "./components/titles/setup";
import { createNeonLoginResolver } from "kello/neon";
import { defineApplication } from "kello/server";
import * as v from "valibot";
const app = defineApplication({
  liveQueries: ({ realtime }) => ({ ...realtime, resolveLogin: createNeonLoginResolver() }),
  env: { APP_ORIGINS: v.optional(v.string(), "http://localhost:5173") },
  rpc: ({ os }) => ({ os }),
});

app.use(titles);
export default app;
