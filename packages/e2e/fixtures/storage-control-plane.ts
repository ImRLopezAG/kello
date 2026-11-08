import assert from "node:assert/strict";
import { createRealNeonApi } from "@neon/config-runtime/v1";
import * as v from "valibot";

const bucketRequest = v.strictObject({ name: v.string(), access_level: v.literal("private") });
const triggerRequest = v.strictObject({
  type: v.literal("storage_object_created"),
  name: v.string(),
  function_slug: v.string(),
  function_path: v.literal("/api/kello/triggers"),
  enabled: v.literal(false),
  storage_object_created: v.strictObject({ bucket_name: v.string(), prefix: v.string() }),
});

/** Exercises the pinned SDK's HTTP serialization and response parsing without cloud mutations. */
export function storageControlPlaneFixture() {
  const buckets: v.InferOutput<typeof bucketRequest>[] = [];
  const triggers: (Omit<v.InferOutput<typeof triggerRequest>, "enabled"> & {
    enabled: boolean;
    trigger_id: string;
    inherited: boolean;
  })[] = [];
  const writes: string[] = [];
  const state = { accessLevel: "private", omitAccessLevel: false };
  const bucketResponse = (bucket: v.InferOutput<typeof bucketRequest>) => {
    if (state.omitAccessLevel) return { name: bucket.name };
    return { name: bucket.name, access_level: state.accessLevel };
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      assert.equal(request.headers.get("authorization"), "Bearer fixture-only");
      const path = new URL(request.url).pathname;
      if (path === "/projects/project/branches/br-preview/buckets") {
        if (request.method === "GET") return Response.json({ buckets: buckets.map(bucketResponse) });
        if (request.method === "POST") {
          const bucket = v.parse(bucketRequest, await request.json());
          assert.ok(!buckets.some((existing) => existing.name === bucket.name));
          buckets.push(bucket);
          writes.push("bucket");
          return Response.json({ bucket: bucketResponse(bucket) });
        }
      }
      if (path === "/projects/project/branches/br-preview/triggers") {
        if (request.method === "GET") return Response.json({ triggers });
        if (request.method === "POST") {
          const input = v.parse(triggerRequest, await request.json());
          assert.ok(buckets.some((bucket) => bucket.name === input.storage_object_created.bucket_name));
          assert.ok(!triggers.some((existing) => existing.name === input.name));
          const trigger = { ...input, trigger_id: crypto.randomUUID(), inherited: false };
          triggers.push(trigger);
          writes.push("trigger");
          return Response.json({ trigger });
        }
      }
      if (request.method === "PATCH" && path.startsWith("/projects/project/branches/br-preview/triggers/")) {
        const trigger = triggers.find((entry) => path.endsWith(`/${entry.trigger_id}`));
        assert.ok(trigger);
        const input = v.parse(
          v.strictObject({ type: v.literal("storage_object_created"), enabled: v.literal(true) }),
          await request.json(),
        );
        trigger.enabled = input.enabled;
        writes.push("enable");
        return Response.json({ trigger });
      }
      return new Response("Unexpected control-plane request", { status: 400 });
    },
  });
  const provider = Object.assign(
    createRealNeonApi({ apiKey: "fixture-only", baseUrl: server.url.href.replace(/\/$/, "") }),
    {
      getProject: async () => ({ id: "project", name: "tasks", regionId: "aws-us-east-2", pgVersion: 18 }),
      listBranches: async () => [{ id: "br-preview", name: "preview", protected: false, isDefault: false }],
      listEndpoints: async () => [
        {
          id: "ep-preview",
          branchId: "br-preview",
          type: "read_write" as const,
          autoscalingLimitMinCu: 0.25,
          autoscalingLimitMaxCu: 1,
          suspendTimeout: 300,
        },
      ],
      listBranchFunctions: async () => [
        {
          id: "fn-worker",
          name: "worker",
          slug: "kelloworker",
          invocationUrl: "https://example.test",
          activeDeploymentId: 1,
          currentDeployment: { id: 1, status: "completed" as const },
        },
      ],
    },
  );
  return { provider, writes, state, cleanup: () => server.stop(true) };
}
