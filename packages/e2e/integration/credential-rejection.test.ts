import assert from "node:assert/strict";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { provisionNeonBranch } from "../../../apps/kello-cli/src/tooling/deploy/neon/provision";
import { createKelloNeonClient, waitForProvisioning } from "../../../apps/kello-cli/src/tooling/neon/api";
import { NeonCredentialError } from "../../../apps/kello-cli/src/tooling/neon/credentials";
import { createNeonProject } from "../../../apps/kello-cli/src/tooling/project/onboarding";

// Both creation workflows run through the production SDK client and its credential boundary;
// only HTTP is replaced. A terminal 401/403 was not applied, so a retry must be allowed.
const originalFetch = globalThis.fetch;
const previousKey = process.env.NEON_API_KEY;
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "kello-credential-rejection-"));
  process.env.NEON_API_KEY = "fixture-api-key";
});
afterEach(async () => {
  globalThis.fetch = originalFetch;
  if (previousKey === undefined) delete process.env.NEON_API_KEY;
  else process.env.NEON_API_KEY = previousKey;
  await rm(root, { recursive: true, force: true });
});

function serve(handler: (method: string, path: string, url: URL) => Response | undefined) {
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input.toString(), init);
      const url = new URL(request.url);
      const response = handler(request.method, url.pathname.replace(/^\/api\/v2/, ""), url);
      if (!response) throw new Error(`Unexpected fixture request ${request.method} ${url.pathname}`);
      return response;
    },
    { preconnect: originalFetch.preconnect },
  );
}
const denial = (status: number) => Response.json({ message: "fixture-provider-secret" }, { status });
function operation(
  projectId: string,
  branchId: string,
  status: "running" | "finished" | "failed" | "cancelled" | "error",
) {
  return {
    id: "op-1",
    project_id: projectId,
    branch_id: branchId,
    action: "create_branch",
    status,
    failures_count: 0,
    // Served operations belong to the create just sent, so they start now, after its cutoff.
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    total_duration_ms: 1,
  };
}
/** Readiness routes: one pending operation whose poll is denied with `denied`, else finishes. */
function readiness(projectId: string, branchId: string, method: string, path: string, denied: number | undefined) {
  if (method === "GET" && path === `/projects/${projectId}/operations`)
    return Response.json({ operations: [operation(projectId, branchId, "running")] });
  if (method === "GET" && path === `/projects/${projectId}/operations/op-1`)
    return denied ? denial(denied) : Response.json({ operation: operation(projectId, branchId, "finished") });
  return undefined;
}

