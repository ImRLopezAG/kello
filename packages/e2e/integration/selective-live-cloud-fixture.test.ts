import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";
import { prepareCloudSearch } from "../fixtures/cloud-search";

// A separate consumer process isolates the fixture's process-wide diagnostic
// subscription from other integration runtimes. Every runtime/schema/procedure
// import resolves the SAME packed public package (including its WeakMaps/ALS).
// This is local fixture proof, never hosted acceptance.
for (const mode of ["polling", "notify"] as const) {
  test(`packed hosted search fixture: PG18 native selective invalidation (${mode})`, async () => {
    const connectionString = process.env.LOOM_TEST_DATABASE_URL;
    assert(connectionString, "LOOM_TEST_DATABASE_URL must name an owned local PG18 database");
    const address = new URL(connectionString);
    assert(["127.0.0.1", "localhost", "[::1]"].includes(address.hostname), "Local PostgreSQL only");
    const root = await mkdtemp(join(tmpdir(), "kello-selective-cloud-local-"));
    try {
      const suffix = crypto.randomUUID().replaceAll("-", "");
      const namespace = `search_${suffix}`;
      const metadataNamespace = `loom_meta_${suffix}`;
      await prepareCloudSearch(root, namespace);
      for (const name of ["pg", "jose"])
        await symlink(
          fileURLToPath(new URL(`../node_modules/${name}`, import.meta.url)),
          join(root, "node_modules", name),
        );
      await writeFile(
        join(root, "kello.config.ts"),
        `import { defineConfig } from "kello/tooling"; export default defineConfig(${JSON.stringify({
          project: "local-selective-fixture",
          database: { namespace, metadataNamespace },
        })});`,
      );
      await writeFile(join(root, "proof.mjs"), consumerProof);
      const child = Bun.spawn(["bun", "proof.mjs", mode], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
        timeout: 120_000,
        env: { ...process.env, LOOM_TEST_DATABASE_URL: connectionString },
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      assert.equal(code, 0, `Packed local fixture proof failed\n${stdout}${stderr}`);
      console.info(stdout.trim());
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 150_000);
}

// No source-runtime imports, synthetic metrics, or time-based absence checks.
// Deadlines bound failed event delivery; successful absence evidence comes from
// the authored barrier after real ALL revision reads and drained worker queues.
const consumerProof = String.raw`
import assert from "node:assert/strict";
import pg from "pg";
import * as v from "valibot";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import * as tooling from "kello/tooling";
import * as core from "kello/server";

async function bounded(promise) {
 let timer;
 try { return await Promise.race([promise, new Promise((_, reject) => {
  timer = setTimeout(() => reject(new Error("Native fixture event deadline")), 30000);
 })]); } finally { clearTimeout(timer); }
}
function observe(stream) {
 const values = [], waiters = [], errors = [];
 let deliveries = 0, failure;
 const pumping = (async () => {
  try {
   for await (const value of stream) {
    deliveries++;
    const waiter = waiters.shift();
    if (waiter) waiter.resolve(value); else values.push(value);
   }
   failure = new Error("STREAM_ENDED");
  } catch (error) { failure = error; }
  for (const waiter of waiters.splice(0)) waiter.reject(failure);
  for (const resolve of errors.splice(0)) resolve(failure);
 })();
 return {
  stream, pumping, deliveries: () => deliveries,
  next() {
   if (values.length) return Promise.resolve(values.shift());
   if (failure) return Promise.reject(failure);
   return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
  },
  error() {
   assert.equal(values.length, 0, "Unexpected buffered application value");
   if (failure) return Promise.resolve(failure);
   return new Promise(resolve => errors.push(resolve));
  },
 };
}
const admin = new pg.Client({ connectionString: process.env.LOOM_TEST_DATABASE_URL });
// Bun supplies no browser Origin by default. Adapt headers only; tickets,
// websocket frames, serializers, generated client and server stay native.
const origin = "http://127.0.0.1:5173";
const nativeFetch = globalThis.fetch, NativeWebSocket = globalThis.WebSocket;
let sockets = 0;
globalThis.fetch = (url, options) => {
 const headers = new Headers(options?.headers); headers.set("origin", origin);
 return nativeFetch(url, { ...options, headers });
};
globalThis.WebSocket = class extends NativeWebSocket {
 constructor(url, protocols) { super(url, { protocols, headers: { origin } }); sockets++; }
};
let backend, runtime, connection, role, namespace, metadataNamespace;
const peers = {};
const names = ["watch", "broadWatch", "policyWatch"];
try {
 await admin.connect();
 const version = (await admin.query("SHOW server_version")).rows[0].server_version;
 const versionNumber = Number((await admin.query("SHOW server_version_num")).rows[0].server_version_num);
 assert.equal(Math.floor(versionNumber / 10000), 18, "Requires PostgreSQL major 18");
 await tooling.generateRelease(process.cwd(), "initial");
 await tooling.generateProject(process.cwd());
 const project = await tooling.loadProject(process.cwd());
 assert.deepEqual(project.auth.dependencies, ["permissions"], "Keep the generated authorization declaration");
 ({ namespace, metadataNamespace } = project.config.database);
 role = "runtime_" + crypto.randomUUID().replaceAll("-", "");
 await tooling.applyMigrations({ root: process.cwd(), connectionString: process.env.LOOM_TEST_DATABASE_URL,
  migrations: project.config.database.migrations, namespace, metadataNamespace, runtimeRole: role });
 const password = crypto.randomUUID();
 await admin.query('ALTER ROLE "' + role + '" LOGIN PASSWORD ' + "'" + password + "'");
 const address = new URL(process.env.LOOM_TEST_DATABASE_URL);
 address.username = role; address.password = password;
 await admin.query('INSERT INTO "' + namespace + '".permissions(subject,allowed) VALUES (\'alice\',true)');
 await admin.query('INSERT INTO "' + namespace + '".declared_policy_permissions(subject,allowed) VALUES (\'alice\',true)');
 await admin.query('INSERT INTO "' + namespace + '".unrelated(title) VALUES (\'before\')');
 await admin.query('INSERT INTO "' + namespace + '".tasks(owner,title,done,at,count,amount) VALUES (\'alice\',\'A\',false,\'2026-01-01\',1,\'1\')');
 const keys = await generateKeyPair("ES256");
 const verify = core.createJwtVerifier([{ issuer: "https://local-fixture.invalid", audience: "local-fixture",
  keys: { type: "local", jwks: { keys: [await exportJWK(keys.publicKey)] } } }]);
 let verifications = 0;
 runtime = await core.createRpcRuntime({
  application: project.application, schema: project.schema, relations: project.relations,
  version: project.version, branchId: "br-local-fixture", deployment: "local-fixture",
  connectionString: address.href, directConnectionString: address.href, metadataNamespace,
  environment: { LOOM_SEARCH_CURSOR_KEY: "0a".repeat(32) },
  ...tooling.projectRuntimeGraph(project),
  // Preserve the generated declaration object rather than rebuilding its authorize function.
  auth: project.auth,
  config: { auth: { origins: [origin] }, realtime: { mode: process.argv[2], pollIntervalMs: 100 } },
  assertActive: async signal => signal.throwIfAborted(),
 });
 backend = await tooling.startDevelopmentServer({ ...runtime, auth: { ...runtime.auth,
  verify: async (...args) => { verifications++; return verify(...args); },
 } }, { port: 0 });
 const token = await new SignJWT({}).setProtectedHeader({ alg: "ES256" })
  .setIssuer("https://local-fixture.invalid").setAudience("local-fixture").setSubject("alice")
  .setIssuedAt().setExpirationTime("5m").sign(keys.privateKey);
 const { createClient } = await import("./kello/_generated/api.js");
 const { readoutSchema } = await import("./kello/acceptance-metrics-schema.ts");
 connection = createClient({ url: backend.url.origin, getToken: async () => token });
 const tasks = connection.client.tasks;
 const windowSchema = v.strictObject({ pages: v.array(v.array(v.strictObject({ title: v.string() }))),
  nextCursor: v.nullable(v.string()), previousCursor: v.nullable(v.string()), count: v.string() });
 const input = { columns: { title: true }, limit: 10, loadedPages: 1, count: true };
 const deliveries = () => Object.fromEntries(names.map(name => [name, peers[name].deliveries()]));
 let instance;
 async function metrics() {
  const value = v.parse(readoutSchema, await bounded(tasks.metrics()));
  instance ??= value.instance;
  assert.equal(value.instance, instance, "Same peer instance UUID");
  assert.equal(verifications, 1, "Native peer must not reconnect or obtain another ticket");
  assert.equal(sockets, 1, "Exactly one native websocket throughout proof");
  return value;
 }
 async function barrier(marker) {
  const value = v.parse(readoutSchema, await bounded(tasks.barrier({ instance: marker.instance,
   after: marker.completedPolls, expectedSubscriptions: 3 })));
  assert.equal(value.instance, instance);
  assert.equal(value.subscriptions, 3);
  assert.equal(value.evaluating, 0); assert.equal(value.queued, 0);
  assert(value.completedPolls >= marker.completedPolls + 2, "Two completed ALL cycles");
  assert.equal(verifications, 1);
  return value;
 }
 // Opening an iterator runs its query setup; it must not increment authored live counts.
 for (const name of names) peers[name] = observe(await bounded(tasks[name](input)));
 const initial = await Promise.all(names.map(async name => v.parse(windowSchema, await bounded(peers[name].next()))));
 const expected = { pages: [[{ title: "A" }]], nextCursor: null, previousCursor: null, count: "1" };
 for (const value of initial) assert.deepEqual(value, expected);
 await barrier(await metrics());
 const before = await metrics();
 assert.deepEqual(before.evaluations, { watch: 1, broadWatch: 1, policyWatch: 1 }, "Setup excluded from actual generated live counters");
 assert.equal(before.subscriptions, 3);
 console.info(JSON.stringify({ stage: "native-initial-completed-barrier", postgres: version,
  mode: process.argv[2], sockets, verifications, metrics: before, hostedAcceptance: false }));
 await assert.rejects(bounded(tasks.barrier({ instance: crypto.randomUUID(), after: before.completedPolls,
  expectedSubscriptions: 3 })), error => error.code === "INTERNAL_SERVER_ERROR");
 const beforeDeliveries = deliveries();
 await admin.query('UPDATE "' + namespace + '".unrelated SET title=\'after\'');
 const afterUnrelated = await barrier(await metrics());
 assert.deepEqual(afterUnrelated.evaluations, { watch: before.evaluations.watch,
  policyWatch: before.evaluations.policyWatch, broadWatch: before.evaluations.broadWatch + 1 });
 assert.deepEqual(v.parse(windowSchema, await bounded(peers.broadWatch.next())), expected);
 assert.deepEqual(deliveries(), { ...beforeDeliveries, broadWatch: beforeDeliveries.broadWatch + 1 });
 const policyBefore = await metrics(), policyDeliveries = deliveries();
 await admin.query('UPDATE "' + namespace + '".declared_policy_permissions SET allowed=false WHERE subject=\'alice\'');
 const policyAfter = await barrier(await metrics());
 assert.deepEqual(policyAfter.evaluations, { watch: policyBefore.evaluations.watch,
  policyWatch: policyBefore.evaluations.policyWatch + 1, broadWatch: policyBefore.evaluations.broadWatch + 1 });
 assert.deepEqual(v.parse(windowSchema, await bounded(peers.policyWatch.next())),
  { pages: [], nextCursor: null, previousCursor: null, count: "0" });
 assert.deepEqual(v.parse(windowSchema, await bounded(peers.broadWatch.next())), expected);
 assert.deepEqual(deliveries(), { watch: policyDeliveries.watch, broadWatch: policyDeliveries.broadWatch + 1,
  policyWatch: policyDeliveries.policyWatch + 1 });
 // Request a future cumulative marker, then revoke the subscriptions. The
 // barrier must deny the changed subscription set on this same native peer.
 const revocationBefore = await metrics(), revocationDeliveries = deliveries();
 const deniedBarrier = assert.rejects(bounded(tasks.barrier({ instance,
  after: revocationBefore.completedPolls + 1000, expectedSubscriptions: 3 })),
  error => error.code === "INTERNAL_SERVER_ERROR");
 await admin.query('UPDATE "' + namespace + '".permissions SET allowed=false WHERE subject=\'alice\'');
 for (const peer of Object.values(peers)) assert.equal((await bounded(peer.error())).code, "FORBIDDEN");
 await deniedBarrier;
 const revoked = await metrics();
 assert.deepEqual(revoked.evaluations, revocationBefore.evaluations, "Auth fails before authored handlers");
 assert.equal(revoked.subscriptions, 0);
 assert.deepEqual(deliveries(), revocationDeliveries, "Revocation publishes no new application value");
 await assert.rejects(bounded(tasks.barrier({ instance, after: revoked.completedPolls, expectedSubscriptions: 3 })),
  error => error.code === "INTERNAL_SERVER_ERROR");
 console.info(JSON.stringify({ proof: "local-packed-cloud-selective", mode: process.argv[2], postgres: version,
  hostedAcceptance: false, before, afterUnrelated, policyBefore, policyAfter, revoked,
  checks: ["setup-excluded", "three-same-peer-subscriptions", "stable-UUID", "completed-ALL-drained-barrier",
   "unrelated-skip-broad-plus-one", "policy-only-empty-broad-plus-one", "permission-revocation-no-value",
   "wrong-UUID-denied", "subscription-change-denied"] }));
} finally {
 connection?.dispose();
 globalThis.fetch = nativeFetch; globalThis.WebSocket = NativeWebSocket;
 await backend?.stop();
 if (!backend) await runtime?.stop();
 try {
  if (namespace) await admin.query('DROP SCHEMA IF EXISTS "' + namespace + '" CASCADE');
  if (metadataNamespace) await admin.query('DROP SCHEMA IF EXISTS "' + metadataNamespace + '" CASCADE');
  if (role) { await admin.query('DROP OWNED BY "' + role + '"'); await admin.query('DROP ROLE IF EXISTS "' + role + '"'); }
  console.info(JSON.stringify({ cleanup: "owned-local-schemas-and-role-removed", hostedAcceptance: false }));
 } finally { await admin.end(); }
}
`;
