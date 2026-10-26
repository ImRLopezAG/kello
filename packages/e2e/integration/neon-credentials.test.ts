import { createKelloNeonApi } from "../../../apps/kello-cli/src/tooling/neon/api";
import assert from "node:assert/strict";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNeonCredentials, NeonCredentialError } from "../../../apps/kello-cli/src/tooling/neon/credentials";

async function storedKey(configDir: string, name: string, key: string) {
  const cli = join(import.meta.dir, "../../../apps/kello-cli/node_modules/neon/dist/cli.js");
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => Response.json({ auth_method: "api_key_org", account_id: "org-fixture" }),
  });
  const child = Bun.spawn(
    [
      process.execPath,
      cli,
      "profile",
      "create",
      name,
      "--api-key",
      "-",
      "--config-dir",
      configDir,
      "--api-host",
      server.url.href,
    ],
    {
      env: { ...process.env, CI: "true", NEON_API_KEY: "", NEON_PROFILE: "", DEBUG: "" },
      stdin: new Blob([key]),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  try {
    expect(await child.exited).toBe(0);
  } finally {
    await server.stop(true);
  }
}

test("official profiles beat ambient keys and refresh resolution is shared only while pending", async () => {
  const dir = await mkdtemp(join(tmpdir(), "loom-credentials-"));
  const original = process.env.NEON_API_KEY;
  try {
    await storedKey(dir, "integration", "fixture-profile-key");
    process.env.NEON_API_KEY = "fixture-ambient-key";
    const credentials = createNeonCredentials({ configDir: dir, profile: "integration" });
    expect(await Promise.all([credentials.resolve(), credentials.resolve()])).toEqual([
      "fixture-profile-key",
      "fixture-profile-key",
    ]);
    expect(await createNeonCredentials({ configDir: dir }).resolve()).toBe("fixture-ambient-key");
    await storedKey(dir, "integration", "fixture-rotated-key");
    expect(await credentials.resolve()).toBe("fixture-rotated-key");
  } finally {
    if (original === undefined) delete process.env.NEON_API_KEY;
    else process.env.NEON_API_KEY = original;
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);

test("missing credentials fail without browser login and without provider diagnostics", async () => {
  const dir = await mkdtemp(join(tmpdir(), "loom-signed-out-"));
  try {
    await assert.rejects(createNeonCredentials({ configDir: dir, profile: "DEFAULT" }).resolve(), {
      code: "NEON_LOGIN_REQUIRED",
      message: "Sign in with kello login, then retry the command.",
    });
    const failure = new NeonCredentialError("NEON_REFRESH_FAILED");
    expect(failure.message).not.toContain("Sign in");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 10_000);

test("the pinned helper locks concurrent OAuth refresh and distinguishes revoked from transient failure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "loom-oauth-"));
  const previous = process.env.NEON_OAUTH_HOST;
  let exchanges = 0;
  let response: "success" | "revoked" | "network" = "success";
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.includes(".well-known"))
        return Response.json({
          issuer: url.origin,
          token_endpoint: `${url.origin}/token`,
          authorization_endpoint: `${url.origin}/authorize`,
          jwks_uri: `${url.origin}/jwks`,
          response_types_supported: ["code"],
          grant_types_supported: ["refresh_token"],
        });
      exchanges += 1;
      if (response === "revoked")
        return Response.json(
          { error: "invalid_grant", error_description: "fixture-secret-never-display" },
          { status: 400 },
        );
      if (response === "network") return new Response("fixture-secret-never-display", { status: 503 });
      return Response.json({
        access_token: "fixture-renewed",
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: "fixture-rotated",
      });
    },
  });
  async function expire() {
    const fixture = join(import.meta.dir, "../fixtures/neon-credentials/oauth.mjs");
    expect(await Bun.spawn([process.execPath, fixture, dir], { stdout: "ignore", stderr: "ignore" }).exited).toBe(0);
  }
  try {
    process.env.NEON_OAUTH_HOST = server.url.origin;
    await expire();
    const one = createNeonCredentials({ configDir: dir, profile: "DEFAULT" });
    const two = createNeonCredentials({ configDir: dir, profile: "DEFAULT" });
    expect(await Promise.all([one.resolve(), two.resolve()])).toEqual(["fixture-renewed", "fixture-renewed"]);
    expect(exchanges).toBe(1);
    await expire();
    response = "revoked";
    await assert.rejects(one.resolve(), {
      code: "NEON_SESSION_REVOKED",
      message: "Sign in with kello login, then retry the command.",
    });
    await expire();
    response = "network";
    await assert.rejects(one.resolve(), { code: "NEON_REFRESH_FAILED" });
  } finally {
    if (previous === undefined) delete process.env.NEON_OAUTH_HOST;
    else process.env.NEON_OAUTH_HOST = previous;
    await server.stop(true);
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);

test("API authorization failures are classified and resource writes are never replayed", async () => {
  const previous = process.env.NEON_API_KEY;
  const originalFetch = globalThis.fetch;
  let status = 401;
  let requests = 0;
  try {
    process.env.NEON_API_KEY = "fixture-api-key";
    globalThis.fetch = Object.assign(
      async () => {
        requests += 1;
        return Response.json({ message: "fixture-provider-secret" }, { status });
      },
      { preconnect: originalFetch.preconnect },
    );
    const api = createKelloNeonApi();
    await assert.rejects(api.getProject("fixture"), { code: "NEON_SESSION_REVOKED" });
    status = 403;
    await assert.rejects(api.getProject("fixture"), { code: "NEON_PERMISSION_DENIED" });
    for (const failure of [423, 500, 503]) {
      status = failure;
      const before = requests;
      await assert.rejects(api.createProject({ name: "fixture", regionId: "aws-us-east-2" }));
      expect(requests - before).toBe(1);
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (previous === undefined) delete process.env.NEON_API_KEY;
    else process.env.NEON_API_KEY = previous;
  }
});
