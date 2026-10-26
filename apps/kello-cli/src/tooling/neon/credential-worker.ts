import * as v from "valibot";

const settings = v.parse(
  v.strictObject({ profile: v.optional(v.string()), configDir: v.optional(v.string()) }),
  JSON.parse(process.env.LOOM_NEON_CREDENTIAL_REQUEST ?? "{}"),
);
const authPath = "neon/dist/commands/auth.js";
const configPath = "neon/dist/config.js";
const authModule: unknown = await import(authPath);
const configModule: unknown = await import(configPath);
const { ensureAuth } = v.parse(v.object({ ensureAuth: v.function() }), authModule);
const { defaultDir } = v.parse(v.object({ defaultDir: v.string() }), configModule);
const props = {
  apiKey: "",
  _: ["projects", "list"],
  configDir: settings.configDir ?? defaultDir,
  profile: settings.profile ?? "DEFAULT",
  apiHost: "https://console.neon.tech/api/v2",
  oauthHost: process.env.NEON_OAUTH_HOST ?? "https://oauth2.neon.tech",
  clientId: "neonctl",
};
try {
  await ensureAuth(props);
  const token = v.parse(v.pipe(v.string(), v.minLength(1)), props.apiKey);
  process.stdout.write(JSON.stringify({ token }));
} catch (cause) {
  // Never forward provider messages: OAuth errors can contain credential material.
  const refresh = v.safeParse(v.object({ name: v.literal("AuthRefreshError"), terminal: v.boolean() }), cause);
  const missing = cause instanceof Error && cause.message === "Cannot run interactive auth in CI";
  const code = refresh.success
    ? refresh.output.terminal
      ? "NEON_SESSION_REVOKED"
      : "NEON_REFRESH_FAILED"
    : missing
      ? "NEON_LOGIN_REQUIRED"
      : "NEON_CREDENTIAL_UNAVAILABLE";
  process.stdout.write(JSON.stringify({ code }));
}
