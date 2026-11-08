import { NeonAuthError, createNeonClient } from "@neon/sdk";
import { rmSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as v from "valibot";
import { NeonCredentialError, type NeonCredentialOptions } from "../tooling";
import {
  credentialDirectoryExists,
  credentialsPath,
  readStoredCredentials,
  readStoredKey,
  removeStoredKey,
  saveStoredKey,
  selectProfile,
  withCredentialLock,
  type StoredKey,
} from "../tooling/neon/store";

/** The three Neon API calls login and logout make. */
export interface NeonKeyClient {
  readonly createKey: (keyName: string, signal: AbortSignal) => Promise<{ readonly id: number; readonly key: string }>;
  readonly revokeKey: (keyId: number) => Promise<void>;
  /** False only when Neon rejects the key; any other failure throws. */
  readonly authenticates: () => Promise<boolean>;
}
export interface LoginDependencies {
  readonly interactive: () => boolean;
  /** Runs the official browser sign-in into `configDir`; stops it when `signal` aborts. */
  readonly authorize: (configDir: string, signal: AbortSignal) => Promise<number>;
  readonly client: (token: string) => NeonKeyClient;
  readonly hostname: () => string;
  readonly now: () => Date;
  readonly output: (line: string) => void;
  readonly warn: (line: string) => void;
}
export interface LoginOptions extends NeonCredentialOptions {
  readonly force?: boolean | undefined;
  readonly structured?: boolean | undefined;
}

const keyCreated = v.object({
  id: v.pipe(v.number(), v.integer(), v.minValue(0)),
  key: v.pipe(v.string(), v.minLength(1)),
});

function neonKeyClient(token: string): NeonKeyClient {
  const neon = createNeonClient({ apiKey: token, throwOnError: true, retries: 0, requestTimeoutMs: 30_000 });
  return {
    createKey: async (keyName, signal) => v.parse(keyCreated, await neon.apiKeys.create({ keyName }, { signal })),
    revokeKey: async (keyId) => {
      await neon.apiKeys.revoke({ keyId });
    },
    // Like every other Kello call, one 401/403 is retried; only a repeated rejection means invalid.
    authenticates: async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await neon.user.me();
          return true;
        } catch (cause) {
          if (!(cause instanceof NeonAuthError)) throw cause;
        }
      }
      return false;
    },
  };
}

function interactive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY && (!process.env.CI || process.env.CI === "false"));
}

/** The production sign-in, parameterized by CLI path so tests can substitute a fake Neon CLI. */
export function neonAuthorizer(cli: string): LoginDependencies["authorize"] {
  return async (configDir, signal) => {
    // The temporary directory isolates this sign-in from any existing Neon CLI session. DEBUG is
    // cleared because the Neon CLI then logs the OAuth callback URL, authorization code included.
    const environment = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => name !== "NEON_API_KEY" && name !== "NEON_PROFILE"),
    );
    const child = Bun.spawn([process.execPath, cli, "login", "--config-dir", configDir], {
      env: { ...environment, DEBUG: "" },
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    const stop = () => child.kill();
    signal.addEventListener("abort", stop, { once: true });
    process.on("exit", stop);
    try {
      return await child.exited;
    } finally {
      signal.removeEventListener("abort", stop);
      process.off("exit", stop);
    }
  };
}

export const loginDependencies: LoginDependencies = {
  interactive,
  authorize: neonAuthorizer(fileURLToPath(import.meta.resolve("neon/cli"))),
  client: neonKeyClient,
  hostname,
  now: () => new Date(),
  output: (line) => console.log(line),
  warn: (line) => console.error(line),
};

export function apiKeyName(host: string, now: Date): string {
  const name =
    host
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "host";
  const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return `kello-${name}-${stamp}`;
}

const neonSession = v.object({ access_token: v.pipe(v.string(), v.minLength(1)) });
async function sessionToken(configDir: string): Promise<string> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(await readFile(join(configDir, "credentials.json"), "utf8"));
  } catch {
    throw new NeonCredentialError("NEON_CREDENTIAL_UNAVAILABLE", "Neon sign-in did not produce a session.");
  }
  const parsed = v.safeParse(neonSession, decoded);
  if (!parsed.success)
    throw new NeonCredentialError("NEON_CREDENTIAL_UNAVAILABLE", "Neon sign-in did not produce a session.");
  return parsed.output.access_token;
}

const interruptions = [
  ["SIGINT", 130],
  ["SIGTERM", 143],
  ["SIGHUP", 129],
] as const;
/**
 * Mints one personal API key from a disposable browser session; the session never outlives this
 * call. SIGINT/SIGTERM/SIGHUP stop the sign-in child and any in-flight key creation, and an exit
 * hook removes the session directory synchronously even when the process dies another way.
 */
async function mintKey(deps: LoginDependencies): Promise<{ status: number; key?: StoredKey }> {
  const temporary = await mkdtemp(join(tmpdir(), "kello-login-"));
  const controller = new AbortController();
  let interrupted: number | undefined;
  const handlers = interruptions.map(([name, status]) => {
    const handler = () => {
      interrupted ??= status;
      controller.abort();
    };
    process.on(name, handler);
    return [name, handler] as const;
  });
  const removeNow = () => rmSync(temporary, { recursive: true, force: true });
  process.on("exit", removeNow);
  try {
    const status = await deps.authorize(temporary, controller.signal);
    if (interrupted !== undefined) return { status: interrupted };
    if (status !== 0) return { status };
    const token = await sessionToken(temporary);
    const now = deps.now();
    const keyName = apiKeyName(deps.hostname(), now);
    let created;
    try {
      created = await deps.client(token).createKey(keyName, controller.signal);
    } catch {
      if (interrupted !== undefined) return { status: interrupted };
      throw new NeonCredentialError(
        "NEON_CREDENTIAL_UNAVAILABLE",
        "Neon did not create an API key. Check connectivity and account access, then run kello login again.",
      );
    }
    return {
      status: 0,
      key: { apiKey: created.key, keyId: created.id, keyName, createdAt: now.toISOString() },
    };
  } finally {
    // Hooks stay registered until the session is gone, so a signal or exit during cleanup still removes it.
    await rm(temporary, { recursive: true, force: true });
    for (const [name, handler] of handlers) process.off(name, handler);
    process.off("exit", removeNow);
  }
}

