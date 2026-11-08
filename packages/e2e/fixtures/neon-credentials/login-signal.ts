// Runs the production login lifecycle against a fake, blocking Neon CLI so a test can interrupt it.
import { existsSync } from "node:fs";
import { kelloLogin, loginDependencies, neonAuthorizer } from "../../../../apps/kello-cli/src/commands/login";

const [cli, configDir, mode] = process.argv.slice(2);
if (!cli || !configDir) throw new Error("usage: login-signal.ts <cli> <config-dir> <signal|crash>");
if (mode === "crash") {
  // An abrupt exit skips every async `finally`; only exit-time cleanup can run.
  // The test creates the go file once it has observed the session and lock.
  const go = process.env.KELLO_SIGNAL_GO ?? "";
  setInterval(() => {
    if (existsSync(go)) process.exit(1);
  }, 20);
}
process.exitCode = await kelloLogin(
  { configDir },
  {
    ...loginDependencies,
    interactive: () => true,
    authorize: neonAuthorizer(cli),
    output: () => {},
    warn: () => {},
  },
);
