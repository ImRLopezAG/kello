import assert from "node:assert/strict";
import { test } from "bun:test";
import { mkdtemp, writeFile, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { setTimeout } from "node:timers/promises";
import pg from "pg";
import { createLocalJWKSet, jwtVerify } from "jose";
import { buildNeonFunctionBundle } from "kello/tooling";
import { createAuthClient } from "better-auth/client";
import { jwtClient, organizationClient } from "better-auth/client/plugins";
import { resolveBetterAuthSchema } from "kello/better-auth";
import {
  createKelloNeonApi,
  inspectDeploymentTarget,
  defineConfig,
  emptySnapshot,
  planMigration,
  writeMigration,
  applyMigrations,
} from "kello/tooling";
import { ORPCError, MalformedResponseError } from "@orpc/client";
import { createRpcHttpTransport } from "kello/client";

import { nativeAuth } from "../fixtures/hosted-native-auth";
import { appPreferencesClient } from "../fixtures/app-auth-plugin-client";

test.skipIf(process.env.LOOM_CLOUD_HOSTED_AUTH !== "1")(
  "native bearer sessions exchange JWTs for protected RPC on deployed Neon Functions",
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
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const slug = `lba${suffix.slice(0, 8)}`;
    const namespace = `auth_${suffix}`;
    const metadataNamespace = `loom_auth_${suffix}`;
    const runtimeRole = `runtime_${suffix}`;
    const root = await mkdtemp(join(tmpdir(), "loom-native-auth-"));
    const source = join(root, "index.mjs");
    const admin = new pg.Client({ connectionString });
    await admin.connect();
    let deployed = false;
    let transport: ReturnType<typeof createRpcHttpTransport> | undefined;
    try {
      await symlink(fileURLToPath(new URL("../node_modules/", import.meta.url)), join(root, "node_modules"));
      async function deploy(environment: Record<string, string>) {
        const bundle = await buildNeonFunctionBundle(source);
        const deployment = await api.deployBranchFunction(projectId!, branchId!, slug, {
          bundle,
          runtime: "nodejs24",
          environment,
        });
        deployed = true;
        const signal = AbortSignal.timeout(180_000);
        for (;;) {
          signal.throwIfAborted();
          const current = (await api.listBranchFunctions(projectId!, branchId!)).find((fn) => fn.slug === slug);
          assert.notEqual(current?.currentDeployment?.status, "failed");
          if (current?.activeDeploymentId === deployment.id && current.currentDeployment?.status === "completed") {
            assert(current.invocationUrl);
            return current.invocationUrl;
          }
          await setTimeout(1000, undefined, { signal });
        }
      }
      // Obtain the provider-assigned URL before defining issuer and JWKS trust.
      await writeFile(
        source,
        'export default {fetch(){return new Response("bootstrap",{status:503,headers:{"x-loom-bootstrap":"1"}})}};',
      );
      const url = new URL(await deploy({})).origin;
      const secret = crypto.randomUUID() + crypto.randomUUID();
      const nativeSchema = await resolveBetterAuthSchema((database) => nativeAuth(database, url, secret), namespace);
      const plan = await planMigration(await emptySnapshot(namespace), { namespace, tables: nativeSchema.ownedTables });
      await writeMigration(root, "migrations", "auth", plan);
      await applyMigrations({
        connectionString,
        root,
        migrations: "migrations",
        namespace,
        metadataNamespace,
        runtimeRole,
      });
      const password = crypto.randomUUID();
      await admin.query(`ALTER ROLE "${runtimeRole}" LOGIN PASSWORD '${password}'`);
      const address = new URL(connectionString);
      address.username = runtimeRole;
      address.password = password;
      await writeFile(
        source,
        `
import {nativeAuth} from ${JSON.stringify(fileURLToPath(new URL("../fixtures/hosted-native-auth.ts", import.meta.url)))};
import {defineApplication} from "kello";
import {defineBetterAuth} from "kello/better-auth";
import {createNeonRpcService} from "kello/neon";
import {defineSchema,defineRpcAuth} from "kello/server";
import {defineRelations} from "drizzle-orm";
import {oc} from "kello/contract";
import {implement,ORPCError} from "@orpc/server";
import * as v from "valibot";
const application=defineApplication({rpc:({os})=>({os})});
application.use(defineBetterAuth({name:"identity",env:{},create:({database})=>nativeAuth(database,${JSON.stringify(url)},process.env.AUTH_SECRET)}));
const schema=defineSchema(()=>({}));
const contract={whoami:oc.output(v.strictObject({subject:v.string()}))};
const procedure=implement(contract).whoami.handler(({context})=>({subject:context.identity.subject}));
const service=await createNeonRpcService({application,schema,relations:defineRelations(schema.tables),connectionString:process.env.LOOM_DATABASE_URL,
metadataNamespace:${JSON.stringify(metadataNamespace)},deployment:"native-auth",version:"${"a".repeat(64)}",procedures:[{path:["whoami"],visibility:"public",procedure}],
authScopes:[{mountPath:"identity",namespace:${JSON.stringify(namespace)},fingerprint:${JSON.stringify(nativeSchema.fingerprint)}}],
config:{auth:{origins:[${JSON.stringify(url)}],issuers:[{issuer:${JSON.stringify(url)},jwksUrl:${JSON.stringify(url + "/api/auth/jwks")},audience:"loom-test",algorithms:["EdDSA"]}]}},
auth:defineRpcAuth({authorize:({identity})=>{if(!identity)throw new ORPCError("UNAUTHORIZED")}}),assertActive:async()=>{}});
export default {...service,fetch(request){if(new URL(request.url).pathname==="/revision")return new Response(${JSON.stringify(suffix)});return service.fetch(request)}};
`,
      );
      await deploy({ LOOM_DATABASE_URL: address.href, AUTH_SECRET: secret });
      async function deployedFetch(input: RequestInfo | URL, init?: RequestInit) {
        const signal = AbortSignal.timeout(90_000);
        for (;;) {
          const response = await fetch(input, { ...init, signal });
          // Only the inert bootstrap can produce this marker; it never executes an auth operation.
          if (response.headers.get("x-loom-bootstrap") !== "1") return response;
          await response.body?.cancel();
          await setTimeout(1000, undefined, { signal });
        }
      }
      assert.equal(await (await deployedFetch(`${url}/revision`)).text(), suffix);
      let credential: string | null = null;
      const client = createAuthClient({
        baseURL: url,
        plugins: [jwtClient(), organizationClient({ teams: { enabled: true } }), appPreferencesClient()],
        fetchOptions: {
          customFetchImpl: deployedFetch,
          auth: { type: "Bearer", token: () => credential ?? undefined },
          onSuccess(context) {
            const token = context.response.headers.get("set-auth-token");
            if (token) credential = token;
          },
          // No cookie jar: this must work through the public Function using bearer sessions alone.
        },
      });
      const signup = await client.signUp.email({
        email: `loom-${suffix}@example.test`,
        password: crypto.randomUUID(),
        name: "Hosted native",
      });
      assert.equal(signup.error, null);
      assert(signup.data?.user?.id, "Signup must return a user from the new deployment");
      assert(credential, "Native bearer plugin must expose the signed session credential");
      assert.equal((await client.getSession()).data?.user.id, signup.data.user.id);
      assert.equal((await client.appPreferences.set({ value: "hosted" })).error, null);
      assert.equal((await client.appPreferences.get()).data?.value, "hosted");
      assert.equal((await client.appPreferences.set({ value: "x".repeat(21) })).error?.status, 400);
      assert.equal((await deployedFetch(`${url}/api/auth/app-preferences/get`)).status, 401);
      const org = await client.organization.create({ name: "Hosted team", slug: "hosted" });
      assert.equal(org.error, null);
      assert(org.data?.id);
      assert.equal(
        (await client.organization.createTeam({ name: "Engineering", organizationId: org.data.id })).error,
        null,
      );
      const token = await client.token();
      assert.equal(token.error, null);
      assert(token.data?.token);
      const keys = await (await deployedFetch(`${url}/api/auth/jwks`)).json();
      const verified = await jwtVerify(token.data.token, createLocalJWKSet(keys), {
        issuer: url,
        audience: "loom-test",
        algorithms: ["EdDSA"],
      });
      assert.equal(verified.payload.sub, signup.data.user.id);
      transport = createRpcHttpTransport({ url, version: "a".repeat(64), getToken: async () => token.data!.token });
      const deadline = AbortSignal.timeout(90_000);
      for (;;) {
        try {
          assert.deepEqual(await transport.link.call(["whoami"], undefined, { context: {}, signal: deadline }), {
            subject: signup.data.user.id,
          });
          break;
        } catch (error) {
          // This fixture's read-only probe may race public JWKS routing during activation.
          const bootstrap =
            error instanceof ORPCError &&
            error.cause instanceof MalformedResponseError &&
            error.cause.response.headers["x-loom-bootstrap"] === "1";
          if (!bootstrap && !(error instanceof ORPCError && error.code === "UNAUTHORIZED")) throw error;
          await setTimeout(1000, undefined, { signal: deadline });
        }
      }
      const opaque = createRpcHttpTransport({ url, version: "a".repeat(64), getToken: async () => credential });
      try {
        for (;;) {
          try {
            await opaque.link.call(["whoami"], undefined, { context: {}, signal: deadline });
            assert.fail("Opaque session credentials must not authenticate Kello RPC");
          } catch (error) {
            if (
              error instanceof ORPCError &&
              error.cause instanceof MalformedResponseError &&
              error.cause.response.headers["x-loom-bootstrap"] === "1"
            ) {
              await setTimeout(1000, undefined, { signal: deadline });
              continue;
            }
            assert(error instanceof ORPCError && error.code === "UNAUTHORIZED");
            break;
          }
        }
      } finally {
        opaque.dispose();
      }
      assert.equal((await deployedFetch(`${url}/api/auth/token`)).status, 401);
      assert.equal((await client.signOut()).error, null);
      // Intentionally retain the old credential to prove server-side session revocation.
      assert.equal((await client.getSession()).data, null);
      assert.equal((await client.token()).error?.status, 401);
      credential = null;
      console.log(
        "Hosted native bearer: session, organization/team, JWT, protected RPC, opaque-token rejection and signout passed",
      );
    } finally {
      transport?.dispose();
      if (deployed) await api.deleteBranchFunction(projectId, branchId, slug);
      await admin.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
      await admin.query(`DROP SCHEMA IF EXISTS "${metadataNamespace}" CASCADE`);
      await admin.query(`DROP ROLE IF EXISTS "${runtimeRole}"`);
      await admin.end();
      await rm(root, { recursive: true, force: true });
    }
    if (process.env.LOOM_CLOUD_RECEIPT) {
      await writeFile(
        process.env.LOOM_CLOUD_RECEIPT,
        JSON.stringify({
          projectId,
          branchId,
          passed: true,
          suite: "better-auth",
          checks: [
            "app-defined-plugin",
            "native-bearer",
            "organization-teams",
            "jwt-rpc",
            "opaque-token-rejected",
            "session-revoked",
          ],
        }) + "\n",
      );
    }
  },
  420_000,
);
