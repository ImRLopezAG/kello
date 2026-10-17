import { createNeonLoginResolver } from "kello/neon";
import { defineApplication } from "kello/server";
import health from "./components/health/setup";

const app = defineApplication({
  liveQueries: ({ realtime }) => ({ ...realtime, resolveLogin: createNeonLoginResolver() }),
  rpc: ({ os }) => ({ os }),
});
app.use(health);
export default app;
