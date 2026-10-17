import greeting from "./components/greeting/setup";
import { createNeonLoginResolver } from "kello/neon";
import { defineApplication } from "kello/server";
import { z } from "zod";
const app = defineApplication({
  liveQueries: ({ realtime }) => ({ ...realtime, resolveLogin: createNeonLoginResolver() }),
  env: { APP_ORIGINS: z.string().default("http://localhost:3000"), GREETING_PREFIX: z.string().default("Hello") },
  rpc: ({ os }) => ({
    os,
    auth: os.use(({ context, next, errors }) => {
      if (!context.identity) throw errors.UNAUTHORIZED();
      return next({
        context: {
          user: context.identity,
        },
      });
    }),
  }),
});

app.use(greeting, { env: { PREFIX: app.env.GREETING_PREFIX } });
export default app;