export async function kelloLogin(options: LoginOptions, deps: LoginDependencies = loginDependencies): Promise<number> {
  if (!deps.interactive()) throw new NeonCredentialError("NEON_LOGIN_REQUIRED");
  const profile = selectProfile(options.profile);
  const path = credentialsPath(options.configDir);
  const report = (status: "existing" | "created", key: StoredKey) =>
    deps.output(
      options.structured
        ? JSON.stringify({ ok: true, command: "login", status, profile, keyName: key.keyName, keyId: key.keyId, path })
        : status === "existing"
          ? `Already logged in (profile ${profile}, key ${key.keyName}, id ${key.keyId}). Use kello login --force to replace it.`
          : `Logged in. Stored Neon API key ${key.keyName} (id ${key.keyId}) for profile ${profile} in ${path}.`,
    );
  // One lock spans the whole decision, the browser sign-in and the store update, so a concurrent
  // login or logout cannot interleave, lose a profile or orphan a key.
  return withCredentialLock(options.configDir, async () => {
    const previous = await readStoredKey(profile, options.configDir).catch((cause: Error) => {
      if (options.force && cause instanceof NeonCredentialError && cause.code === "KELLO_CREDENTIALS_INVALID")
        return undefined;
      throw cause;
    });
    if (previous && !options.force) {
      let valid: boolean;
      try {
        valid = await deps.client(previous.apiKey).authenticates();
      } catch {
        // An outage is not a revoked key: never mint a replacement or revoke a key that may work.
        throw new NeonCredentialError(
          "NEON_CREDENTIAL_UNAVAILABLE",
          "Could not reach Neon to check the stored key; nothing was changed. Check connectivity, then retry kello login.",
        );
      }
      if (valid) {
        report("existing", previous);
        return 0;
      }
    }
    const minted = await mintKey(deps);
    if (!minted.key) return minted.status;
    const key = minted.key;
    if (previous) {
      // Best effort: the replaced key is often already revoked, which is why login is replacing it.
      await deps
        .client(previous.apiKey)
        .revokeKey(previous.keyId)
        .catch(() =>
          deps.warn(
            `Could not revoke the previous Neon API key ${previous.keyName} (id ${previous.keyId}); it may still be active. Revoke it with: neon api-keys revoke ${previous.keyId}`,
          ),
        );
    }
    try {
      await saveStoredKey(profile, key, { configDir: options.configDir, replaceInvalid: options.force });
    } catch (cause) {
      // An unsaved key is unusable; do not leave it active. Report it if revocation also fails.
      await deps
        .client(key.apiKey)
        .revokeKey(key.keyId)
        .catch(() =>
          deps.warn(
            `Neon API key ${key.keyName} (id ${key.keyId}) was created but could not be stored or revoked; it is still active. Revoke it with: neon api-keys revoke ${key.keyId}`,
          ),
        );
      throw cause;
    }
    report("created", key);
    return 0;
  });
}

export async function kelloLogout(options: LoginOptions, deps: LoginDependencies = loginDependencies): Promise<number> {
  const profile = selectProfile(options.profile);
  const none = () => {
    deps.output(
      options.structured
        ? JSON.stringify({ ok: true, command: "logout", profile, removed: false })
        : `No stored key for profile ${profile}.`,
    );
    return 0;
  };
  // Decide absence under the lock: a first login may still be in the browser.
  if (!(await credentialDirectoryExists(options.configDir))) return none();
  return withCredentialLock(options.configDir, async () => {
    const stored = await readStoredKey(profile, options.configDir);
    if (!stored) return none();
    // The key authenticates its own revocation; a failure must not keep the local copy.
    const revoked = await deps
      .client(stored.apiKey)
      .revokeKey(stored.keyId)
      .then(
        () => true,
        () => false,
      );
    await removeStoredKey(profile, options.configDir);
    if (!revoked)
      deps.warn(
        `Could not revoke Neon API key ${stored.keyName} (id ${stored.keyId}); it may still be active. Revoke it with: neon api-keys revoke ${stored.keyId}`,
      );
    deps.output(
      options.structured
        ? JSON.stringify({ ok: true, command: "logout", profile, removed: true, revoked, keyName: stored.keyName })
        : `Logged out of profile ${profile}${revoked ? ` and revoked key ${stored.keyName}` : ""}.`,
    );
    return 0;
  });
}

export async function kelloProfiles(
  options: LoginOptions,
  output: (line: string) => void = (line) => console.log(line),
): Promise<number> {
  const stored = await readStoredCredentials(options.configDir);
  const profiles = Object.entries(stored?.profiles ?? {}).map(([name, key]) => ({
    name,
    keyName: key.keyName,
    keyId: key.keyId,
    createdAt: key.createdAt,
  }));
  if (options.structured)
    output(JSON.stringify({ ok: true, command: "profile list", path: credentialsPath(options.configDir), profiles }));
  else if (!profiles.length) output("No stored profiles. Sign in with kello login.");
  else for (const profile of profiles) output(`${profile.name}\t${profile.keyName}\t${profile.createdAt}`);
  return 0;
}
