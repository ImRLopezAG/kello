import { startHttpHandlerServer } from "./http-handler-server";
import { startTestNeonAuth } from "./neon-auth";
import { buildAcceptanceFrontend } from "./build-example";
import { fileURLToPath } from "node:url";
import { projectRuntimeGraph, applyMigrations, generateProject, loadProject } from "kello/tooling";
import { createJwtVerifier, createRpcRuntime, defineRpcAuth } from "kello/server";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import pg from "pg";
import * as v from "valibot";

const exampleRoot = fileURLToPath(new URL("../../examples/tasks/", import.meta.url));
const issuer = "https://tasks.loom.localhost";
const sessionInput = v.strictObject({ subject: v.picklist(["alice", "bob"]) });

/** Disposable, loopback-only demonstration. Production uses a configured trusted identity provider. */
export async function startLocalTasks(options: {
  connectionString: string;
  port?: number;
  root?: string;
  tooling?: Pick<
    typeof import("kello/tooling"),
    "projectRuntimeGraph" | "applyMigrations" | "generateProject" | "loadProject"
  >;
  core?: Pick<typeof import("kello/server"), "createJwtVerifier" | "createRpcRuntime" | "defineRpcAuth">;
}) {
  const tooling = options.tooling ?? {
    projectRuntimeGraph,
    applyMigrations,
    generateProject,
    loadProject,
  };
  const core = options.core ?? { createJwtVerifier, createRpcRuntime, defineRpcAuth };
  const root = options.root ?? exampleRoot;
  const address = new URL(options.connectionString);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(address.hostname))
    throw new Error("The example launcher requires local PostgreSQL");
  const project = await tooling.loadProject(root);
  if (project.protocol !== "loom-orpc-2") throw new Error("Expected native fixture");
  await tooling.generateProject(root);
  let frontendDirectory = "";
  let auth: Awaited<ReturnType<typeof startTestNeonAuth>> | undefined;
  const database = `loom_tasks_${crypto.randomUUID().replaceAll("-", "")}`;
  const runtimeRole = `${database}_runtime`;
  const admin = new pg.Client({ connectionString: options.connectionString });
  await admin.connect();
  let backend: Awaited<ReturnType<typeof startHttpHandlerServer>> | undefined;
  let frontend: ReturnType<typeof Bun.serve> | undefined;
  let stopped = false;
  let stopping: Promise<void> | undefined;
  const stop = () => {
    stopping ??= (async () => {
      stopped = true;
      try {
        await frontend?.stop(true);
        await auth?.stop();
        await backend?.stop();
      } finally {
        try {
          await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
          await admin.query(`DROP ROLE IF EXISTS "${runtimeRole}"`);
        } finally {
          await admin.end();
        }
      }
    })();
    return stopping;
  };
  try {
    await admin.query(`CREATE DATABASE "${database}"`);
    address.pathname = `/${database}`;
    await tooling.applyMigrations({
      connectionString: address.href,
      root,
      migrations: project.config.database.migrations,
      namespace: project.config.database.namespace,
      metadataNamespace: project.config.database.metadataNamespace,
      runtimeRole,
    });
    const password = crypto.randomUUID();
    await admin.query(`ALTER ROLE "${runtimeRole}" LOGIN PASSWORD '${password}'`);
    address.username = runtimeRole;
    address.password = password;
    const keys = await generateKeyPair("ES256");
    const publicKey = await exportJWK(keys.publicKey);
    const verify = core.createJwtVerifier([
      { issuer, audience: "loom-tasks", keys: { type: "local", jwks: { keys: [publicKey] } } },
    ]);
    frontend = Bun.serve({
      hostname: "127.0.0.1",
      port: options.port ?? 5173,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/session") {
          if (request.method !== "POST" || request.headers.get("origin") !== frontend?.url.origin)
            return new Response(null, { status: 403 });
          const input = v.safeParse(sessionInput, await request.json().catch(() => null));
          if (!input.success) return new Response(null, { status: 400 });
          if (!backend) return new Response(null, { status: 503 });
          const token = await new SignJWT({})
            .setProtectedHeader({ alg: "ES256" })
            .setIssuer(issuer)
            .setAudience("loom-tasks")
            .setSubject(input.output.subject)
            .setIssuedAt()
            .setExpirationTime("1h")
            .sign(keys.privateKey);
          return Response.json(
            {
              token,
              issuer,
              version: project.version,
              identityKey: input.output.subject,
              url: backend.url.origin,
              deployment: "local-tasks",
            },
            { headers: { "cache-control": "no-store" } },
          );
        }
        if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405 });
        if (url.pathname === "/") return new Response(Bun.file(`${frontendDirectory}/index.html`));
        if (/^\/assets\/[a-zA-Z0-9_.-]+$/.test(url.pathname))
          return new Response(Bun.file(`${frontendDirectory}${url.pathname}`));
        return new Response("Not found", { status: 404 });
      },
    });
    const runtime = await core.createRpcRuntime({
      application: project.application,
      schema: project.schema,
      relations: project.relations,
      version: project.version,
      branchId: "br-local-tasks",
      environment: { LOOM_SEARCH_CURSOR_KEY: "0a".repeat(32) },
      connectionString: address.href,
      metadataNamespace: project.config.database.metadataNamespace,
      deployment: "local-tasks",
      ...tooling.projectRuntimeGraph(project),
      auth: core.defineRpcAuth({ authorize: project.auth.authorize, allowAnonymous: project.auth.allowAnonymous }),
      config: { auth: { origins: [frontend.url.origin] }, realtime: { pollIntervalMs: 100 } },
      assertActive: async (signal) => {
        signal.throwIfAborted();
        if (stopped) throw new Error("Local example stopped");
      },
    });
    backend = await startHttpHandlerServer({ ...runtime, auth: { ...runtime.auth, verify } });
    auth = await startTestNeonAuth({
      origins: [frontend.url.origin],
      backendUrl: backend.url.origin,
      token: (subject) =>
        new SignJWT({})
          .setProtectedHeader({ alg: "ES256" })
          .setIssuer(issuer)
          .setAudience("loom-tasks")
          .setSubject(subject)
          .setIssuedAt()
          .setExpirationTime("1h")
          .sign(keys.privateKey),
    });
    frontendDirectory = await buildAcceptanceFrontend(root, { authUrl: auth.baseUrl, serviceUrl: auth.origin });
    return { url: frontend.url.href, database, stop };
  } catch (cause) {
    await stop();
    throw cause;
  }
}
