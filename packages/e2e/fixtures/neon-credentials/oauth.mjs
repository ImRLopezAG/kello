// Fixture uses the pinned CLI's persistence API, not a second credential-file writer.
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const require = createRequire(new URL("../../../../apps/kello/package.json", import.meta.url));
const { storeFor } = await import(pathToFileURL(require.resolve("neon/dist/credential_io.js")).href);
const { locationForAuth } = await import(pathToFileURL(require.resolve("neon/dist/commands/auth.js")).href);
const dir = process.argv[2];
storeFor(dir).write(locationForAuth(dir, "DEFAULT"), {
  type: "oauth",
  access_token: "fixture-expired",
  refresh_token: "fixture-refresh",
  expires_at: 1,
});
