import {
  createKelloNeonApi,
  createKelloNeonClient,
  createRealtimeProvider,
  createRetryingFetch,
  neonCall,
  withNeonCredentials,
} from "../../../apps/kello-cli/src/tooling/neon/api";
import assert from "node:assert/strict";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import * as filesystem from "node:fs/promises";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNeonCredentials, NeonCredentialError } from "../../../apps/kello-cli/src/tooling/neon/credentials";
import {
  readStoredCredentials,
  readStoredKey,
  removeStoredKey,
  saveStoredKey,
  withCredentialLock,
} from "../../../apps/kello-cli/src/tooling/neon/store";
import { inspectRuntimeDatabase } from "../../../apps/kello-cli/src/tooling/deploy/neon/runtime-database";

const secret = "napi_fixture-secret-never-display";
const key = (apiKey: string, keyId = 7) => ({
  apiKey,
  keyId,
  keyName: `kello-fixture-${keyId}`,
  createdAt: "2026-11-08T12:00:00.000Z",
});
const saved = { NEON_API_KEY: process.env.NEON_API_KEY, KELLO_PROFILE: process.env.KELLO_PROFILE };
let base: string;
let root: string;
beforeEach(async () => {
  // A private parent, as the store requires; the system temp root may be shared (Linux /tmp).
  base = await mkdtemp(join(tmpdir(), "kello-credentials-"));
  root = join(base, "home");
  await mkdir(root, { mode: 0o700 });
  delete process.env.NEON_API_KEY;
  delete process.env.KELLO_PROFILE;
});
afterEach(async () => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await rm(base, { recursive: true, force: true });
});

test("the store creates a private directory and file and replaces it atomically", async () => {
  const dir = join(root, "nested", "kello");
  const path = await saveStoredKey("default", key("fixture-one"), { configDir: dir });
  expect(path).toBe(join(dir, "credentials.json"));
  expect((await lstat(dir)).mode & 0o777).toBe(0o700);
  expect((await lstat(path)).mode & 0o777).toBe(0o600);
  await saveStoredKey("default", key("fixture-two", 8), { configDir: dir });
  expect(await readdir(dir)).toEqual(["credentials.json"]);
  expect((await lstat(path)).mode & 0o777).toBe(0o600);
  expect((await readStoredKey("default", dir))?.apiKey).toBe("fixture-two");
});

test("the store keeps multiple profiles and deletes the file with the last one", async () => {
  await saveStoredKey("default", key("fixture-default", 1), { configDir: root });
  await saveStoredKey("work", key("fixture-work", 2), { configDir: root });
  expect(Object.keys((await readStoredCredentials(root))?.profiles ?? {}).sort()).toEqual(["default", "work"]);
  expect(await removeStoredKey("default", root)).toBe(true);
  expect(await readStoredKey("default", root)).toBeUndefined();
  expect((await readStoredKey("work", root))?.apiKey).toBe("fixture-work");
  expect(await removeStoredKey("missing", root)).toBe(false);
  expect(await removeStoredKey("work", root)).toBe(true);
  expect(await readdir(root)).toEqual([]);
});

test("the store refuses symlinks and group or world access", async () => {
  const real = join(root, "real");
  await saveStoredKey("default", key(secret), { configDir: real });
  const linkedDir = join(root, "linked-dir");
  await symlink(real, linkedDir);
  await assert.rejects(readStoredKey("default", linkedDir), { code: "KELLO_CREDENTIALS_UNSAFE" });
  await assert.rejects(saveStoredKey("default", key("fixture"), { configDir: linkedDir }), {
    code: "KELLO_CREDENTIALS_UNSAFE",
  });
  const linkedFile = join(root, "linked-file");
  await mkdir(linkedFile, { mode: 0o700 });
  await symlink(join(real, "credentials.json"), join(linkedFile, "credentials.json"));
  await assert.rejects(readStoredKey("default", linkedFile), { code: "KELLO_CREDENTIALS_UNSAFE" });
  await assert.rejects(saveStoredKey("default", key("fixture"), { configDir: linkedFile }), {
    code: "KELLO_CREDENTIALS_UNSAFE",
  });
  await chmod(join(real, "credentials.json"), 0o644);
  const readable = await readStoredKey("default", real).catch((cause: Error) => cause);
  assert.ok(readable instanceof NeonCredentialError);
  expect(readable.code).toBe("KELLO_CREDENTIALS_UNSAFE");
  expect(readable.message).not.toContain(secret);
  await chmod(join(real, "credentials.json"), 0o600);
  await chmod(real, 0o755);
  await assert.rejects(readStoredKey("default", real), { code: "KELLO_CREDENTIALS_UNSAFE" });
  await chmod(real, 0o700);
  expect((await readStoredKey("default", real))?.apiKey).toBe(secret);
});

