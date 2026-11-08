import assert from "node:assert/strict";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import * as filesystem from "node:fs/promises";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  kelloLogin,
  kelloLogout,
  kelloProfiles,
  loginDependencies,
  type LoginDependencies,
} from "../../../apps/kello-cli/src/commands/login";
import { withNeonCredentials } from "../../../apps/kello-cli/src/tooling/neon/api";
import { readStoredKey, saveStoredKey } from "../../../apps/kello-cli/src/tooling/neon/store";
import { writeNeonLink } from "../../../apps/kello-cli/src/tooling/project/link";

const minted = "napi_fixture-minted-secret";
const oauth = "fixture-oauth-session-secret";
const old = {
  apiKey: "napi_fixture-old-secret",
  keyId: 1,
  keyName: "kello-old",
  createdAt: "2026-11-01T00:00:00.000Z",
};
let base: string;
let root: string;
let consoleLog: ReturnType<typeof spyOn>;
let consoleError: ReturnType<typeof spyOn>;
beforeEach(async () => {
  // A private parent, as the store requires; the system temp root may be shared (Linux /tmp).
  base = await mkdtemp(join(tmpdir(), "kello-login-test-"));
  root = join(base, "home");
  await mkdir(root, { mode: 0o700 });
  consoleLog = spyOn(console, "log");
  consoleError = spyOn(console, "error");
});
afterEach(async () => {
  // No path may print key material, whether through the seams or the console.
  for (const spy of [consoleLog, consoleError]) {
    for (const call of spy.mock.calls)
      for (const value of [minted, oauth, old.apiKey]) expect(String(call)).not.toContain(value);
    spy.mockRestore();
  }
  await rm(base, { recursive: true, force: true });
});

function fixture(overrides: Partial<LoginDependencies> = {}) {
  const calls: string[] = [];
  const lines: string[] = [];
  const warnings: string[] = [];
  const sessions: string[] = [];
  const state = { valid: true, createFails: false, revokeFails: false };
  const deps: LoginDependencies = {
    interactive: () => true,
    authorize: async (configDir) => {
      sessions.push(configDir);
      calls.push("authorize");
      await writeFile(join(configDir, "credentials.json"), JSON.stringify({ access_token: oauth, refresh_token: "r" }));
      return 0;
    },
    client: (token) => {
      const who = token === oauth ? "session" : token === minted ? "minted" : token === old.apiKey ? "old" : "other";
      return {
        createKey: async (keyName) => {
          calls.push(`create:${who}:${keyName}`);
          if (state.createFails) throw new Error(`provider echoed ${token}`);
          return { id: 42, key: minted };
        },
        revokeKey: async (keyId) => {
          calls.push(`revoke:${who}:${keyId}`);
          if (state.revokeFails) throw new Error(`provider echoed ${token}`);
        },
        authenticates: async () => {
          calls.push(`me:${who}`);
          return state.valid;
        },
      };
    },
    hostname: () => "Dev Box.local",
    now: () => new Date("2026-11-08T09:08:07.000Z"),
    output: (line) => lines.push(line),
    warn: (line) => warnings.push(line),
    ...overrides,
  };
  const printed = () => [...lines, ...warnings].join("\n");
  return { deps, calls, lines, warnings, sessions, state, printed };
}

test("login mints a named personal key from a disposable session and stores only that key", async () => {
  const f = fixture();
  expect(await kelloLogin({ configDir: root }, f.deps)).toBe(0);
  expect(f.calls).toEqual(["authorize", "create:session:kello-dev-box-local-20261108-090807"]);
  expect(await readStoredKey("default", root)).toEqual({
    apiKey: minted,
    keyId: 42,
    keyName: "kello-dev-box-local-20261108-090807",
    createdAt: "2026-11-08T09:08:07.000Z",
  });
  expect(f.sessions).toHaveLength(1);
  expect(existsSync(f.sessions[0] ?? "")).toBe(false);
  expect(f.printed()).toContain("kello-dev-box-local-20261108-090807");
  expect(f.printed()).toContain(join(root, "credentials.json"));
  for (const value of [minted, oauth]) {
    expect(f.printed()).not.toContain(value);
  }
  expect(await readFile(join(root, "credentials.json"), "utf8")).not.toContain(oauth);
});

