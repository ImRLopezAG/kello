import assert from "node:assert/strict";
import { test } from "bun:test";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRealNeonApi } from "@neon/config-runtime/v1";
import { planProjectBranchProvision, provisionProjectBranch } from "kello-cli";

test("branch provisioning CLI uses the pinned SDK HTTP adapter and resumes the acknowledged branch", async () => {
  const root = await mkdtemp(join(tmpdir(), "loom-neon-provision-http-"));
  const input = {
    key: "a".repeat(64),
    projectId: "project",
    parentBranchId: "br-parent",
    branchName: "preview/test",
    environment: "preview" as const,
  };
  const parent = { id: "br-parent", name: "production", protected: true, default: true };
  const branch = { id: "br-created", name: input.branchName, parent_id: parent.id, protected: false, default: false };
  let creates = 0;
  let endpointAvailable = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      assert.equal(request.headers.get("authorization"), "Bearer fixture-api-key");
      const path = new URL(request.url).pathname;
      if (request.method === "GET" && path === "/projects/project")
        return Response.json({ project: { id: "project", name: "test", pg_version: 18, region_id: "aws-us-east-2" } });
      if (request.method === "GET" && path === "/projects/project/branches")
        return Response.json({ branches: creates ? [parent, branch] : [parent] });
      if (request.method === "GET" && path === "/projects/project/endpoints")
        return Response.json({
          endpoints: endpointAvailable
            ? [
                {
                  id: "ep-created",
                  branch_id: branch.id,
                  type: "read_write",
                  autoscaling_limit_min_cu: 0.25,
                  autoscaling_limit_max_cu: 1,
                  suspend_timeout_seconds: 300,
                },
              ]
            : [],
        });
      if (request.method === "POST" && path === "/projects/project/branches") {
        assert.equal(creates, 0);
        assert.deepEqual(await request.json(), {
          branch: { name: input.branchName, parent_id: parent.id, protected: false, init_source: "parent-data" },
          endpoints: [{ type: "read_write" }],
        });
        creates++;
        return Response.json({ branch, endpoints: [] });
      }
      throw new Error("Unexpected provider request");
    },
  });
  const api = createRealNeonApi({ apiKey: "fixture-api-key", baseUrl: server.url.origin });
  try {
    const preload = join(root, "local-transport.mjs");
    // The subprocess runs the real CLI and SDK; transport stays confined to this local server.
    await writeFile(
      preload,
      `
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.origin !== "https://console.neon.tech" || !url.pathname.startsWith("/api/v2/"))
    throw new Error("Unexpected test transport target");
  const target = new URL(url.pathname.slice("/api/v2".length) + url.search, ${JSON.stringify(server.url.origin)});
  return originalFetch(new Request(target, request));
};
`,
    );
    async function runCli(dryRun: boolean, exitCode: number) {
      const cli = fileURLToPath(new URL("../../../apps/kello-cli/src/cli.ts", import.meta.url));
      const child = Bun.spawn(
        [
          process.execPath,
          "--preload",
          preload,
          cli,
          "provision",
          "--branch",
          "branch.json",
          "--cwd",
          root,
          "--json",
          ...(dryRun ? ["--dry-run"] : []),
        ],
        { env: { ...process.env, NEON_API_KEY: "fixture-api-key" }, stdout: "pipe", stderr: "pipe" },
      );
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      assert.equal(exit, exitCode);
      assert.ok(!`${stdout}${stderr}`.includes("fixture-api-key"));
      if (exitCode) {
        assert.equal(stdout, "");
        assert.equal(JSON.parse(stderr).error.code, "PROVISIONING_FAILED");
      } else {
        assert.equal(stderr, "");
        const output = JSON.parse(stdout);
        assert.equal(output.ok, true);
        assert.equal(output.command, "provision");
        if (dryRun) assert.equal(output.plan.parentBranchId, parent.id);
        else assert.equal(output.receipt.branchId, branch.id);
      }
    }
    await writeFile(join(root, "branch.json"), JSON.stringify({ format: 1, ...input }));
    await writeFile(join(root, "invalid.json"), JSON.stringify({ format: 1, ...input, apiKey: "secret-value" }));
    await assert.rejects(provisionProjectBranch(root, "invalid.json", api), /Invalid branch provisioning declaration/);
    await writeFile(join(root, "invalid.json"), '{"secret-value":');
    await assert.rejects(
      planProjectBranchProvision(root, "invalid.json", api),
      new Error("Invalid branch provisioning declaration"),
    );
    await assert.rejects(planProjectBranchProvision(root, "../outside.json", api), /escape/);
    await assert.rejects(
      provisionProjectBranch(root, "branch.json", api, AbortSignal.abort(new Error("Cancelled"))),
      /Cancelled/,
    );
    assert.equal((await planProjectBranchProvision(root, "branch.json", api)).parentBranchId, parent.id);
    await runCli(true, 0);
    assert.equal(creates, 0);
    await assert.rejects(access(join(root, ".kello")));
    await runCli(false, 5);
    assert.equal(creates, 1);
    endpointAvailable = true;
    await runCli(false, 0);
    const receipt = await provisionProjectBranch(root, "branch.json", api);
    assert.equal(receipt.branchId, branch.id);
    assert.equal(receipt.endpointId, "ep-created");
    assert.deepEqual(await provisionProjectBranch(root, "branch.json", api), receipt);
    assert.equal(creates, 1);
    branch.protected = true;
    await assert.rejects(provisionProjectBranch(root, "branch.json", api), /identity changed/);
    assert.equal(creates, 1);
    const saved = await readFile(join(root, ".kello/provision", input.key, "branch.json"), "utf8");
    assert.ok(!saved.includes("fixture-api-key"));
  } finally {
    await server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});
