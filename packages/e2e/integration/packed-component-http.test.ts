import assert from "node:assert/strict";
import { test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { prepareCloudComponents } from "../fixtures/cloud-components";

const connectionString = process.env.LOOM_TEST_DATABASE_URL;
test.skipIf(!connectionString)(
  "packed cloud component webhook invokes its private database handler",
  async () => {
    assert(connectionString);
    const root = await mkdtemp(join(tmpdir(), "loom-packed-http-"));
    const databaseName = `http_${crypto.randomUUID().replaceAll("-", "")}`;
    const runtimeRole = `runtime_${crypto.randomUUID().replaceAll("-", "")}`;
    const control = new pg.Client({ connectionString });
    const address = new URL(connectionString);
    address.pathname = `/${databaseName}`;
    const database = new pg.Client({ connectionString: address.href });
    let stop: (() => Promise<void>) | undefined;
    await control.connect();
    try {
      await control.query(`CREATE DATABASE "${databaseName}"`);
      await database.connect();
      await prepareCloudComponents(root);
      const tooling: typeof import("kello-cli") = await import(
        join(root, "node_modules/kello-cli/dist/tooling/index.js")
      );
      const server: typeof import("kello/server") = await import(
        join(root, "node_modules/kello/dist/core/server/index.js")
      );
      const neon: typeof import("kello/neon") = await import(
        join(root, "node_modules/kello/dist/core/adapters/neon/index.js")
      );
      await writeFile(
        join(root, "kello.config.ts"),
        'import {defineConfig} from "kello-cli"; export default defineConfig({project:"components"});',
      );
      await tooling.generateRelease(root, "initial");
      const project = await tooling.loadProject(root);
      for (const scope of tooling.projectMigrationScopes(project)) {
        await tooling.applyMigrations({
          root,
          connectionString: address.href,
          runtimeRole,
          namespace: scope.namespace,
          migrations: scope.migrations,
          metadataNamespace: project.config.database.metadataNamespace,
        });
      }
      await database.query(`ALTER ROLE "${runtimeRole}" LOGIN PASSWORD 'packed-http-test-only'`);
      address.username = runtimeRole;
      address.password = "packed-http-test-only";
      const secret = "packed-webhook-test-only";
      const runtime = await server.createRpcRuntime({
        ...tooling.projectRuntimeGraph(project),
        schema: project.schema,
        relations: project.relations,
        application: project.application,
        auth: project.auth,
        environment: { SIGNING_SECRET: secret },
        connectionString: address.href,
        metadataNamespace: project.config.database.metadataNamespace,
        version: "a".repeat(64),
        deployment: "packed-http",
        assertActive: async () => {},
      });
      stop = () => runtime.stop();
      const ingress = await neon.createNeonRpcApplication({
        ...runtime.auth,
        router: runtime.router,
        componentHttp: runtime.componentHttp,
        version: "a".repeat(64),
      });
      stop = () => ingress.stop().finally(() => runtime.stop());
      const left = project.componentScopes.find((scope) => scope.mountPath === "left");
      assert(left);
      const table = `"${left.schema.metadata.namespace}"."entries"`;
      const send = (body: string, signature = createHmac("sha256", secret).update(body).digest("hex")) =>
        ingress.fetch(
          new Request("https://api.test/api/components/left/event", {
            method: "POST",
            headers: { signature, "content-type": "application/json" },
            body,
          }),
        );
      assert.equal((await send('{"text":"signed"}', "invalid")).status, 401);
      assert.equal((await send('{"text":42}')).status, 400);
      assert.equal((await database.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count, 0);
      const response = await send('{"text":"signed"}');
      assert.equal(response.status, 204, await response.text());
      const result = await database.query(`SELECT text,owner,issuer FROM ${table}`);
      assert.deepEqual(result.rows, [{ text: "v1:signed", owner: "webhook", issuer: "webhook" }]);
    } finally {
      await stop?.();
      await database.end();
      await control.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
      await control.query(`DROP ROLE IF EXISTS "${runtimeRole}"`);
      await control.end();
      await rm(root, { recursive: true, force: true });
    }
  },
  120000,
);
