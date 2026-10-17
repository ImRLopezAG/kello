import { createNeonLoginResolver } from "kello/neon";
import { defineApplication } from "kello/server";
import * as v from "valibot";
import journal from "./components/journal/setup";
const app = defineApplication({
  liveQueries: ({ realtime }) => ({ ...realtime, resolveLogin: createNeonLoginResolver() }),
  env: { APP_ORIGINS: v.optional(v.string(), "http://localhost:5174") },
  rpc: ({ os }) => ({
    os,
    auth: os.use(({ context, next, errors }) => {
      if (!context.identity) throw errors.UNAUTHORIZED();
      return next({ context: { user: context.identity } });
    }),
  }),
});
// Backend-only: expose selected operations through the authenticated app router.
app.use(journal);
export default app;
