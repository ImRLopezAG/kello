import { AsyncLocalStorage } from "node:async_hooks";
import { closeSync, constants, fstatSync, openSync, readFileSync, rmSync, type Stats } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import * as v from "valibot";
import { NeonCredentialError } from "./credentials";

export const defaultProfile = "default";
const profileName = v.pipe(v.string(), v.regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/));
const storedKey = v.strictObject({
  apiKey: v.pipe(v.string(), v.minLength(1)),
  keyId: v.pipe(v.number(), v.integer(), v.minValue(0)),
  keyName: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
  createdAt: v.pipe(v.string(), v.isoTimestamp()),
});
const credentialFile = v.strictObject({ version: v.literal(1), profiles: v.record(profileName, storedKey) });
export type StoredKey = v.InferOutput<typeof storedKey>;
type CredentialFile = v.InferOutput<typeof credentialFile>;

/** `--config-dir` names Kello's directory directly; otherwise it is `$XDG_CONFIG_HOME/kello`. */
export function credentialDirectory(configDir?: string): string {
  if (configDir) return configDir;
  return join(process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config"), "kello");
}
export function credentialsPath(configDir?: string): string {
  return join(credentialDirectory(configDir), "credentials.json");
}
export function selectProfile(profile?: string): string {
  const selected = profile ?? (process.env.KELLO_PROFILE?.trim() || defaultProfile);
  if (!v.is(profileName, selected))
    throw new NeonCredentialError(
      "KELLO_CREDENTIALS_INVALID",
      "Profile names start with a letter or digit and contain only letters, digits, '.', '_' or '-'.",
    );
  return selected;
}

function unsafe(path: string, reason: string): NeonCredentialError {
  return new NeonCredentialError(
    "KELLO_CREDENTIALS_UNSAFE",
    `Refusing to use ${path}: ${reason}. Fix its ownership and permissions (directory 0700, file 0600), then retry.`,
  );
}
function invalid(path: string): NeonCredentialError {
  return new NeonCredentialError(
    "KELLO_CREDENTIALS_INVALID",
    `${path} is not a valid Kello credentials file. Inspect it, or replace it with kello login --force.`,
  );
}
function missing(cause: Error): boolean {
  return errorCode(cause, "ENOENT");
}
// Windows has no POSIX owner or mode bits; there the file system ACL is the only guard.
function owned(path: string, state: Stats, kind: "file" | "directory"): void {
  const uid = process.getuid?.();
  if (uid === undefined) return;
  if (state.uid !== uid) throw unsafe(path, `the ${kind} is not owned by the current user`);
  if ((state.mode & 0o077) !== 0) throw unsafe(path, `the ${kind} is accessible to group or other users`);
}

/**
 * Resolves the config directory once to its canonical path and validates that path. Every later
 * operation in the same call uses only the returned path, so a symlinked ancestor swapped after
 * validation cannot redirect it. System aliases such as /var -> /private/var resolve normally.
 */
async function canonicalDirectory(configDir: string | undefined, create: boolean): Promise<string | undefined> {
  const requested = credentialDirectory(configDir);
  if (create) await mkdir(dirname(requested), { recursive: true, mode: 0o700 });
  const parent = await realpath(dirname(requested)).catch((cause: Error) => {
    if (missing(cause)) return undefined;
    throw cause;
  });
  if (!parent) return undefined;
  const directory = join(parent, basename(requested));
  let state = await lstat(directory).catch((cause: Error) => {
    if (missing(cause)) return undefined;
    throw cause;
  });
  if (!state) {
    if (!create) return undefined;
    await mkdir(directory, { mode: 0o700 }).catch((cause: Error) => {
      if (!errorCode(cause, "EEXIST")) throw cause;
    });
    state = await lstat(directory);
  }
  if (state.isSymbolicLink()) throw unsafe(directory, "the directory is a symbolic link");
  if (!state.isDirectory()) throw unsafe(directory, "the path is not a directory");
  owned(directory, state, "directory");
  await checkedAncestors(directory);
  return directory;
}

/**
 * Whoever can write an ancestor can swap the path below it between the check and its use, so,
 * like OpenSSH StrictModes, every resolved ancestor up to `/` is checked. The immediate parent
 * must belong to the current user and be writable only by them; higher ancestors may belong to
 * root, and may be group- or world-writable only with the sticky bit (as `/tmp` is).
 */
async function checkedAncestors(directory: string): Promise<void> {
  const uid = process.getuid?.();
  if (uid === undefined) return;
  let current = dirname(directory);
  // The canonical chain must still be canonical: a component swapped for a link is refused.
  if ((await realpath(current)) !== current) throw unsafe(current, "the path changed while it was being checked");
  const parent = await stat(current);
  if (parent.uid !== uid || (parent.mode & 0o022) !== 0)
    throw unsafe(current, "the parent directory is not owned by the current user or is writable by others");
  while (dirname(current) !== current) {
    current = dirname(current);
    const state = await stat(current);
    if (state.uid !== uid && state.uid !== 0) throw unsafe(current, "an ancestor directory is owned by another user");
    if ((state.mode & 0o022) !== 0 && (state.mode & 0o1000) === 0)
      throw unsafe(current, "an ancestor directory is writable by others without the sticky bit");
  }
}

async function readFileState(configDir?: string): Promise<CredentialFile | undefined> {
  const directory = await canonicalDirectory(configDir, false);
  return directory ? readFileAt(directory) : undefined;
}
async function readFileAt(directory: string): Promise<CredentialFile | undefined> {
  const path = join(directory, "credentials.json");
  const link = await lstat(path).catch((cause: Error) => {
    if (missing(cause)) return undefined;
    throw cause;
  });
  if (!link) return undefined;
  if (link.isSymbolicLink()) throw unsafe(path, "the file is a symbolic link");
  // O_NOFOLLOW closes the window between the check above and the read.
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const state = await handle.stat();
    if (!state.isFile()) throw unsafe(path, "the path is not a regular file");
    owned(path, state, "file");
    const text = await handle.readFile("utf8");
    let decoded: unknown;
    try {
      decoded = JSON.parse(text);
    } catch {
      throw invalid(path);
    }
    const parsed = v.safeParse(credentialFile, decoded);
    if (!parsed.success) throw invalid(path);
    return parsed.output;
  } finally {
    await handle.close();
  }
}

