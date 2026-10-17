import assert from "node:assert/strict";
import { test } from "bun:test";
import { mkdtemp, writeFile, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { setTimeout } from "node:timers/promises";
import pg from "pg";
import { get } from "node:https";
import { buildNeonFunctionBundle } from "kello/tooling";
import { createKelloNeonApi, bootstrapDatabase, inspectDeploymentTarget, defineConfig } from "kello/tooling";
import { createRpcHttpTransport } from "kello/client";

test.skipIf(process.env.LOOM_CLOUD_HOSTED_AUTH !== "1")(
  "managed auth signs in through a deployed Kello Function and verifies its token for RPC",
  async () => {
    const projectId = process.env.KELLO_CLOUD_PROJECT_ID;
    const branchId = process.env.LOOM_CLOUD_BRANCH_ID;
    const connectionString = process.env.LOOM_TEST_DATABASE_URL;
    assert(projectId && branchId && connectionString);
    const target = await inspectDeploymentTarget(
      defineConfig({ project: "auth", provider: { projectId, targets: { preview: { branchId } } } }),
      "preview",
    );
    assert(!target.protected && target.branchName.startsWith("loom-acceptance-"));
    assert.equal(new URL(connectionString).hostname.split(".")[0], target.endpointId);
    const api = createKelloNeonApi();
    const slug = `lauth${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
    assert(!(await api.listBranchFunctions(projectId, branchId)).some((fn) => fn.slug === slug));
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const metadataNamespace = `loom_auth_${suffix}`;
    const runtimeRole = `runtime_${suffix}`;
    const root = await mkdtemp(join(tmpdir(), "loom-hosted-auth-"));
    const admin = new pg.Client({ connectionString });
    await admin.connect();
    let deployed = false;
    let transport: ReturnType<typeof createRpcHttpTransport> | undefined;
    try {
      await bootstrapDatabase({ connectionString, metadataNamespace, runtimeRole });
      const password = crypto.randomUUID();
      await admin.query(`ALTER ROLE "${runtimeRole}" LOGIN PASSWORD '${password}'`);
      const address = new URL(connectionString);
      address.username = runtimeRole;
      address.password = password;
      await symlink(fileURLToPath(new URL("../node_modules/", import.meta.url)), join(root, "node_modules"));
      const source = join(root, "index.mjs");
      await writeFile(
        source,
        `
import {createNeonRpcService,neonAuth} from "kello/neon";
import {defineSchema,defineRpcAuth} from "kello/server";
import {defineRelations} from "drizzle-orm";
import {oc} from "kello/contract";
import {implement,ORPCError} from "@orpc/server";
import * as v from "valibot";
const schema=defineSchema(()=>({}));
const contract={whoami:oc.output(v.strictObject({subject:v.string()}))};
const whoami=implement(contract).whoami.handler(({context})=>({subject:context.identity.subject}));
const service = await createNeonRpcService({schema,relations:defineRelations(schema.tables),connectionString:process.env.LOOM_DATABASE_URL,
metadataNamespace:${JSON.stringify(metadataNamespace)},deployment:"auth-acceptance",version:"${"a".repeat(64)}",procedures:[{path:["whoami"],visibility:"public",procedure:whoami}],
auth:defineRpcAuth({verification:neonAuth({origins:["http://localhost:5173"]}),authorize:({identity})=>{if(!identity)throw new ORPCError("UNAUTHORIZED")}}),
assertActive:async()=>{}});
export default {...service, async fetch(request) {
  if (new URL(request.url).pathname === "/cookie-probe") {
    return new Response(null, { headers: [
      ["set-cookie", "__Secure-first=one; Path=/; Secure; HttpOnly"],
      ["set-cookie", "__Secure-second=two; Path=/; Secure; HttpOnly"],
      ["x-test-revision", ${JSON.stringify(suffix)}],
    ] });
  }
  return service.fetch(request);
}};
`,
      );
      const environment = {
        LOOM_DATABASE_URL: address.href,
        NEON_AUTH_COOKIE_SECRET: crypto.randomUUID() + crypto.randomUUID(),
      };
      const bundle = await buildNeonFunctionBundle(source);
      const deployment = await api.deployBranchFunction(projectId, branchId, slug, {
        bundle,
        runtime: "nodejs24",
        environment,
      });
      deployed = true;
      const signal = AbortSignal.timeout(180_000);
      let url: string | undefined;
      for (;;) {
        signal.throwIfAborted();
        const current = (await api.listBranchFunctions(projectId, branchId)).find((fn) => fn.slug === slug);
        assert.notEqual(current?.currentDeployment?.status, "failed", "Hosted auth deployment failed");
        if (current?.activeDeploymentId === deployment.id && current.currentDeployment?.status === "completed") {
          url = current.invocationUrl;
          break;
        }
        await setTimeout(1000, undefined, { signal });
      }
      assert(url);
      const probe = await new Promise<{ cookies: string[]; revision: string | string[] | undefined }>(
        (resolve, reject) => {
          const request = get(new URL("/cookie-probe", url), (response) => {
            response.resume();
            resolve({ cookies: response.headers["set-cookie"] ?? [], revision: response.headers["x-test-revision"] });
          });
          request.setTimeout(30_000, () => request.destroy(new Error("Cookie probe timed out")));
          request.on("error", reject);
        },
      );
      assert.equal(probe.revision, suffix, "Acceptance must reach the newly deployed Function");
      assert.deepEqual(
        probe.cookies.map((cookie) => cookie.split("=", 1)[0]),
        ["__Secure-first", "__Secure-second"],
        "Neon Functions must preserve multiple Set-Cookie headers before hosted auth can be accepted",
      );
      const cookies = new Map<string, string>();
      async function auth(path: string, body?: Record<string, string>) {
        const init: RequestInit = {
          method: body ? "POST" : "GET",
          headers: {
            origin: "http://localhost:5173",
            "content-type": "application/json",
            cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join("; "),
          },
          signal: AbortSignal.timeout(30_000),
          redirect: "manual",
        };
        if (body) init.body = JSON.stringify(body);
        const response = await fetch(new URL(`/api/auth/${path}`, url), init);
        for (const cookie of response.headers.getSetCookie()) {
          const pair = cookie.split(";", 1)[0]!;
          const separator = pair.indexOf("=");
          cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
        }
        assert.equal(response.status, 200, `Hosted auth ${path} failed`);
        return response.json();
      }
      const email = `loom-${suffix}@example.test`;
      const signup = await auth("sign-up/email", { email, password: crypto.randomUUID(), name: "Hosted acceptance" });
      assert(signup.user.id);
      assert.equal((await auth("get-session")).user.id, signup.user.id);
      const token = await auth("token");
      assert(token.token);
      transport = createRpcHttpTransport({ url, version: "a".repeat(64), getToken: async () => token.token });
      const identity = await transport.link.call(["whoami"], undefined, { context: {} });
      assert.deepEqual(identity, { subject: signup.user.id });
      const denied = await fetch(new URL("/api/auth/get-session", url), {
        headers: { origin: "https://evil.test" },
        signal: AbortSignal.timeout(30_000),
      });
      assert.equal(denied.status, 403);
      await auth("sign-out", {});
      assert.equal(await auth("get-session"), null);
      console.log("Hosted managed auth: signup, session, JWT, protected RPC and signout passed");
    } finally {
      transport?.dispose();
      if (deployed) await api.deleteBranchFunction(projectId, branchId, slug);
      await admin.query(`DROP SCHEMA IF EXISTS "${metadataNamespace}" CASCADE`);
      await admin.query(`DROP ROLE IF EXISTS "${runtimeRole}"`);
      await admin.end();
      await rm(root, { recursive: true, force: true });
    }
  },
  240_000,
);
