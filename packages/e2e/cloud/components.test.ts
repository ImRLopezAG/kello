import assert from "node:assert/strict";
import { test } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import * as v from "valibot";
import { createORPCClient, type Client } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { createKelloNeonApi, defineConfig, inspectDeploymentTarget } from "kello/tooling";
import { createCloudIssuer } from "../fixtures/cloud-issuer";
import { configureCloudComponents, prepareCloudComponents } from "../fixtures/cloud-components";

const entries = v.array(v.object({ _id: v.string(), text: v.string() }));
type Entries = v.InferOutput<typeof entries>;
type Target = { target: "left" | "right" };
type ClientTree = {
  journal: {
    list: Client<Record<never, never>, Target, Entries, Error>;
    watch: Client<Record<never, never>, Target, AsyncIterable<Entries>, Error>;
  };
  left: { internal: { entries: { insert: Client<Record<never, never>, { text: string }, unknown, Error> } } };
};

test.skipIf(process.env.LOOM_CLOUD_COMPONENTS !== "1")(
  "packed components survive real Neon isolation, transport and release boundaries",
  async () => {
    const projectId = process.env.LOOM_CLOUD_PROJECT_ID;
    const branchId = process.env.LOOM_CLOUD_BRANCH_ID;
    const connectionString = process.env.LOOM_MIGRATION_DATABASE_URL;
    const runtimeRole = process.env.LOOM_CLOUD_RUNTIME_ROLE;
    assert(projectId && branchId && connectionString && runtimeRole);
    assert.match(runtimeRole, /^runtime_[a-f0-9]{32}$/);
    const target = await inspectDeploymentTarget(
      defineConfig({ project: "components", provider: { projectId, targets: { preview: { branchId } } } }),
      "preview",
    );
    assert(!target.protected && target.branchName.startsWith("loom-acceptance-"));
    const neonApi = createKelloNeonApi();
    let submissionFailure: { status?: number; code?: string; name: string } | undefined;
    const provider: ReturnType<typeof createKelloNeonApi> = {
      ...neonApi,
      deployBranchFunction: async (...args) => {
        try {
          return await neonApi.deployBranchFunction(...args);
        } catch (cause) {
          const status = v.safeParse(
            v.object({
              details: v.object({ status: v.pipe(v.number(), v.integer(), v.minValue(100), v.maxValue(599)) }),
            }),
            cause,
          );
          const code = v.safeParse(
            v.object({
              code: v.picklist([
                "NEON_SESSION_REVOKED",
                "NEON_PERMISSION_DENIED",
                "NEON_LOGIN_REQUIRED",
                "NEON_REFRESH_FAILED",
                "NEON_CREDENTIAL_UNAVAILABLE",
              ]),
            }),
            cause,
          );
          submissionFailure = {
            name: cause instanceof Error ? cause.name : "UnknownError",
          };
          if (status.success) submissionFailure.status = status.output.details.status;
          if (code.success) submissionFailure.code = code.output.code;
          throw cause;
        }
      },
    };
    const root = await mkdtemp(join(tmpdir(), "loom-cloud-components-"));
    const admin = new pg.Client({ connectionString, connectionTimeoutMillis: 15000 });
    const oldEnvironment = {
      secret: process.env.SIGNING_SECRET,
      database: process.env.LOOM_DATABASE_URL,
      activation: process.env.LOOM_ACTIVATION_TOKEN,
    };
    const origin = `https://components-${crypto.randomUUID()}.test`;
    const secret = crypto.randomUUID();
    const checks: string[] = [];
    const releases: { version: string; elapsedMs: number }[] = [];
    let stage = "prepare";
    try {
      await prepareCloudComponents(root);
      const tooling: typeof import("kello/tooling") = await import(
        join(root, "node_modules/kello/dist/tooling/index.js")
      );
      const {
        applyMigrations,
        deployProjectRelease,
        generateProject,
        generateRelease,
        loadProject,
        projectMigrationScopes,
        readNeonFunctionReceipt,
        readMigrations,
        declareProjectCompatibility,
      } = tooling;
      const issuer = await createCloudIssuer(root, projectId, branchId);
      const address = new URL(connectionString);
      await writeFile(
        join(root, "kello.config.ts"),
        `import {defineConfig} from "kello/tooling"; export default defineConfig(${JSON.stringify({ project: "components", openapi: true, provider: { projectId, targets: { preview: { branchId } } }, auth: { origins: [origin], audience: "loom-acceptance", issuers: [{ issuer: issuer.issuer, jwksUrl: issuer.jwksUrl }] }, deployment: { environment: "preview", deployment: "preview", databaseName: decodeURIComponent(address.pathname.slice(1)), migrationRole: decodeURIComponent(address.username), runtimeRole, quarantine: "preserve" } })});`,
      );
      process.env.SIGNING_SECRET = secret;
      process.env.LOOM_ACTIVATION_TOKEN = crypto.randomUUID().replaceAll("-", "").repeat(2);
      await generateRelease(root, "initial");
      async function migrate(includeComponents = true) {
        const project = await loadProject(root);
        for (const scope of projectMigrationScopes(project).filter((scope) => includeComponents || !scope.mountPath))
          await applyMigrations({
            root,
            connectionString: connectionString!,
            runtimeRole: runtimeRole!,
            namespace: scope.namespace,
            migrations: scope.migrations,
            metadataNamespace: project.config.database.metadataNamespace,
          });
        return project;
      }
      // The deployment claims component namespaces before creating their schemas.
      await migrate(false);
      await admin.connect();
      const password = crypto.randomUUID();
      await admin.query(`ALTER ROLE "${runtimeRole}" LOGIN PASSWORD '${password}'`);
      address.username = runtimeRole;
      address.password = password;
      process.env.LOOM_DATABASE_URL = address.href;
      async function deploy(file = "kello.config.ts") {
        const started = performance.now();
        const generated = await generateProject(root);
        const release = await deployProjectRelease(root, file, provider, AbortSignal.timeout(240000));
        const functions = release.completed.find((entry) => entry.stage === "functions");
        assert(functions);
        const receipt = await readNeonFunctionReceipt(root, functions.artifactHash);
        const service = receipt.functions[0]?.invocationUrl;
        assert(service);
        releases.push({ version: generated.version, elapsedMs: performance.now() - started });
        return { service, version: generated.version };
      }
      stage = "initial deployment";
      let current = await deploy();
      const token = await issuer.token("owner", "loom-acceptance", "30m");
      async function request(
        path: string,
        input: Target | { text: string } | Record<never, never>,
        bearer = token,
        prefix = "openapi",
        version = current.version,
      ) {
        return fetch(new URL(`/api/kello/${prefix}${path ? `/${path}` : ""}`, current.service), {
          method: "POST",
          headers: {
            authorization: `Bearer ${bearer}`,
            origin,
            "content-type": "application/json",
            "x-loom-protocol": "loom-orpc-2",
            "x-loom-version": version,
          },
          body: JSON.stringify(input),
          signal: AbortSignal.timeout(20000),
        });
      }
      async function list(target: "left" | "right", bearer = token) {
        const response = await request("journal/list", { target }, bearer);
        assert.equal(response.status, 200);
        return v.parse(entries, await response.json());
      }
      async function add(target: "left" | "right", text: string) {
        const response = await request("journal/add", { target, text });
        assert.equal(response.status, 200);
        return v.parse(v.object({ _id: v.string(), text: v.string() }), await response.json());
      }
      stage = "mount isolation and private calls";
      assert.equal((await add("left", "one")).text, "v1:one");
      assert.equal((await add("right", "two")).text, "right:two");
      assert.deepEqual(
        (await list("left")).map((row) => row.text),
        ["v1:one"],
      );
      assert.deepEqual(
        (await list("right")).map((row) => row.text),
        ["right:two"],
      );
      assert.deepEqual(await list("left", await issuer.token("other")), []);
      checks.push(
        "two-mount-data-isolation",
        "parent-exported-private-chain",
        "effect-promise-chain",
        "cross-owner-isolation",
      );
      for (const prefix of ["openapi", "rpc"])
        for (const path of [
          "left/internal/entries/insert",
          "internal/entries/insert",
          "components/left/internal/entries/insert",
        ]) {
          const denied = await request(path, { text: "forged" }, token, prefix);
          assert.equal(denied.status, 404);
          await denied.body?.cancel();
        }
      checks.push("private-http-and-openapi-denied");
      stage = "signed component HTTP";
      const project = await loadProject(root);
      const left = project.componentScopes.find((scope) => scope.mountPath === "left");
      assert(left);
      async function webhook(body: string, signature: string) {
        return fetch(new URL("/api/components/left/event", current.service), {
          method: "POST",
          body,
          headers: { signature, "content-type": "application/json" },
          signal: AbortSignal.timeout(20000),
        });
      }
      const body = JSON.stringify({ text: "signed" });
      const signature = createHmac("sha256", secret).update(body).digest("hex");
      assert.equal((await webhook(body, "invalid")).status, 401);
      assert.equal((await webhook(JSON.stringify({ text: "tampered" }), signature)).status, 401);
      const invalidBody = JSON.stringify({ text: 42 });
      assert.equal(
        (await webhook(invalidBody, createHmac("sha256", secret).update(invalidBody).digest("hex"))).status,
        400,
      );
      const table = `"${left.schema.metadata.namespace}"."entries"`;
      assert.equal(
        (await admin.query(`SELECT count(*)::int AS count FROM ${table} WHERE owner='webhook'`)).rows[0].count,
        0,
      );
      assert.equal((await webhook(body, signature)).status, 204);
      assert.equal(
        (await admin.query(`SELECT count(*)::int AS count FROM ${table} WHERE owner='webhook'`)).rows[0].count,
        1,
      );
      checks.push("signed-webhook", "invalid-signature-body-no-writes");
      stage = "native HTTP streaming and private denial";
      const client = createORPCClient<ClientTree>(
        new RPCLink({
          url: "/api/kello/rpc",
          origin: new URL(current.service).origin,
          headers: {
            authorization: `Bearer ${token}`,
            origin,
            "x-loom-protocol": "loom-orpc-2",
            "x-loom-version": current.version,
          },
        }),
      );
      await assert.rejects(
        client.left.internal.entries.insert({ text: "forged" }, { signal: AbortSignal.timeout(10000) }),
      );
      const stream = await client.journal.watch({ target: "left" }, { signal: AbortSignal.timeout(15000) });
      const iterator = stream[Symbol.asyncIterator]();
      const initial = await iterator.next();
      assert(!initial.done);
      assert(v.parse(entries, initial.value).some((row) => row.text === "v1:one"));
      assert((await iterator.next()).done, "Authored one-shot HTTP iterator must finalize");
      await add("left", "http-refresh");
      assert((await client.journal.list({ target: "left" })).some((row) => row.text === "v1:http-refresh"));
      checks.push("private-native-http-denied", "ordinary-component-iterator-finalized", "explicit-read-child-commit");
      stage = "additive schema and service upgrade";
      const schemaPath = join(root, "kello/components/journal/schema.ts");
      const originalSchema = await readFile(schemaPath, "utf8");
      const expandedSchema = originalSchema.replace("text: s.text()", "note: s.text(),\n      text: s.text()");
      await writeFile(schemaPath, expandedSchema);
      await generateRelease(root, "add_note");
      await writeFile(schemaPath, originalSchema);
      const compatible = await generateProject(root);
      assert.equal(compatible.version, current.version, "Migration artifacts must not change active source version");
      const scopes = await Promise.all(
        projectMigrationScopes(await loadProject(root)).map(async (scope) => {
          const history = await readMigrations(root, scope.migrations);
          const first = history[0];
          const last = history.at(-1);
          assert(first && last);
          return {
            ...scope,
            migrationHashes: history.map((entry) => entry.plan.hash),
            schema: { minimum: first.plan.after, maximum: last.plan.after, target: last.plan.after },
          };
        }),
      );
      const rootScope = scopes.find((scope) => !scope.mountPath);
      assert(rootScope);
      // Match the standard deployment's variable bindings exactly. Retained code
      // verifies the original function environment, including the set of keys.
      const variables = {
        [project.config.database.runtimeUrlEnv]: project.config.database.runtimeUrlEnv,
        ...project.config.deployment?.variables,
      };
      const declaration = {
        format: 1,
        releaseKey: createHash("sha256").update(crypto.randomUUID()).digest("hex"),
        version: current.version,
        deployment: "preview",
        environment: "preview",
        databaseName: decodeURIComponent(address.pathname.slice(1)),
        migrationRole: decodeURIComponent(new URL(connectionString).username),
        runtimeRole,
        quarantine: "preserve",
        reviewedHashes: [],
        migrationHashes: rootScope.migrationHashes,
        schema: rootScope.schema,
        componentScopes: scopes
          .filter((scope) => scope.mountPath)
          .map(({ mountPath, namespace, migrations, migrationHashes, schema }) => ({
            mountPath,
            namespace,
            migrations,
            migrationHashes,
            schema,
          })),
        slugs: { service: `s${current.version.slice(0, 19)}`, worker: `w${current.version.slice(0, 19)}` },
        activationTokenEnv: "LOOM_ACTIVATION_TOKEN",
        variables,
      };
      await writeFile(join(root, "compatible.json"), JSON.stringify(declaration));
      await declareProjectCompatibility(root, "compatible.json", provider);
      const beforeHistory = (
        await admin.query(
          "SELECT namespace,ordinal,name,hash FROM loom_meta.migration_history ORDER BY namespace,ordinal",
        )
      ).rows;
      await migrate();
      assert(
        (await client.journal.list({ target: "left" }, { signal: AbortSignal.timeout(15000) })).some(
          (row) => row.text === "v1:one",
        ),
      );
      checks.push("active-native-client-survives-compatible-schema-expansion");
      const previous = current;
      await writeFile(schemaPath, expandedSchema);
      await configureCloudComponents(root, "v2:");
      current = await deploy();
      assert.notEqual(current.version, previous.version);
      assert((await list("left")).some((row) => row.text === "v1:one"));
      assert.equal((await add("left", "new")).text, "v2:new");
      const stale = await request("journal/list", { target: "left" }, token, "openapi", previous.version);
      assert.equal(stale.status, 409);
      await stale.body?.cancel();
      checks.push("additive-schema-retains-data", "service-config-replacement", "stale-client-fails-closed");
      stage = "compatible retained-code rollback";
      await writeFile(schemaPath, originalSchema);
      await configureCloudComponents(root, "v1:");
      const rollback = {
        ...declaration,
        releaseKey: createHash("sha256").update(crypto.randomUUID()).digest("hex"),
        retainedReleaseKey: createHash("sha256").update(previous.version).update("preview").digest("hex"),
      };
      await writeFile(join(root, "rollback.json"), JSON.stringify(rollback));
      current = await deploy("rollback.json");
      assert.equal(current.version, previous.version);
      assert.equal((await add("left", "rollback")).text, "v1:rollback");
      assert((await list("left")).some((row) => row.text === "v2:new"));
      assert.deepEqual(
        (await list("right")).map((row) => row.text),
        ["right:two"],
      );
      const afterHistory = (
        await admin.query(
          "SELECT namespace,ordinal,name,hash FROM loom_meta.migration_history ORDER BY namespace,ordinal",
        )
      ).rows;
      assert(afterHistory.length > beforeHistory.length);
      for (const row of beforeHistory)
        assert(afterHistory.some((candidate) => JSON.stringify(candidate) === JSON.stringify(row)));
      checks.push("compatible-retained-code-rollback", "migration-history-retained", "independent-mount-retained");
      if (process.env.LOOM_CLOUD_RECEIPT)
        await writeFile(
          process.env.LOOM_CLOUD_RECEIPT,
          JSON.stringify(
            {
              projectId,
              branchId,
              passed: true,
              checks,
              releases,
              serviceUrl: current.service,
              fixtureRoot: process.env.LOOM_CLOUD_KEEP_FIXTURE === "1" ? root : undefined,
              completedAt: new Date().toISOString(),
            },
            null,
            2,
          ),
        );
    } catch (cause) {
      const providerStatus = v.safeParse(
        v.object({
          details: v.object({ status: v.pipe(v.number(), v.integer(), v.minValue(100), v.maxValue(599)) }),
        }),
        cause,
      );
      const credentialCode = v.safeParse(
        v.object({
          code: v.picklist([
            "NEON_SESSION_REVOKED",
            "NEON_PERMISSION_DENIED",
            "NEON_LOGIN_REQUIRED",
            "NEON_REFRESH_FAILED",
            "NEON_CREDENTIAL_UNAVAILABLE",
          ]),
        }),
        cause,
      );
      if (process.env.LOOM_CLOUD_RECEIPT)
        await writeFile(
          process.env.LOOM_CLOUD_RECEIPT,
          JSON.stringify(
            {
              projectId,
              branchId,
              passed: false,
              stage,
              fixtureRoot: process.env.LOOM_CLOUD_KEEP_FIXTURE === "1" ? root : undefined,
              checks,
              releases,
              error: cause instanceof Error ? cause.name : "UnknownError",
              submissionFailure,
              status: providerStatus.success ? providerStatus.output.details.status : undefined,
              errorCode: credentialCode.success ? credentialCode.output.code : undefined,
              frames:
                cause instanceof Error
                  ? cause.stack
                      ?.split("\n")
                      .filter((line) => /^\s+at .*:\d+:\d+\)?$/.test(line))
                      .slice(0, 5)
                  : [],
            },
            null,
            2,
          ),
        );
      throw new Error(`Component cloud acceptance failed during ${stage}; disposable branch retained`);
    } finally {
      for (const [key, value] of Object.entries({
        SIGNING_SECRET: oldEnvironment.secret,
        LOOM_DATABASE_URL: oldEnvironment.database,
        LOOM_ACTIVATION_TOKEN: oldEnvironment.activation,
      })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await admin.end();
      if (process.env.LOOM_CLOUD_KEEP_FIXTURE !== "1") await rm(root, { recursive: true, force: true });
    }
  },
  900000,
);
