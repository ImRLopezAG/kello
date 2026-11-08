// Stands in for `neon login`: leaves a session in the config directory, records the environment
// it was given (never key values), then blocks like a browser sign-in waiting for the user.
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const configDir = args[args.indexOf("--config-dir") + 1];
writeFileSync(
  join(configDir, "credentials.json"),
  JSON.stringify({ access_token: "fixture-access", refresh_token: "fixture-refresh-secret" }),
);
writeFileSync(
  process.env.KELLO_SIGNAL_RECORD,
  JSON.stringify({
    pid: process.pid,
    args,
    configDir,
    debug: process.env.DEBUG ?? null,
    apiKeyPresent: process.env.NEON_API_KEY !== undefined,
    profilePresent: process.env.NEON_PROFILE !== undefined,
  }),
);
setInterval(() => {}, 1000);