test("login removes the session directory when sign-in or key creation fails", async () => {
  const declined = fixture({
    authorize: async (configDir) => {
      declined.sessions.push(configDir);
      return 130;
    },
  });
  expect(await kelloLogin({ configDir: root }, declined.deps)).toBe(130);
  expect(existsSync(declined.sessions[0] ?? "")).toBe(false);
  const failing = fixture();
  failing.state.createFails = true;
  const failure = await kelloLogin({ configDir: root }, failing.deps).catch((cause: Error) => cause);
  assert.ok(failure instanceof Error);
  expect(failure).toMatchObject({ code: "NEON_CREDENTIAL_UNAVAILABLE" });
  expect(failure.message).not.toContain(oauth);
  expect(existsSync(failing.sessions[0] ?? "")).toBe(false);
  const empty = fixture({ authorize: async () => 0 });
  await assert.rejects(kelloLogin({ configDir: root }, empty.deps), { code: "NEON_CREDENTIAL_UNAVAILABLE" });
  expect(await readStoredKey("default", root)).toBeUndefined();
});

test("login refuses non-interactive use", async () => {
  const f = fixture({ interactive: () => false });
  await assert.rejects(kelloLogin({ configDir: root }, f.deps), { code: "NEON_LOGIN_REQUIRED" });
  expect(f.calls).toEqual([]);
});

test("a working stored key short-circuits login; a rejected one is replaced", async () => {
  await saveStoredKey("default", old, { configDir: root });
  const f = fixture();
  expect(await kelloLogin({ configDir: root }, f.deps)).toBe(0);
  expect(f.calls).toEqual(["me:old"]);
  expect(f.printed()).toContain("Already logged in");
  const stale = fixture();
  stale.state.valid = false;
  expect(await kelloLogin({ configDir: root }, stale.deps)).toBe(0);
  expect((await readStoredKey("default", root))?.apiKey).toBe(minted);
});

test("login --force revokes the old key, then replaces it", async () => {
  await saveStoredKey("default", old, { configDir: root });
  await saveStoredKey("work", { ...old, keyId: 9 }, { configDir: root });
  const f = fixture();
  expect(await kelloLogin({ configDir: root, force: true }, f.deps)).toBe(0);
  expect(f.calls).toEqual(["authorize", "create:session:kello-dev-box-local-20261108-090807", "revoke:old:1"]);
  expect((await readStoredKey("default", root))?.keyId).toBe(42);
  expect((await readStoredKey("work", root))?.keyId).toBe(9);
  const unrevoked = fixture();
  unrevoked.state.revokeFails = true;
  await saveStoredKey("default", old, { configDir: root });
  expect(await kelloLogin({ configDir: root, force: true }, unrevoked.deps)).toBe(0);
  expect(unrevoked.warnings.join("\n")).toContain("may still be active");
  expect(unrevoked.printed()).not.toContain(old.apiKey);
});

test("login --force recovers a corrupt file that plain login refuses", async () => {
  await writeFile(join(root, "credentials.json"), "{corrupt", { mode: 0o600 });
  await assert.rejects(kelloLogin({ configDir: root }, fixture().deps), { code: "KELLO_CREDENTIALS_INVALID" });
  expect(await kelloLogin({ configDir: root, force: true }, fixture().deps)).toBe(0);
  expect((await readStoredKey("default", root))?.apiKey).toBe(minted);
});

test("logout revokes then removes, and still removes when revocation fails", async () => {
  await saveStoredKey("default", old, { configDir: root });
  await saveStoredKey("work", { ...old, keyId: 9 }, { configDir: root });
  const f = fixture();
  expect(await kelloLogout({ configDir: root }, f.deps)).toBe(0);
  expect(f.calls).toEqual(["revoke:old:1"]);
  expect(await readStoredKey("default", root)).toBeUndefined();
  const failing = fixture();
  failing.state.revokeFails = true;
  expect(await kelloLogout({ configDir: root, profile: "work" }, failing.deps)).toBe(0);
  expect(failing.warnings.join("\n")).toContain("may still be active");
  expect(failing.printed()).not.toContain(old.apiKey);
  expect(existsSync(join(root, "credentials.json"))).toBe(false);
  const none = fixture();
  expect(await kelloLogout({ configDir: root }, none.deps)).toBe(0);
  expect(none.calls).toEqual([]);
});

