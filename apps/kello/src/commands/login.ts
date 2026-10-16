import { NeonCredentialError, type NeonCredentialOptions } from "kello/tooling";
import { fileURLToPath } from "node:url";

export async function neonLogin(
  options: NeonCredentialOptions & { readonly keyring?: boolean | undefined },
): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY || (process.env.CI && process.env.CI !== "false")) {
    throw new NeonCredentialError("NEON_LOGIN_REQUIRED");
  }
  const args = [process.execPath, fileURLToPath(import.meta.resolve("neon/cli")), "login"];
  if (options.profile) args.push("--profile", options.profile);
  if (options.configDir) args.push("--config-dir", options.configDir);
  if (options.keyring) args.push("--keyring");
  return await Bun.spawn(args, { stdin: "inherit", stdout: "inherit", stderr: "inherit" }).exited;
}

export async function neonProfiles(options: NeonCredentialOptions): Promise<number> {
  const args = [
    process.execPath,
    fileURLToPath(import.meta.resolve("neon/cli")),
    "profile",
    "list",
    "--output",
    "json",
  ];
  if (options.profile) args.push("--profile", options.profile);
  if (options.configDir) args.push("--config-dir", options.configDir);
  return await Bun.spawn(args, {
    env: { ...process.env, CI: "true", DEBUG: "" },
    stdin: "ignore",
    stdout: "inherit",
    stderr: "ignore",
    timeout: 30_000,
  }).exited;
}
