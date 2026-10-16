/** Explicit, disposable-provider acceptance fixture. Never runs during offline tests. */
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { sql } from "drizzle-orm";
import {
  bindRpcDatabaseProcedure,
  connectDatabase,
  prepareApplicationEnvironment,
  createJwtVerifier,
  runNeonMutation,
} from "kello/server";
import { createRpcHttpApp } from "kello/neon";
import { initializeProject, generateProject, loadProject, createKelloNeonApi } from "kello/tooling";
import { createKelloNeonClient } from "../../../apps/kello/src/tooling/neon/api";
import * as v from "valibot";

const projectId = "late-moon-69483649";
const branchId = "br-dark-block-awbbt60w";
const endpointId = "ep-solitary-block-awijudvn";
const run = crypto.randomUUID();
const namespace = `live_${run.replaceAll("-", "")}`;
const metadataNamespace = `loom_${namespace}`;
const root = await mkdtemp(join(tmpdir(), "loom-live-neon-"));
const report = {
  run,
  namespace,
  admission: false,
  issuance: 0,
  status: "starting",
  schemaDropped: false,
  poolClosed: false,
};
const reportFile = `/private/tmp/loom-live-functions-${run}.json`;
let connection: Awaited<ReturnType<typeof connectDatabase>> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let allocated = false;
let stage = "admission";
let finish = () => {};
const finished = new Promise<void>((resolve) => {
  finish = resolve;
});
try {
  const api = createKelloNeonApi();
  const control = createKelloNeonClient();
  const [project, branches, endpoint, realtime, databases] = await Promise.all([
    api.getProject(projectId),
    api.listBranches(projectId),
    control.postgres.endpoints.get({ projectId, endpointId }),
    control.realtime.get({ projectId, branchId }),
    control.postgres.databases.list({ projectId, branchId }),
  ]);
  const branch = branches.find((entry) => entry.id === branchId);
  const database = databases.find((entry) => entry.name === "neondb");
  assert(project.pgVersion === 18 && branch && !branch.isDefault && !branch.protected);
  assert.equal(branch.name, "loom-acceptance-kello-002-optimistic-20261007");
  assert(
    endpoint.branch_id === branchId && realtime.enabled && !realtime.pending && realtime.invocation_url && database,
  );
  report.admission = true;
  const uri = await control.postgres.connectionString({
    projectId,
    branchId,
    endpointId,
    databaseName: database.name,
    roleName: database.owner_name,
    pooled: false,
  });
  const secret = await control.realtime.secret({ projectId, branchId });
  assert(!secret.pending);

  stage = "generation";
  await initializeProject(root, "live-neon-acceptance");
  await symlink(
    await realpath(fileURLToPath(new URL("../../tests/node_modules", import.meta.url))),
    join(root, "node_modules"),
  );
  await writeFile(
    join(root, "kello.config.ts"),
    `export default {project:"live-neon-acceptance",database:{namespace:${JSON.stringify(namespace)}}};`,
  );
  await writeFile(
    join(root, "kello/schema.ts"),
    `import {defineSchema,defineTable} from "kello/server";
export default defineSchema(s=>({tasks:defineTable({title:s.text().notNull(),tenant:s.text().notNull()})}),{namespace:${JSON.stringify(namespace)}});`,
  );
  await writeFile(
    join(root, "kello/app.config.ts"),
    `import {defineApplication} from "kello/server";
import * as v from "valibot";
export default defineApplication({env:{SECRET:v.string()},liveQueries:({env})=>({secret:env.SECRET,database:"neondb",deployment:${JSON.stringify(run)},resolveLogin:async()=>undefined}),rpc:({os})=>({os})});`,
  );
  await writeFile(
    join(root, "kello/contracts/tasks.ts"),
    `import {oc,defineContract} from "kello/contract";
import * as v from "valibot";
export default defineContract({list:oc.input(v.strictObject({limit:v.pipe(v.number(),v.integer(),v.minValue(1),v.maxValue(10)),after:v.optional(v.string())})).output(v.array(v.strictObject({id:v.string(),title:v.string()}))).live()});`,
  );
  await writeFile(
    join(root, "kello/functions/tasks.ts"),
    `import {os} from "../_generated/rpc";
import {and,eq,gt,sql} from "drizzle-orm";
export default os.tasks.router({list:os.tasks.list.use(async({context,next,errors})=>{
 if(!context.identity) throw errors.UNAUTHORIZED();
 const member=await context.db.execute(sql\`SELECT 1 FROM \${sql.identifier(${JSON.stringify(namespace)})}.members WHERE subject=\${context.identity.subject} AND tenant=\${context.identity.tenantId}\`);
 if(!member.rows.length) throw errors.FORBIDDEN();
 return next();
}).live(({context,input})=>context.db.select({id:sql<string>\`\${context.tables.tasks._id}\`.as("id"),title:context.tables.tasks.title}).from(context.tables.tasks).where(and(eq(context.tables.tasks.tenant,context.identity!.tenantId!),input.after?gt(context.tables.tasks.title,input.after):undefined,sql\`EXISTS(SELECT 1 FROM \${sql.identifier(${JSON.stringify(namespace)})}.members WHERE subject=\${context.identity!.subject} AND tenant=\${context.tables.tasks.tenant})\`)).orderBy(context.tables.tasks.title).limit(input.limit))});`,
  );
  await generateProject(root);
  const loaded = await loadProject(root);
  stage = "database";
  connection = await connectDatabase({
    schema: loaded.schema,
    relations: loaded.relations,
    connectionString: uri,
    maxConnections: 3,
  });
  const db = connection.db;
  const target = await db.execute<{ database: string; version: string }>(
    sql`SELECT current_database() AS database,current_setting('server_version_num') AS version`,
  );
  assert.equal(target.rows[0]?.database, "neondb");
  assert.equal(Math.floor(Number(target.rows[0]?.version) / 10000), 18);
  await db.execute(sql`CREATE SCHEMA ${sql.identifier(namespace)}`);
  allocated = true;
  await db.execute(
    sql`CREATE TABLE ${sql.identifier(namespace)}.tasks("_id" uuid PRIMARY KEY DEFAULT uuidv7(),"_createdAt" bigint DEFAULT 0,title text NOT NULL,tenant text NOT NULL)`,
  );
  await db.execute(sql`CREATE TABLE ${sql.identifier(namespace)}.members(subject text NOT NULL,tenant text NOT NULL)`);
  await db.execute(sql`CREATE SCHEMA ${sql.identifier(metadataNamespace)}`);
  await db.execute(
    sql`CREATE TABLE ${sql.identifier(metadataNamespace)}.mutation_results(scope_hash text NOT NULL,key_hash text NOT NULL,fingerprint text NOT NULL,result jsonb NOT NULL,expires_at timestamptz NOT NULL,PRIMARY KEY(scope_hash,key_hash))`,
  );
  await db.execute(
    sql`INSERT INTO ${sql.identifier(namespace)}.tasks(title,tenant) VALUES ('alpha','A'),('beta','A'),('private','B')`,
  );
  await db.execute(sql`INSERT INTO ${sql.identifier(namespace)}.members VALUES ('alice','A')`);
  stage = "auth";
  const identity = { issuer: "https://live-acceptance.invalid", subject: "alice", tenantId: "A" };
  const expiresAt = Math.floor(Date.now() / 1000) + 600;
  const login = { ...identity, id: run, expiresAt };
  const keys = await generateKeyPair("ES256");
  const token = await new SignJWT({ tenant: "A" })
    .setProtectedHeader({ alg: "ES256" })
    .setIssuer(identity.issuer)
    .setSubject(identity.subject)
    .setExpirationTime(expiresAt)
    .sign(keys.privateKey);
  const loginStore = new Map([[token, login]]);
  const verify = createJwtVerifier([
    {
      issuer: identity.issuer,
      tenantClaim: "tenant",
      keys: { type: "local", jwks: { keys: [await exportJWK(keys.publicKey)] } },
    },
  ]);
  stage = "application";
  const prepared = await prepareApplicationEnvironment(loaded.application, { SECRET: secret.secret });
  assert(prepared.liveQueries);
  stage = "procedure";
  const leaf = loaded.procedures.find((entry) => entry.path.join(".") === "tasks.list");
  assert(leaf);
  const list = bindRpcDatabaseProcedure(leaf.definition, {
    connection,
    replay: { metadataNamespace, deployment: run },
    authorize: async () => {},
  });
  let unavailable = false;
  const browserSource = fileURLToPath(new URL("./live-functions-neon.tsx", import.meta.url));
  stage = "browser-build";
  const built = await Bun.build({
    entrypoints: [browserSource],
    target: "browser",
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [
      {
        name: "generated-live-client",
        setup(build) {
          build.onResolve({ filter: /^acceptance-generated-react$/ }, () => ({
            path: join(root, "kello/_generated/react.js"),
          }));
        },
      },
    ],
  });
  assert(built.success, "Browser bundle failed");
  const bundle = await built.outputs[0]!.text();
  let app: ReturnType<typeof createRpcHttpApp>;
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/")
        return new Response(
          '<!doctype html><meta charset="utf-8"><title>Generated live functions</title><div id="root"></div><script type="module" src="/app.js"></script>',
          { headers: { "content-type": "text/html" } },
        );
      if (path === "/app.js") return new Response(bundle, { headers: { "content-type": "application/javascript" } });
      if (path === "/bootstrap") return Response.json({ token, url: realtime.invocation_url });
      if (path === "/state") return Response.json({ issuance: report.issuance });
      if (request.method === "POST" && path === "/finish") {
        finish();
        return new Response("closed");
      }
      if (request.method === "POST" && path === "/outage") {
        unavailable = !unavailable;
        return Response.json({ unavailable });
      }
      if (request.method === "POST" && path === "/update") {
        const input = v.parse(v.strictObject({ title: v.string() }), await request.json());
        const result = await runNeonMutation({
          ...prepared.liveQueries!,
          connection: connection!,
          metadataNamespace,
          operation: "acceptance.update.v1",
          idempotencyKey: crypto.randomUUID(),
          input,
          authority: { identity, sessionId: login.id, expiresAt, signal: request.signal },
          output: v.strictObject({ title: v.string() }),
          authorize: async () => {},
          execute: async (tx) => {
            await tx.execute(
              sql`UPDATE ${sql.identifier(namespace)}.tasks SET title=${input.title} WHERE title='alpha' AND tenant='A'`,
            );
            return { kind: "write", value: input };
          },
        });
        return Response.json(result);
      }
      if (path.startsWith("/api/kello/rpc")) {
        if (unavailable) return new Response("Unavailable", { status: 503 });
        report.issuance++;
      }
      return prepared.run(() => app.fetch(request));
    },
  });
  app = createRpcHttpApp({
    router: { tasks: { list } },
    version: loaded.version,
    origins: [`http://127.0.0.1:${server.port}`],
    verify,
    resolveLogin: async ({ credential }) => loginStore.get(credential),
    liveQueries: prepared.liveQueries,
  });
  report.status = "ready";
  await writeFile(reportFile, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ status: "READY", port: server.port, run, reportFile }));
  const timeout = setTimeout(finish, 240_000);
  await finished;
  clearTimeout(timeout);
  report.status = "closed";
} catch (cause) {
  report.status = "failed";
  // Fixed categories only: provider or SQL exceptions may contain credentials.
  console.error(
    JSON.stringify({
      status: "FAIL",
      stage,
      category:
        cause instanceof Error &&
        [
          "Database policy required",
          "Expected a project-bound procedure",
          "Invalid idempotency configuration",
          "Browser bundle failed",
        ].includes(cause.message)
          ? cause.message
          : "UNCLASSIFIED",
      errorClass: cause instanceof Error ? cause.name : "Unknown",
    }),
  );
  process.exitCode = 1;
} finally {
  if (server) await server.stop();
  if (connection) {
    try {
      if (allocated) {
        await connection.db.execute(sql`DROP SCHEMA ${sql.identifier(metadataNamespace)} CASCADE`);
        await connection.db.execute(sql`DROP SCHEMA ${sql.identifier(namespace)} CASCADE`);
        report.schemaDropped = true;
      }
    } finally {
      await connection.close();
      report.poolClosed = true;
    }
  }
  await rm(root, { recursive: true, force: true });
  await writeFile(reportFile, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report));
}