test("profile list reports names and key names, never keys", async () => {
  await saveStoredKey("default", old, { configDir: root });
  const lines: string[] = [];
  expect(await kelloProfiles({ configDir: root, structured: true }, (line) => lines.push(line))).toBe(0);
  expect(JSON.parse(lines[0] ?? "")).toEqual({
    ok: true,
    command: "profile list",
    path: join(root, "credentials.json"),
    profiles: [{ name: "default", keyName: "kello-old", keyId: 1, createdAt: old.createdAt }],
  });
  await kelloProfiles({ configDir: root }, (line) => lines.push(line));
  expect(lines.join("\n")).not.toContain(old.apiKey);
});

test("link passes the resolved key to the Neon CLI through the environment only", async () => {
  const originalFetch = globalThis.fetch;
  const previousProfile = process.env.NEON_PROFILE;
  const project = join(root, "project");
  const record = join(root, "record.json");
  const previous = {
    KELLO_LINK_RECORD: process.env.KELLO_LINK_RECORD,
    KELLO_LINK_EXPECTED_KEY: process.env.KELLO_LINK_EXPECTED_KEY,
  };
  try {
    await saveStoredKey("default", old, { configDir: join(root, "kello") });
    await mkdir(project);
    process.env.KELLO_LINK_RECORD = record;
    process.env.KELLO_LINK_EXPECTED_KEY = old.apiKey;
    process.env.NEON_PROFILE = "ignored";
    globalThis.fetch = Object.assign(
      async () => Response.json({ project: { id: "project", name: "fixture", org_id: "org-fixture" } }),
      { preconnect: originalFetch.preconnect },
    );
    await withNeonCredentials({ configDir: join(root, "kello"), profile: "default" }, () =>
      writeNeonLink(
        project,
        {
          format: 1,
          projectId: "project",
          branchId: "br-fixture",
          branchName: "dev",
          protected: false,
          isDefault: false,
          databaseName: "neondb",
          migrationRole: "neondb_owner",
          public: {},
        },
        join(import.meta.dir, "../fixtures/neon-credentials/link-cli.mjs"),
      ),
    );
    const seen = JSON.parse(await readFile(record, "utf8"));
    expect(seen.keyFromEnvironment).toBe(true);
    expect(seen.profile).toBeNull();
    expect(seen.ci).toBe("true");
    expect(seen.args.join(" ")).not.toContain(old.apiKey);
    expect(seen.args).not.toContain("--config-dir");
    expect(seen.args).not.toContain("--profile");
    expect(JSON.parse(await readFile(join(project, ".neon"), "utf8"))).toEqual({ projectId: "project" });
  } finally {
    globalThis.fetch = originalFetch;
    for (const [name, value] of Object.entries({ ...previous, NEON_PROFILE: previousProfile })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("an unreachable Neon aborts login without minting or revoking anything", async () => {
  await saveStoredKey("default", old, { configDir: root });
  const f = fixture();
  const outage = f.deps.client;
  const deps: LoginDependencies = {
    ...f.deps,
    client: (token) => ({
      ...outage(token),
      authenticates: async () => {
        f.calls.push("me:outage");
        throw new Error(`socket hang up for ${token}`);
      },
    }),
  };
  const failure = await kelloLogin({ configDir: root }, deps).catch((cause: Error) => cause);
  assert.ok(failure instanceof Error);
  expect(failure).toMatchObject({
    code: "NEON_CREDENTIAL_UNAVAILABLE",
    message:
      "Could not reach Neon to check the stored key; nothing was changed. Check connectivity, then retry kello login.",
  });
  expect(failure.message).not.toContain(old.apiKey);
  expect(f.calls).toEqual(["me:outage"]);
  expect(await readStoredKey("default", root)).toEqual(old);
});

test("the production key check treats only a repeated auth rejection as an invalid key", async () => {
  const originalFetch = globalThis.fetch;
  const statuses: number[] = [];
  let requests = 0;
  try {
    globalThis.fetch = Object.assign(
      async () => {
        requests += 1;
        const status = statuses.shift() ?? 200;
        if (status === 0) throw new TypeError("network down");
        return Response.json(status === 200 ? { id: "user" } : { message: "fixture-provider-secret" }, { status });
      },
      { preconnect: originalFetch.preconnect },
    );
    const client = loginDependencies.client("fixture-token");
    statuses.push(401);
    expect(await client.authenticates()).toBe(true);
    expect(requests).toBe(2);
    statuses.push(401, 403);
    expect(await client.authenticates()).toBe(false);
    for (const status of [500, 0]) {
      statuses.push(status);
      await assert.rejects(client.authenticates());
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a key that can be neither stored nor revoked is reported by id and name", async () => {
  const f = fixture();
  f.state.revokeFails = true;
  const authorize = f.deps.authorize;
  const deps: LoginDependencies = {
    ...f.deps,
    authorize: async (configDir, signal) => {
      // The store directory becomes unwritable while the browser sign-in runs.
      await chmod(root, 0o500);
      return authorize(configDir, signal);
    },
  };
  const exitHooks = process.listenerCount("exit");
  try {
    const failure = await kelloLogin({ configDir: root }, deps).catch((cause: Error) => cause);
    // The save's own failure surfaces, not the lock release that also fails in a read-only directory.
    assert.ok(failure instanceof Error);
    expect(failure).toMatchObject({ code: "EACCES", syscall: "open", path: expect.stringContaining(".credentials-") });
    expect(existsSync(join(root, "credentials.lock"))).toBe(true);
    expect(process.listenerCount("exit")).toBe(exitHooks + 1);
  } finally {
    await chmod(root, 0o700);
  }
  // The leftover lock is this process's, so the next operation removes it instead of waiting.
  await saveStoredKey("other", old, { configDir: root });
  expect(existsSync(join(root, "credentials.lock"))).toBe(false);
  expect(process.listenerCount("exit")).toBe(exitHooks);
  expect(f.calls.at(-1)).toBe("revoke:minted:42");
  const warning = f.warnings.join("\n");
  expect(warning).toContain("kello-dev-box-local-20261108-090807 (id 42)");
  expect(warning).toContain("neon api-keys revoke 42");
  expect(warning).not.toContain(minted);
  expect(await readStoredKey("default", root)).toBeUndefined();
});

test("concurrent logins on one store are serialized and keep every profile", async () => {
  const order: string[] = [];
  const run = (profile: string) => {
    const f = fixture({
      authorize: async (configDir) => {
        order.push(`start:${profile}`);
        await writeFile(join(configDir, "credentials.json"), JSON.stringify({ access_token: oauth }));
        await new Promise((done) => setTimeout(done, 50));
        order.push(`end:${profile}`);
        return 0;
      },
    });
    return kelloLogin({ configDir: root, profile }, f.deps);
  };
  expect(await Promise.all([run("one"), run("two")])).toEqual([0, 0]);
  // Either may take the lock first; the sign-ins must never overlap.
  const first = order[0]?.slice("start:".length);
  const second = first === "one" ? "two" : "one";
  expect(order).toEqual([`start:${first}`, `end:${first}`, `start:${second}`, `end:${second}`]);
  expect((await readStoredKey("one", root))?.keyId).toBe(42);
  expect((await readStoredKey("two", root))?.keyId).toBe(42);
});

async function waitFor(path: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise((done) => setTimeout(done, 25));
  }
}
function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

for (const mode of ["SIGTERM", "SIGINT", "crash"] as const) {
  test(`an interrupted login (${mode}) stops the Neon CLI and removes its session and lock`, async () => {
    const temporary = join(root, "tmp");
    await mkdir(temporary, { mode: 0o700 });
    const record = join(root, `${mode}.json`);
    const store = join(root, "kello");
    const fixtures = join(import.meta.dir, "../fixtures/neon-credentials");
    const child = Bun.spawn(
      [
        process.execPath,
        join(fixtures, "login-signal.ts"),
        join(fixtures, "blocking-neon-cli.mjs"),
        store,
        mode === "crash" ? "crash" : "signal",
      ],
      {
        env: {
          ...process.env,
          TMPDIR: temporary,
          DEBUG: "*",
          NEON_API_KEY: "fixture-ambient-key",
          NEON_PROFILE: "ambient",
          KELLO_SIGNAL_RECORD: record,
          KELLO_SIGNAL_GO: join(root, `${mode}.go`),
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    await waitFor(record);
    const seen = JSON.parse(await readFile(record, "utf8"));
    expect(existsSync(join(seen.configDir, "credentials.json"))).toBe(true);
    expect(existsSync(join(store, "credentials.lock"))).toBe(true);
    if (mode === "crash") await writeFile(join(root, `${mode}.go`), "");
    else child.kill(mode);
    const status = await child.exited;
    expect(status).toBe(mode === "SIGTERM" ? 143 : mode === "SIGINT" ? 130 : 1);
    expect(existsSync(seen.configDir)).toBe(false);
    expect(existsSync(join(store, "credentials.lock"))).toBe(false);
    const deadline = Date.now() + 5_000;
    while (running(seen.pid) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 25));
    expect(running(seen.pid)).toBe(false);
    // The production sign-in child never sees DEBUG (OAuth callback logging) or an ambient identity.
    expect(seen.debug).toBe("");
    expect(seen.apiKeyPresent).toBe(false);
    expect(seen.profilePresent).toBe(false);
    expect(seen.args).toEqual(["login", "--config-dir", seen.configDir]);
    const output = (await new Response(child.stdout).text()) + (await new Response(child.stderr).text());
    expect(output).not.toContain("fixture-refresh-secret");
  }, 30_000);
}

test("logout waits for a first login still in the browser, then revokes its key", async () => {
  let entered = () => {};
  const signingIn = new Promise<void>((done) => {
    entered = done;
  });
  let finish = () => {};
  const browser = new Promise<void>((done) => {
    finish = done;
  });
  const login = fixture({
    authorize: async (configDir) => {
      await writeFile(join(configDir, "credentials.json"), JSON.stringify({ access_token: oauth }));
      entered();
      await browser;
      return 0;
    },
  });
  const logout = fixture();
  const signedIn = kelloLogin({ configDir: root }, login.deps);
  await signingIn;
  let loggedOut = false;
  const leaving = kelloLogout({ configDir: root }, logout.deps).then((status) => {
    loggedOut = true;
    return status;
  });
  await new Promise((done) => setTimeout(done, 150));
  expect(loggedOut).toBe(false);
  finish();
  expect(await signedIn).toBe(0);
  expect(await leaving).toBe(0);
  expect(logout.lines.join("\n")).not.toContain("No stored key");
  expect(logout.calls).toEqual(["revoke:minted:42"]);
  expect(await readStoredKey("default", root)).toBeUndefined();
});

test("signal and exit hooks stay registered until the session directory is removed", async () => {
  const baseline = { exit: process.listenerCount("exit"), term: process.listenerCount("SIGTERM") };
  const during: { exit: number; term: number }[] = [];
  const f = fixture();
  const remove = spyOn(filesystem, "rm").mockImplementation(async (path, options) => {
    if (String(path) === f.sessions[0])
      during.push({ exit: process.listenerCount("exit"), term: process.listenerCount("SIGTERM") });
    rmSync(path, options);
  });
  try {
    expect(await kelloLogin({ configDir: root }, f.deps)).toBe(0);
    expect(existsSync(f.sessions[0] ?? "")).toBe(false);
  } finally {
    remove.mockRestore();
  }
  expect(during).toHaveLength(1);
  expect(during[0]?.term).toBe(baseline.term + 1);
  // The session's exit hook and the credentials lock's exit hook are both still present.
  expect(during[0]?.exit).toBe(baseline.exit + 2);
  expect(process.listenerCount("SIGTERM")).toBe(baseline.term);
  expect(process.listenerCount("exit")).toBe(baseline.exit);
});
