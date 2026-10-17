import { startHttpHandlerServer } from "./http-handler-server";
import { fileURLToPath } from "node:url";
import { projectRuntimeGraph, applyMigrations, loadProject, projectMigrationScopes } from "kello/tooling";
import { createJwtVerifier, createRpcRuntime, defineRpcAuth } from "kello/server";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import pg from "pg";

/** Test-only identity issuer and disposable PostgreSQL database. Apps themselves
 * use the same generated clients and deployment config with real Neon. */
export async function startIntegrationBackend(
  connectionString: string,
  origins: string[],
  example: "integrations" | "next" | "start" | "components" = "integrations",
) {
  const root = fileURLToPath(new URL(`../../examples/${example}/`, import.meta.url));
  const address = new URL(connectionString);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(address.hostname)) throw new Error("Local test database required");
  const project = await loadProject(root);
  if (project.protocol !== "loom-orpc-2") throw new Error("Expected native contracts");
  const database = `loom_integrations_${crypto.randomUUID().replaceAll("-", "")}`;
  const role = `${database}_runtime`;
  const admin = new pg.Client({ connectionString });
  await admin.connect();
  let backend: Awaited<ReturnType<typeof startHttpHandlerServer>> | undefined;
  let runtime: Awaited<ReturnType<typeof createRpcRuntime>> | undefined;
  async function stop() {
    try {
      if (backend) await backend.stop();
      else await runtime?.stop();
    } finally {
      try {
        await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
        await admin.query(`DROP ROLE IF EXISTS "${role}"`);
      } finally {
        await admin.end();
      }
    }
  }
  try {
    await admin.query(`CREATE DATABASE "${database}"`);
    address.pathname = `/${database}`;
    for (const scope of projectMigrationScopes(project))
      await applyMigrations({
        connectionString: address.href,
        root,
        migrations: scope.migrations,
        namespace: scope.namespace,
        metadataNamespace: project.config.database.metadataNamespace,
        runtimeRole: role,
      });
    const password = crypto.randomUUID();
    await admin.query(`ALTER ROLE "${role}" LOGIN PASSWORD '${password}'`);
    address.username = role;
    address.password = password;
    const keys = await generateKeyPair("ES256");
    const issuer = "https://integration.loom.test";
    const verify = createJwtVerifier([
      { issuer, keys: { type: "local", jwks: { keys: [await exportJWK(keys.publicKey)] } } },
    ]);
    runtime = await createRpcRuntime({
      application: project.application,
      schema: project.schema,
      relations: project.relations,
      version: project.version,
      connectionString: address.href,
      metadataNamespace: project.config.database.metadataNamespace,
      deployment: "integration-examples",
      ...projectRuntimeGraph(project),
      // Keep application authorization while this local fixture supplies its own JWT issuer.
      auth: defineRpcAuth({ authorize: project.auth.authorize, allowAnonymous: project.auth.allowAnonymous }),
      config: { auth: { origins } },
      assertActive: async (signal) => signal.throwIfAborted(),
    });
    backend = await startHttpHandlerServer({ ...runtime, auth: { ...runtime.auth, verify } });
    return {
      version: project.version,
      url: backend.url.origin,
      stop,
      token: (subject: string) =>
        new SignJWT({})
          .setProtectedHeader({ alg: "ES256" })
          .setIssuer(issuer)
          .setSubject(subject)
          .setIssuedAt()
          .setExpirationTime("1h")
          .sign(keys.privateKey),
    };
  } catch (cause) {
    await stop();
    throw cause;
  }
}