test("the store rejects corrupt and unknown files without overwriting them", async () => {
  const path = join(root, "credentials.json");
  for (const contents of [
    `{"version":1,"profiles":{"default":{"apiKey":"${secret}"`,
    JSON.stringify({ version: 2, profiles: {} }),
    JSON.stringify({ version: 1, profiles: { default: { ...key(secret), extra: true } } }),
    JSON.stringify({ version: 1, profiles: { "../escape": key(secret) } }),
  ]) {
    await writeFile(path, contents, { mode: 0o600 });
    const failure = await readStoredKey("default", root).catch((cause: Error) => cause);
    assert.ok(failure instanceof NeonCredentialError);
    expect(failure.code).toBe("KELLO_CREDENTIALS_INVALID");
    expect(failure.message).not.toContain(secret);
    await assert.rejects(saveStoredKey("default", key("fixture"), { configDir: root }), {
      code: "KELLO_CREDENTIALS_INVALID",
    });
    expect(await readFile(path, "utf8")).toBe(contents);
  }
  await saveStoredKey("default", key("fixture-replaced"), { configDir: root, replaceInvalid: true });
  expect((await readStoredKey("default", root))?.apiKey).toBe("fixture-replaced");
});

test("resolution prefers NEON_API_KEY, honours --profile and KELLO_PROFILE, and never spawns", async () => {
  const spawn = spyOn(Bun, "spawn");
  try {
    await saveStoredKey("default", key("fixture-default"), { configDir: root });
    await saveStoredKey("work", key("fixture-work"), { configDir: root });
    expect(await createNeonCredentials({ configDir: root }).resolve()).toBe("fixture-default");
    process.env.KELLO_PROFILE = "work";
    expect(await createNeonCredentials({ configDir: root }).resolve()).toBe("fixture-work");
    process.env.NEON_API_KEY = "fixture-ambient";
    const ambient = createNeonCredentials({ configDir: root });
    expect(await Promise.all([ambient.resolve(), ambient.resolve()])).toEqual(["fixture-ambient", "fixture-ambient"]);
    expect(ambient.rejected().message).toContain("NEON_API_KEY");
    const explicit = createNeonCredentials({ configDir: root, profile: "default" });
    expect(await explicit.resolve()).toBe("fixture-default");
    expect(explicit.rejected()).toMatchObject({ code: "NEON_SESSION_REVOKED" });
    expect(explicit.rejected().message).toContain("kello login --force");
    await saveStoredKey("default", key("fixture-rotated"), { configDir: root });
    expect(await explicit.resolve()).toBe("fixture-rotated");
    expect(spawn).not.toHaveBeenCalled();
  } finally {
    spawn.mockRestore();
  }
});

test("missing credentials fail without browser login and without provider diagnostics", async () => {
  const spawn = spyOn(Bun, "spawn");
  try {
    await assert.rejects(createNeonCredentials({ configDir: root }).resolve(), {
      code: "NEON_LOGIN_REQUIRED",
      message: "Sign in with kello login, then retry the command.",
    });
    await assert.rejects(createNeonCredentials({ configDir: root, profile: "../x" }).resolve(), {
      code: "KELLO_CREDENTIALS_INVALID",
    });
    expect(spawn).not.toHaveBeenCalled();
  } finally {
    spawn.mockRestore();
  }
});

