import assert from "node:assert/strict";
import { test } from "bun:test";
import { createHmac } from "node:crypto";
import { Effect } from "effect";
import { defineRelations } from "drizzle-orm";
import pg from "pg";
import * as v from "valibot";
import { bootstrapDatabase } from "kello-cli";
import { defineComponent } from "../../../apps/kello/src/core/server/components/definition";
import { readComponentEnvironment } from "../../../apps/kello/src/core/server/components/environment";
import { defineApplication } from "../../../apps/kello/src/core/server/application/definition";
import { defineSchema } from "../../../apps/kello/src/core/schema/define-schema";
import { createRpcRuntime } from "../../../apps/kello/src/core/server/rpc-runtime";
import { createNeonRpcApplication } from "../../../apps/kello/src/core/adapters/neon/rpc-application";

const connectionString = process.env.LOOM_TEST_DATABASE_URL;
test.skipIf(!connectionString)(
  "assembled HTTP isolates signing environments and drains timed-out handlers before SDK disposal",
  async () => {
    if (!connectionString) throw new Error("Missing database URL");
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const metadataNamespace = `loom_http_${suffix}`;
    const runtimeRole = `http_runtime_${suffix}`;
    const admin = new pg.Client({ connectionString });
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const events: string[] = [];
    let acquired = 0;
    let released = 0;
    let writes = 0;
    const component = defineComponent({
      name: "webhook",
      env: { SECRET: v.string() },
      services: () =>
        Effect.acquireRelease(
          Effect.sync(() => {
            acquired++;
            return { sdk: { ready: true } };
          }),
          () =>
            Effect.sync(() => {
              released++;
              events.push("released");
            }),
        ),
      http: [
        {
          method: "GET",
          path: "/private",
          access: {
            kind: "verified-user",
            authorize: (session): boolean => session.identity.subject === readComponentEnvironment(component).SECRET,
          },
          handle: () => new Response("authorized"),
        },
        {
          method: "POST",
          path: "/event",
          requestTimeoutMs: 40,
          access: {
            kind: "signed-webhook",
            verify: ({ request, body }) => {
              // This is the same ambient accessor emitted by the generated env facade.
              const { SECRET } = readComponentEnvironment(component);
              const expected = createHmac("sha256", SECRET).update(body).digest("hex");
              if (request.headers.get("signature") !== expected) throw new Error("Invalid signature");
            },
          },
          handle: async ({ context, request }) => {
            assert.equal(context.services.sdk.ready, true);
            if (request.headers.get("hold") === "yes") {
              entered.resolve();
              await resume.promise;
              events.push("handler-finished");
            } else writes++;
            return new Response(null, { status: 204 });
          },
        },
      ],
    });
    const application = defineApplication({ env: { LEFT: v.string(), RIGHT: v.string() }, rpc: ({ os }) => ({ os }) });
    application.use(component, { name: "left", env: { SECRET: application.env.LEFT } });
    application.use(component, { name: "right", env: { SECRET: application.env.RIGHT } });
    await admin.connect();
    let service: Awaited<ReturnType<typeof createNeonRpcApplication>> | undefined;
    let runtime: Awaited<ReturnType<typeof createRpcRuntime>> | undefined;
    try {
      await bootstrapDatabase({ connectionString, metadataNamespace, runtimeRole });
      await admin.query(`ALTER ROLE "${runtimeRole}" LOGIN PASSWORD 'loom-test-only'`);
      const address = new URL(connectionString);
      address.username = runtimeRole;
      address.password = "loom-test-only";
      const schema = defineSchema(() => ({}));
      runtime = await createRpcRuntime({
        schema,
        relations: defineRelations(schema.tables),
        connectionString: address.href,
        metadataNamespace,
        deployment: "http-security",
        version: "a".repeat(64),
        procedures: [],
        application,
        environment: { LEFT: "left-fixture", RIGHT: "right-fixture" },
        scopes: [
          { name: "", dependencies: { left: "left", right: "right" }, schema },
          { name: "left", dependencies: {}, schema },
          { name: "right", dependencies: {}, schema },
        ],
        assertActive: async () => {},
      });
      const ingress = await createNeonRpcApplication({
        ...runtime.auth,
        router: runtime.router,
        version: "a".repeat(64),
        componentHttp: runtime.componentHttp,
        // Token verification is separately covered; this fixture isolates mount authorization.
        verify: async (token) => ({
          identity: { issuer: "fixture", subject: token },
          expiresAt: Date.now() / 1000 + 60,
        }),
      });
      const ownedRuntime = runtime;
      service = {
        fetch: (request) => ingress.fetch(request),
        stop: () => ingress.stop().finally(() => ownedRuntime.stop()),
      };
      const privateRequest = (mount: string, token: string) =>
        service!.fetch(
          new Request(`https://api.test/api/components/${mount}/private`, {
            headers: { authorization: `Bearer ${token}` },
          }),
        );
      assert.equal((await privateRequest("left", "right-fixture")).status, 403);
      assert.equal((await privateRequest("right", "left-fixture")).status, 403);
      assert.equal(acquired, 0);
      const send = (mount: string, secret: string, hold = false) => {
        const body = "original bytes";
        const headers = new Headers({ signature: createHmac("sha256", secret).update(body).digest("hex") });
        if (hold) headers.set("hold", "yes");
        return service!.fetch(
          new Request(`https://api.test/api/components/${mount}/event`, {
            method: "POST",
            body,
            headers,
          }),
        );
      };
      assert.equal((await send("left", "right-fixture")).status, 401);
      assert.equal((await send("right", "left-fixture")).status, 401);
      assert.equal(acquired, 0);
      assert.equal(writes, 0);
      assert.equal((await send("left", "left-fixture")).status, 204);
      assert.equal((await send("right", "right-fixture")).status, 204);
      assert.equal((await privateRequest("left", "left-fixture")).status, 200);
      assert.equal((await privateRequest("right", "right-fixture")).status, 200);
      assert.equal(acquired, 2);
      assert.equal(writes, 2);
      const pending = send("left", "left-fixture", true);
      await entered.promise;
      assert.equal((await pending).status, 504);
      let stopped = false;
      const stopping = service.stop().then(() => {
        stopped = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(stopped, false);
      assert.equal(released, 0);
      resume.resolve();
      await stopping;
      assert.equal(released, 2);
      assert.equal(events[0], "handler-finished");
    } finally {
      resume.resolve();
      await service?.stop();
      await runtime?.stop();
      await admin.query(`DROP SCHEMA IF EXISTS "${metadataNamespace}" CASCADE`);
      await admin.query(`DROP OWNED BY "${runtimeRole}"`).catch(() => {});
      await admin.query(`DROP ROLE IF EXISTS "${runtimeRole}"`);
      await admin.end();
    }
  },
);
