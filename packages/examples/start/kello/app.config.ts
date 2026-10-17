import greeting from "./components/greeting/setup";
import { createNeonLoginResolver } from "kello/neon";
import { defineApplication } from "kello/server";
import * as v from "valibot";
const app = defineApplication({
  liveQueries: ({ realtime }) => ({ ...realtime, resolveLogin: createNeonLoginResolver() }),
  env: {
    APP_ORIGINS: v.optional(v.string(), "http://localhost:3001"),
    GREETING_PREFIX: v.optional(v.string(), "Hello"),
  },
  rpc: ({ os }) => ({
    os,
    auth: os.use(({ context, next, errors }) => {
      if (!context.identity) throw errors.UNAUTHORIZED();
      return next({ context: { user: context.identity } });
    }),
  }),
});

app.use(greeting, { env: { PREFIX: app.env.GREETING_PREFIX } });
export default app;