test("API authorization failures are classified and resource writes are never replayed", async () => {
  const originalFetch = globalThis.fetch;
  let status = 401;
  let requests = 0;
  const statuses: number[] = [];
  try {
    process.env.NEON_API_KEY = "fixture-api-key";
    globalThis.fetch = Object.assign(
      async () => {
        requests += 1;
        return Response.json({ message: "fixture-provider-secret" }, { status: statuses.shift() ?? status });
      },
      { preconnect: originalFetch.preconnect },
    );
    const api = createKelloNeonApi();
    // An unauthenticated request was not applied: one transient 401 is retried, a repeated one is terminal.
    let before = requests;
    await assert.rejects(api.getProject("fixture"), (cause: Error) => {
      assert.ok(cause instanceof NeonCredentialError);
      assert.equal(cause.code, "NEON_SESSION_REVOKED");
      assert.match(cause.message, /NEON_API_KEY/);
      return true;
    });
    expect(requests - before).toBe(2);
    statuses.push(401);
    status = 403;
    before = requests;
    await assert.rejects(api.createProject({ name: "fixture", regionId: "aws-us-east-2" }), {
      code: "NEON_PERMISSION_DENIED",
    });
    expect(requests - before).toBe(2);
    await assert.rejects(api.getProject("fixture"), { code: "NEON_PERMISSION_DENIED" });
    for (const failure of [423, 500, 503]) {
      status = failure;
      before = requests;
      await assert.rejects(api.createProject({ name: "fixture", regionId: "aws-us-east-2" }));
      expect(requests - before).toBe(1);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a stored key Neon rejects twice asks for kello login --force", async () => {
  const originalFetch = globalThis.fetch;
  try {
    await saveStoredKey("default", key("fixture-stored"), { configDir: root });
    globalThis.fetch = Object.assign(async () => Response.json({ message: "denied" }, { status: 401 }), {
      preconnect: originalFetch.preconnect,
    });
    await withNeonCredentials({ configDir: root }, async () => {
      await assert.rejects(createKelloNeonApi().getProject("fixture"), {
        code: "NEON_SESSION_REVOKED",
        message: "The stored Kello API key was revoked or is invalid. Run kello login --force, then retry the command.",
      });
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the SDK client re-resolves and retries a 401 exactly once", async () => {
  const originalFetch = globalThis.fetch;
  const authorizations: (string | null)[] = [];
  let failures = 1;
  try {
    await saveStoredKey("default", key("fixture-old"), { configDir: root });
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input.toString(), init);
        authorizations.push(request.headers.get("authorization"));
        if (failures-- > 0) {
          // Another process replaced the key while this request was in flight.
          await saveStoredKey("default", key("fixture-new"), { configDir: root });
          return Response.json({ message: "denied" }, { status: 401 });
        }
        return Response.json({ project: { id: "project", name: "fixture", org_id: "org-fixture" } });
      },
      { preconnect: originalFetch.preconnect },
    );
    await withNeonCredentials({ configDir: root }, async () => {
      await createKelloNeonClient().projects.get({ projectId: "project" });
      expect(authorizations).toEqual(["Bearer fixture-old", "Bearer fixture-new"]);
      failures = 5;
      authorizations.length = 0;
      await assert.rejects(createKelloNeonClient().projects.get({ projectId: "project" }));
      expect(authorizations).toHaveLength(2);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("runtime database preflight keeps the failure cause", async () => {
  const failure = await inspectRuntimeDatabase({
    connectionString: "postgresql://other:secret@ep-fixture.example.test/neondb",
    database: { endpointHost: "ep-fixture.example.test", databaseName: "neondb" },
    runtimeRole: "runtime",
    namespace: "app",
    metadataNamespace: "kello_meta",
  }).catch((cause: Error) => cause);
  assert.ok(failure instanceof Error);
  expect(failure.message).toBe("Runtime database preflight failed");
  expect(failure.cause).toBeInstanceOf(Error);
});

test("the store refuses a parent directory others can write", async () => {
  const shared = join(root, "shared");
  await mkdir(shared, { mode: 0o700 });
  await chmod(shared, 0o777);
  await assert.rejects(saveStoredKey("default", key("fixture"), { configDir: join(shared, "kello") }), {
    code: "KELLO_CREDENTIALS_UNSAFE",
  });
  await chmod(shared, 0o700);
  await saveStoredKey("default", key("fixture"), { configDir: join(shared, "kello") });
  await chmod(shared, 0o757);
  await assert.rejects(readStoredKey("default", join(shared, "kello")), { code: "KELLO_CREDENTIALS_UNSAFE" });
  await chmod(shared, 0o700);
});

test("concurrent saves to different profiles all survive", async () => {
  const names = Array.from({ length: 12 }, (_, index) => `profile-${index}`);
  await Promise.all(
    names.map((name, index) => saveStoredKey(name, key(`fixture-${index}`, index), { configDir: root })),
  );
  expect(Object.keys((await readStoredCredentials(root))?.profiles ?? {}).sort()).toEqual([...names].sort());
  await Promise.all(names.slice(0, 6).map((name) => removeStoredKey(name, root)));
  expect(Object.keys((await readStoredCredentials(root))?.profiles ?? {}).sort()).toEqual(names.slice(6).sort());
  expect((await readdir(root)).sort()).toEqual(["credentials.json"]);
});

test("a second locker waits for the holder, and fails clearly when it never releases", async () => {
  let release = () => {};
  const held = new Promise<void>((done) => {
    release = done;
  });
  let entered = () => {};
  const holding = new Promise<void>((done) => {
    entered = done;
  });
  const holder = withCredentialLock(root, async () => {
    entered();
    await held;
  });
  await holding;
  let saved = false;
  const waiting = saveStoredKey("default", key("fixture-waiting"), { configDir: root }).then(() => {
    saved = true;
  });
  await new Promise((done) => setTimeout(done, 150));
  expect(saved).toBe(false);
  await assert.rejects(
    withCredentialLock(root, async () => {}, 100),
    { code: "KELLO_CREDENTIALS_BUSY" },
  );
  release();
  await Promise.all([holder, waiting]);
  expect((await readStoredKey("default", root))?.apiKey).toBe("fixture-waiting");
  // Another live process's lock is honoured; a dead process's lock is stale and taken over.
  const lock = join(root, "credentials.lock");
  await writeFile(lock, JSON.stringify({ pid: process.ppid, token: "other" }), { mode: 0o600 });
  await assert.rejects(
    withCredentialLock(root, async () => {}, 100),
    { code: "KELLO_CREDENTIALS_BUSY" },
  );
  const exited = Bun.spawn([process.execPath, "-e", ""]);
  await exited.exited;
  await writeFile(lock, JSON.stringify({ pid: exited.pid, token: "dead" }), { mode: 0o600 });
  await saveStoredKey("work", key("fixture-after-stale"), { configDir: root });
  expect((await readStoredKey("work", root))?.apiKey).toBe("fixture-after-stale");
  expect((await readdir(root)).sort()).toEqual(["credentials.json"]);
});

function rejecting(status: number, originalFetch: typeof fetch) {
  return Object.assign(async () => Response.json({ message: "fixture-provider-secret" }, { status }), {
    preconnect: originalFetch.preconnect,
  });
}

test("terminal SDK auth failures become fixed Kello guidance for each source", async () => {
  const originalFetch = globalThis.fetch;
  const stored = "The stored Kello API key was revoked or is invalid. Run kello login --force, then retry the command.";
  const ambient = "Neon rejected NEON_API_KEY. Check that it holds an active API key, then retry the command.";
  const denied =
    "The selected Neon identity does not have permission for this operation. Select an authorized profile.";
  const expectFailure = async (operation: Promise<object>, code: NeonCredentialError["code"], message: string) => {
    const failure = await operation.catch((cause: Error) => cause);
    assert.ok(failure instanceof NeonCredentialError);
    expect({ code: failure.code, message: failure.message }).toEqual({ code, message });
  };
  try {
    await saveStoredKey("default", key("fixture-stored"), { configDir: root });
    globalThis.fetch = rejecting(401, originalFetch);
    await withNeonCredentials({ configDir: root }, async () => {
      await expectFailure(
        neonCall(createKelloNeonClient().projects.get({ projectId: "p" })),
        "NEON_SESSION_REVOKED",
        stored,
      );
      await expectFailure(createRealtimeProvider().get("p", "br"), "NEON_SESSION_REVOKED", stored);
    });
    process.env.NEON_API_KEY = "fixture-ambient";
    await withNeonCredentials({ configDir: root }, async () => {
      await expectFailure(
        neonCall(createKelloNeonClient().projects.get({ projectId: "p" })),
        "NEON_SESSION_REVOKED",
        ambient,
      );
    });
    globalThis.fetch = rejecting(403, originalFetch);
    await withNeonCredentials({ configDir: root }, async () => {
      await expectFailure(
        neonCall(createKelloNeonClient().projects.get({ projectId: "p" })),
        "NEON_PERMISSION_DENIED",
        denied,
      );
      await expectFailure(createRealtimeProvider().get("p", "br"), "NEON_PERMISSION_DENIED", denied);
    });
    globalThis.fetch = rejecting(500, originalFetch);
    const other = await neonCall(createKelloNeonClient().projects.get({ projectId: "p" })).catch(
      (cause: Error) => cause,
    );
    expect(other).not.toBeInstanceOf(NeonCredentialError);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a POST body is resent identically on the single 401 retry", async () => {
  const originalFetch = globalThis.fetch;
  const bodies: string[] = [];
  try {
    process.env.NEON_API_KEY = "fixture-ambient";
    globalThis.fetch = Object.assign(
      async (_input: string | URL | Request, init?: RequestInit) => {
        bodies.push(await new Response(init?.body).text());
        return bodies.length === 1
          ? Response.json({ message: "denied" }, { status: 401 })
          : Response.json({ id: 5, key: "fixture-created", name: "fixture-name", created_at: "2026-11-08T00:00:00Z" });
      },
      { preconnect: originalFetch.preconnect },
    );
    await createKelloNeonClient().apiKeys.create({ keyName: "fixture-name" });
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toContain("fixture-name");
    expect(bodies[1]).toBe(bodies[0] ?? "");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a body above the replay bound is streamed once and its 401 is not retried", async () => {
  const originalFetch = globalThis.fetch;
  const sizes: number[] = [];
  let resolved = 0;
  try {
    globalThis.fetch = Object.assign(
      async (_input: string | URL | Request, init?: RequestInit) => {
        sizes.push((await new Response(init?.body).arrayBuffer()).byteLength);
        return Response.json({ message: "denied" }, { status: 401 });
      },
      { preconnect: originalFetch.preconnect },
    );
    const retrying = createRetryingFetch({
      resolve: async () => {
        resolved += 1;
        return "fixture-next";
      },
    });
    const large = new Uint8Array(2 * 1024 * 1024 + 7).fill(7);
    const response = await retrying("https://console.neon.tech/api/v2/fixture", { method: "POST", body: large });
    expect(response.status).toBe(401);
    expect(sizes).toEqual([large.byteLength]);
    expect(resolved).toBe(0);
    const small = await retrying("https://console.neon.tech/api/v2/fixture", { method: "POST", body: "small" });
    expect(small.status).toBe(401);
    expect(sizes).toEqual([large.byteLength, 5, 5]);
    expect(resolved).toBe(1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("every ancestor is checked: non-sticky shared ones are refused, sticky and root-owned ones accepted", async () => {
  const shared = join(root, "shared");
  await mkdir(join(shared, "alice"), { recursive: true, mode: 0o700 });
  await chmod(shared, 0o777);
  const failure = await saveStoredKey("default", key("fixture"), { configDir: join(shared, "alice", "kello") }).catch(
    (cause: Error) => cause,
  );
  await chmod(shared, 0o700);
  assert.ok(failure instanceof NeonCredentialError);
  expect(failure.code).toBe("KELLO_CREDENTIALS_UNSAFE");
  expect(failure.message).toContain(await realpath(shared));
  expect(failure.message).toContain("sticky");

  const sticky = join(root, "sticky");
  await mkdir(join(sticky, "alice"), { recursive: true, mode: 0o700 });
  await chmod(sticky, 0o1777);
  await saveStoredKey("default", key("fixture-sticky"), { configDir: join(sticky, "alice", "kello") });
  expect((await readStoredKey("default", join(sticky, "alice", "kello")))?.apiKey).toBe("fixture-sticky");
  // A sticky shared directory is still not acceptable as the immediate parent.
  await assert.rejects(saveStoredKey("default", key("fixture"), { configDir: join(sticky, "kello") }), {
    code: "KELLO_CREDENTIALS_UNSAFE",
  });
  await chmod(sticky, 0o700);

  // The resolved chain to `/` includes root-owned directories, and the store accepts them.
  let current = await realpath(root);
  const owners: number[] = [];
  while (dirname(current) !== current) {
    current = dirname(current);
    owners.push((await stat(current)).uid);
  }
  expect(owners).toContain(0);
  await saveStoredKey("default", key("fixture-root-owned"), { configDir: join(root, "kello") });
});

test("a symlinked or dangling lock is unsafe, not busy", async () => {
  const target = join(root, "elsewhere.json");
  await writeFile(target, JSON.stringify({ pid: process.pid, token: "foreign" }), { mode: 0o600 });
  await symlink(target, join(root, "credentials.lock"));
  await assert.rejects(
    withCredentialLock(root, async () => {}, 200),
    { code: "KELLO_CREDENTIALS_UNSAFE" },
  );
  await rm(join(root, "credentials.lock"));
  await symlink(join(root, "missing.json"), join(root, "credentials.lock"));
  await assert.rejects(
    withCredentialLock(root, async () => {}, 200),
    { code: "KELLO_CREDENTIALS_UNSAFE" },
  );
  expect(existsSync(target)).toBe(true);
});

test("a lock that cannot be fully written is removed and its error surfaces", async () => {
  const probe = await open(join(root, "probe"), "w");
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const diskFull = new Error("fixture disk full");
  const write = spyOn(prototype, "writeFile").mockRejectedValueOnce(diskFull);
  const exitHooks = process.listenerCount("exit");
  try {
    const failure = await withCredentialLock(root, async () => "ran").catch((cause: Error) => cause);
    expect(failure).toBe(diskFull);
  } finally {
    write.mockRestore();
  }
  expect(existsSync(join(root, "credentials.lock"))).toBe(false);
  expect(process.listenerCount("exit")).toBe(exitHooks);
  expect(await withCredentialLock(root, async () => "ran")).toBe("ran");
});

test("a failed lock release never masks the outcome and is retried by the next acquisition", async () => {
  const quiet = spyOn(console, "error").mockImplementation(() => {});
  const exitHooks = process.listenerCount("exit");
  const lock = join(root, "credentials.lock");
  try {
    const primary = new Error("fixture primary failure");
    const failure = await withCredentialLock(root, async () => {
      await chmod(root, 0o500);
      throw primary;
    }).catch((cause: Error) => cause);
    expect(failure).toBe(primary);
    expect(existsSync(lock)).toBe(true);
    expect(process.listenerCount("exit")).toBe(exitHooks + 1);
    expect(String(quiet.mock.calls.at(-1))).toContain(lock);
    await chmod(root, 0o700);
    expect(await withCredentialLock(root, async () => "next")).toBe("next");
    expect(existsSync(lock)).toBe(false);
    expect(process.listenerCount("exit")).toBe(exitHooks);
    // A successful operation keeps its result when only the release fails.
    expect(
      await withCredentialLock(root, async () => {
        await chmod(root, 0o500);
        return "kept";
      }),
    ).toBe("kept");
    await chmod(root, 0o700);
    await withCredentialLock(root, async () => {});
    expect(existsSync(lock)).toBe(false);
    expect(process.listenerCount("exit")).toBe(exitHooks);
  } finally {
    await chmod(root, 0o700);
    quiet.mockRestore();
  }
});

test("a config dir reached through a symlinked ancestor is used only by its validated canonical path", async () => {
  const first = join(root, "real-a");
  const second = join(root, "real-b");
  for (const target of [first, second]) await mkdir(join(target, "kello"), { recursive: true, mode: 0o700 });
  const link = join(root, "link");
  await symlink(first, link);
  const configDir = join(link, "kello");
  await saveStoredKey("default", key("fixture-first"), { configDir });
  const realOpen = filesystem.open;
  let swapped = false;
  // After validation, swap the ancestor link to another directory just before the write.
  const spy = spyOn(filesystem, "open").mockImplementation(async (path, flags, mode) => {
    if (!swapped && String(path).includes(".credentials-")) {
      swapped = true;
      await rm(link);
      await symlink(second, link);
    }
    return realOpen(path, flags, mode);
  });
  try {
    await saveStoredKey("work", key("fixture-second"), { configDir });
  } finally {
    spy.mockRestore();
  }
  expect(swapped).toBe(true);
  expect((await readStoredKey("work", join(first, "kello")))?.apiKey).toBe("fixture-second");
  expect(await readdir(join(second, "kello"))).toEqual([]);
  // System aliases still work: /tmp resolves to a sticky, root-owned canonical directory.
  const shared = await mkdtemp("/tmp/kello-alias-");
  try {
    await saveStoredKey("default", key("fixture-tmp"), { configDir: join(shared, "kello") });
    expect((await readStoredKey("default", join(shared, "kello")))?.apiKey).toBe("fixture-tmp");
  } finally {
    await rm(shared, { recursive: true, force: true });
  }
});

test("an unreadable lock is a failed release that the same process retries once readable", async () => {
  const quiet = spyOn(console, "error").mockImplementation(() => {});
  const exitHooks = process.listenerCount("exit");
  const lock = join(root, "credentials.lock");
  try {
    expect(
      await withCredentialLock(root, async () => {
        await chmod(lock, 0o200);
        return "ran";
      }),
    ).toBe("ran");
    expect(existsSync(lock)).toBe(true);
    expect(process.listenerCount("exit")).toBe(exitHooks + 1);
    expect(String(quiet.mock.calls.at(-1))).toContain("credentials.lock");
    await chmod(lock, 0o600);
    // Its own leftover lock is removed rather than waited on (a wait would end in BUSY here).
    expect(await withCredentialLock(root, async () => "again", 300)).toBe("again");
    expect(existsSync(lock)).toBe(false);
    expect(process.listenerCount("exit")).toBe(exitHooks);
  } finally {
    await chmod(lock, 0o600).catch(() => undefined);
    quiet.mockRestore();
  }
});