for (const [status, code] of [
  [401, "NEON_SESSION_REVOKED"],
  [403, "NEON_PERMISSION_DENIED"],
] as const) {
  test(`project creation rejected with ${status} stays retryable after credentials are fixed`, async () => {
    let creates = 0;
    let rejecting = true;
    serve((method, path) => {
      if (method === "POST" && path === "/projects") {
        creates += 1;
        if (rejecting) return denial(status);
        return Response.json({ project: { id: "project-created", name: "kello-temp" }, operations: [] });
      }
      if (method === "PATCH" && path === "/projects/project-created")
        return Response.json({ project: { id: "project-created", name: "app" }, operations: [] });
      return readiness("project-created", "br-main", method, path, undefined);
    });
    const input = { name: "app", orgId: "org-test", region: "aws-us-east-1" };
    const failure = await createNeonProject(root, input).catch((cause: Error) => cause);
    assert.ok(failure instanceof NeonCredentialError);
    expect(failure.code).toBe(code);
    expect(failure.message).not.toContain("fixture-provider-secret");
    const receipt = JSON.parse(await readFile(join(root, ".kello/onboarding.json"), "utf8"));
    expect(receipt.phase).toBe("prepared");
    rejecting = false;
    const attempts = creates;
    expect((await createNeonProject(root, input)).projectId).toBe("project-created");
    expect(creates).toBe(attempts + 1);
  });

  test(`branch creation rejected with ${status} stays retryable after credentials are fixed`, async () => {
    const parent = { id: "br-parent", name: "production", protected: true, default: true };
    const branch = { id: "br-created", name: "preview/test", parent_id: parent.id, protected: false, default: false };
    let creates = 0;
    let rejecting = true;
    let created = false;
    serve((method, path) => {
      if (method === "GET" && path === "/projects/project")
        return Response.json({ project: { id: "project", name: "test", pg_version: 18, region_id: "aws-us-east-2" } });
      if (method === "GET" && path === "/projects/project/branches")
        return Response.json({ branches: created ? [parent, branch] : [parent] });
      if (method === "GET" && path === "/projects/project/endpoints")
        return Response.json({
          endpoints: created
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
      if (method === "POST" && path === "/projects/project/branches") {
        creates += 1;
        if (rejecting) return denial(status);
        created = true;
        return Response.json({ branch, endpoints: [], operations: [] });
      }
      return readiness("project", branch.id, method, path, undefined);
    });
    const input = {
      key: "c".repeat(64),
      projectId: "project",
      parentBranchId: "br-parent",
      branchName: "preview/test",
      environment: "preview" as const,
    };
    const failure = await provisionNeonBranch(root, input).catch((cause: Error) => cause);
    assert.ok(failure instanceof NeonCredentialError);
    expect(failure.code).toBe(code);
    const receipt = await readFile(join(root, ".kello/provision", input.key, "branch.json"), "utf8");
    expect(JSON.parse(receipt)).toMatchObject({ state: "rejected", status });
    expect(receipt).not.toContain("fixture-provider-secret");
    rejecting = false;
    const attempts = creates;
    expect(await provisionNeonBranch(root, input)).toMatchObject({ state: "complete", branchId: "br-created" });
    expect(creates).toBe(attempts + 1);
  });
}

for (const [status, code] of [
  [401, "NEON_SESSION_REVOKED"],
  [403, "NEON_PERMISSION_DENIED"],
] as const) {
  test(`a project whose readiness poll is denied with ${status} stays acknowledged and resumes without a second create`, async () => {
    let creates = 0;
    let denied: number | undefined = status;
    let renamed = false;
    serve((method, path) => {
      if (method === "POST" && path === "/projects") {
        creates += 1;
        return Response.json({
          project: { id: "project-created", name: "kello-temp" },
          operations: [operation("project-created", "br-main", "running")],
        });
      }
      if (method === "PATCH" && path === "/projects/project-created") {
        renamed = true;
        return Response.json({ project: { id: "project-created", name: "app" }, operations: [] });
      }
      return readiness("project-created", "br-main", method, path, denied);
    });
    const input = { name: "app", orgId: "org-test", region: "aws-us-east-1" };
    const failure = await createNeonProject(root, input).catch((cause: Error) => cause);
    assert.ok(failure instanceof NeonCredentialError);
    expect(failure.code).toBe(code);
    const receipt = JSON.parse(await readFile(join(root, ".kello/onboarding.json"), "utf8"));
    expect(receipt).toMatchObject({ phase: "identified", projectId: "project-created" });
    expect(renamed).toBe(false);
    denied = undefined;
    expect((await createNeonProject(root, input)).projectId).toBe("project-created");
    expect(creates).toBe(1);
    expect(renamed).toBe(true);
  });

  test(`a branch whose readiness poll is denied with ${status} stays acknowledged and resumes without a second create`, async () => {
    const parent = { id: "br-parent", name: "production", protected: true, default: true };
    const branch = { id: "br-created", name: "preview/test", parent_id: parent.id, protected: false, default: false };
    let creates = 0;
    let denied: number | undefined = status;
    serve((method, path) => {
      if (method === "GET" && path === "/projects/project")
        return Response.json({ project: { id: "project", name: "test", pg_version: 18, region_id: "aws-us-east-2" } });
      if (method === "GET" && path === "/projects/project/branches")
        return Response.json({ branches: creates ? [parent, branch] : [parent] });
      if (method === "GET" && path === "/projects/project/endpoints")
        return Response.json({
          endpoints: creates
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
      if (method === "POST" && path === "/projects/project/branches") {
        creates += 1;
        return Response.json({ branch, endpoints: [], operations: [operation("project", branch.id, "running")] });
      }
      return readiness("project", branch.id, method, path, denied);
    });
    const input = {
      key: "d".repeat(64),
      projectId: "project",
      parentBranchId: "br-parent",
      branchName: "preview/test",
      environment: "preview" as const,
    };
    const failure = await provisionNeonBranch(root, input).catch((cause: Error) => cause);
    assert.ok(failure instanceof NeonCredentialError);
    expect(failure.code).toBe(code);
    const receipt = JSON.parse(await readFile(join(root, ".kello/provision", input.key, "branch.json"), "utf8"));
    expect(receipt).toMatchObject({ state: "created", branchId: "br-created" });
    denied = undefined;
    expect(await provisionNeonBranch(root, input)).toMatchObject({ state: "complete", branchId: "br-created" });
    expect(creates).toBe(1);
  });
}

test("readiness ignores finished and failed operations, including other actors' failures", async () => {
  const polled: string[] = [];
  serve((method, path) => {
    if (method === "GET" && path === "/projects/project/operations")
      return Response.json({
        operations: [
          { ...operation("project", "br-other", "failed"), id: "op-failed" },
          { ...operation("project", "br-target", "cancelled"), id: "op-cancelled" },
          { ...operation("project", "br-target", "error"), id: "op-error" },
          { ...operation("project", "br-target", "finished"), id: "op-finished" },
        ],
      });
    if (method === "GET" && path.startsWith("/projects/project/operations/")) polled.push(path);
    return undefined;
  });
  await waitForProvisioning(createKelloNeonClient(), "project");
  await waitForProvisioning(createKelloNeonClient(), "project", "br-target");
  expect(polled).toEqual([]);
});

test("readiness waits on in-progress operations of the target branch only", async () => {
  const polled: string[] = [];
  serve((method, path) => {
    if (method === "GET" && path === "/projects/project/operations")
      return Response.json({
        operations: [
          { ...operation("project", "br-target", "running"), id: "op-target" },
          { ...operation("project", "br-other", "running"), id: "op-other" },
        ],
      });
    if (method === "GET" && path.startsWith("/projects/project/operations/")) {
      polled.push(path);
      const id = path.split("/").at(-1) ?? "";
      return Response.json({ operation: { ...operation("project", "br-target", "finished"), id } });
    }
    return undefined;
  });
  await waitForProvisioning(createKelloNeonClient(), "project", "br-target");
  expect(polled).toEqual(["/projects/project/operations/op-target"]);
});

test("readiness pages past the newest operations to the create's in-progress operation", async () => {
  const polled: string[] = [];
  const cursors: (string | null)[] = [];
  const since = Date.now();
  serve((method, path, url) => {
    if (method === "GET" && path === "/projects/project/operations") {
      const cursor = url.searchParams.get("cursor");
      cursors.push(cursor);
      if (cursor === null)
        return Response.json({
          operations: [
            { ...operation("project", "br-other", "running"), id: "op-busy" },
            { ...operation("project", "br-target", "failed"), id: "op-failed" },
          ],
          pagination: { cursor: "page-2" },
        });
      if (cursor === "page-2")
        return Response.json({
          operations: [
            { ...operation("project", "br-target", "running"), id: "op-create" },
            // Began before the create, beyond the skew allowance, so it is not this create's.
            {
              ...operation("project", "br-target", "running"),
              id: "op-stale",
              created_at: new Date(since - 120_000).toISOString(),
            },
          ],
          pagination: { cursor: "page-3" },
        });
      return Response.json({ operations: [], pagination: { cursor: "page-4" } });
    }
    if (method === "GET" && path.startsWith("/projects/project/operations/")) {
      polled.push(path);
      const id = path.split("/").at(-1) ?? "";
      return Response.json({ operation: { ...operation("project", "br-target", "finished"), id } });
    }
    return undefined;
  });
  await waitForProvisioning(createKelloNeonClient(), "project", "br-target", since);
  expect(polled).toEqual(["/projects/project/operations/op-create"]);
  // The empty page ends the walk even though Neon still returned a cursor.
  expect(cursors).toEqual([null, "page-2", "page-3"]);
});

test("readiness stops paging at the page cap and waits on what it found", async () => {
  const polled: string[] = [];
  let pages = 0;
  serve((method, path) => {
    if (method === "GET" && path === "/projects/project/operations") {
      pages += 1;
      const status = pages === 1 ? "running" : "finished";
      return Response.json({
        operations: [{ ...operation("project", "br-target", status), id: `op-${pages}` }],
        pagination: { cursor: `page-${pages + 1}` },
      });
    }
    if (method === "GET" && path.startsWith("/projects/project/operations/")) {
      polled.push(path);
      const id = path.split("/").at(-1) ?? "";
      return Response.json({ operation: { ...operation("project", "br-target", "finished"), id } });
    }
    return undefined;
  });
  await waitForProvisioning(createKelloNeonClient(), "project", undefined, Date.now());
  expect(pages).toBe(20);
  expect(polled).toEqual(["/projects/project/operations/op-1"]);
});