export async function readStoredCredentials(configDir?: string): Promise<CredentialFile | undefined> {
  return readFileState(configDir);
}
export async function readStoredKey(profile: string, configDir?: string): Promise<StoredKey | undefined> {
  return (await readFileState(configDir))?.profiles[profile];
}

async function writeFileAt(directory: string, state: CredentialFile): Promise<void> {
  const path = join(directory, "credentials.json");
  const temporary = join(directory, `.credentials-${crypto.randomUUID()}.tmp`);
  try {
    const handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.chmod(0o600);
      await handle.writeFile(`${JSON.stringify(v.parse(credentialFile, state), null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

const lockHolders = new AsyncLocalStorage<ReadonlySet<string>>();
const lockRecord = v.strictObject({ pid: v.pipe(v.number(), v.integer(), v.minValue(1)), token: v.string() });
function errorCode(cause: unknown, code: string): boolean {
  return v.is(v.object({ code: v.literal(code) }), cause);
}
function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return !errorCode(cause, "ESRCH");
  }
}
/**
 * Reads the lock without following links. A symlinked, foreign or non-regular lock is unsafe
 * rather than busy: it is not something a Kello process wrote.
 */
function readLock(path: string): { text: string; mtimeMs: number } | undefined {
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (cause) {
    if (errorCode(cause, "ENOENT")) return undefined;
    if (errorCode(cause, "ELOOP") || errorCode(cause, "EMLINK")) throw unsafe(path, "the lock is a symbolic link");
    throw cause;
  }
  try {
    const state = fstatSync(descriptor);
    if (!state.isFile()) throw unsafe(path, "the lock is not a regular file");
    owned(path, state, "file");
    return { text: readFileSync(descriptor, "utf8"), mtimeMs: state.mtimeMs };
  } finally {
    closeSync(descriptor);
  }
}
function parseLock(text: string) {
  try {
    const parsed = v.safeParse(lockRecord, JSON.parse(text));
    return parsed.success ? parsed.output : undefined;
  } catch {
    return undefined;
  }
}
/** A lock is stale when its process is gone, or when it was never fully written. */
function staleLock(path: string): boolean {
  const lock = readLock(path);
  if (!lock) return false;
  const record = parseLock(lock.text);
  if (!record) return Date.now() - lock.mtimeMs > 10_000;
  return !running(record.pid);
}
/** Locks this process could not remove; their exit hooks stay until removal succeeds. */
const unreleased = new Map<string, { readonly token: string; readonly hook: () => void }>();
/**
 * True when the lock is gone or belongs to someone else, i.e. nothing of ours remains. A lock
 * that cannot be read or removed is a failed release, never assumed released.
 */
function releaseLock(path: string, token: string): boolean {
  try {
    const lock = readLock(path);
    if (lock && parseLock(lock.text)?.token === token) rmSync(path, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Serializes every read-modify-write of one credentials directory across processes. Reentrant
 * within one async call chain, so login can hold it across its whole decision and still save.
 * The lock file is also removed synchronously at process exit.
 */
export async function withCredentialLock<T>(
  configDir: string | undefined,
  run: (directory: string) => Promise<T>,
  timeoutMs = 30_000,
): Promise<T> {
  const directory = await canonicalDirectory(configDir, true);
  if (!directory) throw unsafe(credentialDirectory(configDir), "the directory could not be created");
  const path = join(directory, "credentials.lock");
  const holders = lockHolders.getStore();
  if (holders?.has(path)) return run(directory);
  const token = crypto.randomUUID();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let handle;
    try {
      handle = await open(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
    } catch (cause) {
      if (!errorCode(cause, "EEXIST")) throw cause;
    }
    if (handle) {
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, token }));
        await handle.close();
      } catch (cause) {
        // A partially written lock would otherwise block others until it ages out.
        await handle.close().catch(() => undefined);
        await rm(path, { force: true }).catch(() => undefined);
        throw cause;
      }
      break;
    }
    // A lock this process failed to release earlier is retried rather than waited on.
    const previous = unreleased.get(path);
    if (previous && releaseLock(path, previous.token)) {
      process.off("exit", previous.hook);
      unreleased.delete(path);
      continue;
    }
    if (staleLock(path)) {
      await rm(path, { force: true });
      continue;
    }
    if (Date.now() >= deadline)
      throw new NeonCredentialError(
        "KELLO_CREDENTIALS_BUSY",
        `Another kello login or logout is using ${directory}. Wait for it to finish, then retry.`,
      );
    await sleep(50);
  }
  const hook = () => {
    releaseLock(path, token);
  };
  process.on("exit", hook);
  try {
    return await lockHolders.run(new Set([...(holders ?? []), path]), () => run(directory));
  } finally {
    // Release never throws, so it cannot replace the operation's own outcome. On failure the
    // exit hook stays registered and the next acquisition in this process retries removal.
    if (releaseLock(path, token)) process.off("exit", hook);
    else {
      unreleased.set(path, { token, hook });
      console.error(`Could not remove the Kello credentials lock ${path}; it is removed when this process exits.`);
    }
  }
}

/** Replaces one profile atomically. `replaceInvalid` lets `login --force` recover an unreadable file. */
export async function saveStoredKey(
  profile: string,
  key: StoredKey,
  options: { readonly configDir?: string | undefined; readonly replaceInvalid?: boolean | undefined } = {},
): Promise<string> {
  return withCredentialLock(options.configDir, async (directory) => {
    const current = await readFileAt(directory).catch((cause: Error) => {
      if (options.replaceInvalid && cause instanceof NeonCredentialError && cause.code === "KELLO_CREDENTIALS_INVALID")
        return undefined;
      throw cause;
    });
    await writeFileAt(directory, { version: 1, profiles: { ...current?.profiles, [selectProfile(profile)]: key } });
    return credentialsPath(options.configDir);
  });
}

/** Without the directory no lock can be held, so nothing is stored or about to be. */
export async function credentialDirectoryExists(configDir?: string): Promise<boolean> {
  return lstat(credentialDirectory(configDir)).then(
    () => true,
    (cause: Error) => {
      if (missing(cause)) return false;
      throw cause;
    },
  );
}

/** Returns whether the profile existed. The file is removed once no profile remains. */
export async function removeStoredKey(profile: string, configDir?: string): Promise<boolean> {
  if (!(await credentialDirectoryExists(configDir))) return false;
  return withCredentialLock(configDir, async (directory) => {
    const current = await readFileAt(directory);
    if (!current?.profiles[profile]) return false;
    const profiles = Object.fromEntries(Object.entries(current.profiles).filter(([name]) => name !== profile));
    if (Object.keys(profiles).length) await writeFileAt(directory, { version: 1, profiles });
    else await rm(join(directory, "credentials.json"), { force: true });
    return true;
  });
}
