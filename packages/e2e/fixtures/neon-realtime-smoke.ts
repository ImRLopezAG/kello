// Acceptance fixture: imports current integrated sources and their pinned dependencies.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKelloNeonApi } from "kello/tooling";
import { createKelloNeonClient } from "../../../apps/kello/src/tooling/neon/api";
import {
  connectDatabase,
  defineSchema,
  createNeonLiveQuery,
  createNeonQueryIssuer,
  runNeonMutation,
} from "kello/server";
import { createNeonLiveClient } from "kello/client";
import { sql, eq, and, exists } from "drizzle-orm";
import { pgSchema, text, integer, boolean, doublePrecision } from "drizzle-orm/pg-core";
import * as v from "valibot";
const projectId = "late-moon-69483649",
  branchId = "br-dark-block-awbbt60w",
  endpointId = "ep-solitary-block-awijudvn";
const runId = crypto.randomUUID(),
  namespace = "loom_" + runId.replaceAll("-", "");
interface ProviderReport {
  runId: string;
  namespace: string;
  projectId: string;
  branchId: string;
  endpointId: string;
  started: string;
  checks: { name: string; outcome: string; ms: number; errorClass?: string }[];
  admission?: string;
  server?: { version: string; database: string };
  status?: string;
  errorClass?: string;
  transportBarrier?: { heldFrames: number; deliveredFrames: number; rawFramesModified: boolean };
  relay?: string;
  cleanup?: string;
  pool?: string;
  finished?: string;
  cleanupErrors: string[];
}
const report: ProviderReport = {
  runId,
  namespace,
  projectId,
  branchId,
  endpointId,
  started: new Date().toISOString(),
  checks: [],
  cleanupErrors: [],
};
const checks = report.checks;
const output = join(tmpdir(), "kello-cloud-realtime-" + runId + ".json");
const persist = () => writeFile(output, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
let connection: Awaited<ReturnType<typeof connectDatabase>> | undefined;
const clients: ReturnType<typeof createNeonLiveClient>[] = [];
let allocated = false;
let relay: ReturnType<typeof Bun.serve> | undefined;
const upstreams = new Set<WebSocket>();
let hold = false;
const buffered: (() => void)[] = [];
let delivered = 0;
let releaseRefreshOnExit: (() => void) | undefined;
let stopping = false;

async function check(name: string, work: () => Promise<void>) {
  const start = Date.now();
  try {
    await work();
    checks.push({ name, outcome: "PASS", ms: Date.now() - start });
  } catch (e) {
    checks.push({ name, outcome: "FAIL", ms: Date.now() - start, errorClass: e instanceof Error ? e.name : "Unknown" });
    throw e;
  } finally {
    await persist();
  }
}
try {
  const api = createKelloNeonApi(),
    control = createKelloNeonClient();
  const [p, bs, endpoint, realtime, databases] = await Promise.all([
    api.getProject(projectId),
    api.listBranches(projectId),
    control.postgres.endpoints.get({ projectId, endpointId }),
    control.realtime.get({ projectId, branchId }),
    control.postgres.databases.list({ projectId, branchId }),
  ]);
  const b = bs.find((x) => x.id === branchId),
    database = databases.find((x) => x.name === "neondb");
  assert(
    p.id === projectId &&
      p.pgVersion === 18 &&
      b &&
      !b.isDefault &&
      !b.protected &&
      b.name === "loom-acceptance-kello-002-optimistic-20261007",
  );
  assert(
    endpoint.branch_id === branchId && realtime.enabled && !realtime.pending && realtime.invocation_url && database,
  );
  report.admission = "PASS";
  await persist();
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
  const schema = defineSchema(() => ({}));
  connection = await connectDatabase({
    connectionString: uri,
    schema,
    relations: {},
    maxConnections: 3,
  });
  const { db } = connection;
  const actual = await db.execute<{ version: string; database: string }>(
    sql`SELECT current_setting('server_version_num') AS version,current_database() AS database`,
  );
  assert(actual.rows[0]);
  report.server = actual.rows[0];
  assert.equal(actual.rows[0]?.database, "neondb");
  assert.equal(Math.floor(Number(actual.rows[0]?.version) / 10000), 18);
  await db.execute(sql`CREATE SCHEMA ${sql.identifier(namespace)}`);
  allocated = true;
  await db.execute(
    sql`CREATE TABLE ${sql.identifier(namespace)}.tasks(id text PRIMARY KEY,tenant text NOT NULL,title text NOT NULL,n integer NOT NULL,enabled boolean NOT NULL,ratio double precision NOT NULL)`,
  );
  await db.execute(
    sql`CREATE TABLE ${sql.identifier(namespace)}.members(issuer text NOT NULL,subject text NOT NULL,tenant text NOT NULL)`,
  );
  await db.execute(
    sql`CREATE TABLE ${sql.identifier(namespace)}.mutation_results(scope_hash text NOT NULL,key_hash text NOT NULL,fingerprint text NOT NULL,result jsonb NOT NULL,expires_at timestamptz NOT NULL,PRIMARY KEY(scope_hash,key_hash))`,
  );
  const scoped = pgSchema(namespace),
    tasks = scoped.table("tasks", {
      id: text().primaryKey(),
      tenant: text().notNull(),
      title: text().notNull(),
      n: integer().notNull(),
      enabled: boolean().notNull(),
      ratio: doublePrecision().notNull(),
    }),
    members = scoped.table("members", {
      issuer: text().notNull(),
      subject: text().notNull(),
      tenant: text().notNull(),
    });
  await db.insert(tasks).values([
    { id: "task", tenant: "A", title: "initial", n: 7, enabled: true, ratio: 1.25 },
    { id: "foreign", tenant: "B", title: "must-not-leak", n: 99, enabled: false, ratio: 0.5 },
  ]);
  await db.insert(members).values([
    { issuer: "https://acceptance.invalid", subject: "alice", tenant: "A" },
    { issuer: "https://acceptance.invalid", subject: "bob", tenant: "A" },
  ]);
  const authority = (subject: string, sessionId = "login-" + subject) => ({
    identity: { issuer: "https://acceptance.invalid", subject, tenantId: "A" },
    sessionId,
    expiresAt: Math.floor(Date.now() / 1000) + 600,
    signal: AbortSignal.timeout(180000),
  });
  const alice = authority("alice"),
    bob = authority("bob");
  const member = (subject: string) =>
    exists(
      db
        .select({ subject: members.subject })
        .from(members)
        .where(
          and(eq(members.issuer, "https://acceptance.invalid"), eq(members.subject, subject), eq(members.tenant, "A")),
        ),
    );
  const rows = v.array(
    v.strictObject({ id: v.string(), title: v.string(), n: v.number(), enabled: v.boolean(), ratio: v.number() }),
  );
  const definition = createNeonLiveQuery({
    name: "acceptance.tasks.v1",
    input: v.null(),
    rows,
    authorize: async ({ identity }) => {
      const found = await db.select().from(members).where(eq(members.subject, identity.subject));
      if (!found.length) throw new Error("Forbidden");
    },
    query: ({ identity }) =>
      db
        .select({ id: tasks.id, title: tasks.title, n: tasks.n, enabled: tasks.enabled, ratio: tasks.ratio })
        .from(tasks)
        .where(and(eq(tasks.tenant, "A"), member(identity.subject)))
        .orderBy(tasks.id),
  });
  const narrowed = createNeonLiveQuery({
    name: "acceptance.tasks.narrow.v1",
    input: v.null(),
    rows,
    authorize: definition.authorize,
    query: ({ identity }) =>
      db
        .select({ id: tasks.id, title: tasks.title, n: tasks.n, enabled: tasks.enabled, ratio: tasks.ratio })
        .from(tasks)
        .where(and(eq(tasks.tenant, "A"), eq(tasks.id, "task"), member(identity.subject)))
        .orderBy(tasks.id),
  });
  const target = { secret: secret.secret, database: "neondb", deployment: runId };
  const issuer = createNeonQueryIssuer({ ...target, queries: [definition, narrowed] });
  const mutate = async (
    title: string,
    key: string,
    extra: { who?: typeof alice; fail?: boolean; retry?: boolean; abort?: AbortController; noWrite?: boolean } = {},
  ) => {
    let attempts = 0;
    const attemptTxids: string[] = [];
    const receipt = await runNeonMutation({
      ...target,
      connection: connection!,
      metadataNamespace: namespace,
      operation: "acceptance.update.v1",
      idempotencyKey: key,
      input: { title },
      authority: extra.who ?? alice,
      output: v.strictObject({ title: v.string() }),
      authorize: async (tx, a) => {
        const found = await tx.select().from(members).where(eq(members.subject, a.identity.subject));
        if (!found.length) throw new Error("Forbidden");
      },
      execute: async (tx) => {
        attempts++;
        attemptTxids.push(
          (await tx.execute<{ txid: string }>(sql`SELECT pg_current_xact_id()::text AS txid`)).rows[0]!.txid,
        );
        if (!extra.noWrite) await tx.update(tasks).set({ title }).where(eq(tasks.id, "task"));
        if (extra.fail) throw new Error("Fixture rollback");
        if (extra.retry && attempts === 1)
          await tx.execute(sql`DO $$ BEGIN RAISE EXCEPTION 'owned retry' USING ERRCODE='40001'; END $$`);
        extra.abort?.abort(new Error("Owned abort"));
        return { kind: extra.noWrite ? "no-write" : "write", value: { title } };
      },
    });
    return { receipt, attempts, attemptTxids };
  };
  await check("real commit and replay preserve exact receipt and execute once", async () => {
    const a = await mutate("committed", "commit");
    const replay = await mutate("committed", "commit");
    assert.deepEqual(replay.receipt, a.receipt);
    assert.equal(replay.attempts, 0);
    assert.equal(a.receipt.transaction.kind, "committed");
    assert.equal((await db.select().from(tasks).where(eq(tasks.id, "task")))[0]?.title, "committed");
  });
  await check("rollback stores neither domain change nor replay receipt", async () => {
    const count = await db.execute(sql`SELECT count(*)::int AS n FROM ${sql.identifier(namespace)}.mutation_results`);
    await assert.rejects(mutate("rolledback", "rollback", { fail: true }));
    assert.equal((await db.select().from(tasks).where(eq(tasks.id, "task")))[0]?.title, "committed");
    assert.deepEqual(
      (await db.execute(sql`SELECT count(*)::int AS n FROM ${sql.identifier(namespace)}.mutation_results`)).rows,
      count.rows,
    );
  });
  await check("SQL serialization failure retries entire attempt and commits once", async () => {
    const r = await mutate("retried", "retry", { retry: true });
    assert.equal(r.attempts, 2);
    assert.notEqual(r.attemptTxids[0], r.attemptTxids[1]);
    assert.equal(r.receipt.transaction.kind === "committed" && r.receipt.transaction.txid, r.attemptTxids[1]);
    assert.equal((await db.select().from(tasks).where(eq(tasks.id, "task")))[0]?.title, "retried");
  });
  await check("aborted current attempt rolls back and has no receipt", async () => {
    const abort = new AbortController();
    const count = await db.execute(sql`SELECT count(*)::int AS n FROM ${sql.identifier(namespace)}.mutation_results`);
    await assert.rejects(mutate("aborted", "abort", { who: { ...alice, signal: abort.signal }, abort }));
    assert.equal((await db.select().from(tasks).where(eq(tasks.id, "task")))[0]?.title, "retried");
    assert.deepEqual(
      (await db.execute(sql`SELECT count(*)::int AS n FROM ${sql.identifier(namespace)}.mutation_results`)).rows,
      count.rows,
    );
  });
  const url = new URL(realtime.invocation_url);
  if (url.protocol === "https:") url.protocol = "wss:";
  // Test-only transport barrier: unchanged official upstream frames, never logged.
  // Credentials/capabilities remain in memory; this is not a mock stream.
  type RelayData = { upstream: WebSocket; outbound: (string | Uint8Array<ArrayBuffer>)[] };
  relay = Bun.serve<RelayData>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      const protocol = request.headers.get("sec-websocket-protocol");
      assert(protocol);
      const upstream = new WebSocket(url.href, protocol);
      upstreams.add(upstream);
      const data: RelayData = { upstream, outbound: [] };
      if (server.upgrade(request, { data, headers: { "sec-websocket-protocol": protocol } })) return;
      upstream.close();
      return new Response("Upgrade required", { status: 400 });
    },
    websocket: {
      open(ws) {
        const up = ws.data.upstream;
        up.addEventListener("open", () => {
          for (const frame of ws.data.outbound) up.send(frame);
          ws.data.outbound.length = 0;
        });
        up.addEventListener("message", (event) => {
          const send = () => {
            ws.send(event.data);
            delivered++;
          };
          if (hold) buffered.push(send);
          else send();
        });
        up.addEventListener("close", () => {
          upstreams.delete(up);
          ws.close();
        });
        up.addEventListener("error", () => ws.close());
      },
      message(ws, message) {
        const frame = v.is(v.string(), message) ? message : new Uint8Array(message);
        if (ws.data.upstream.readyState === WebSocket.OPEN) ws.data.upstream.send(frame);
        else ws.data.outbound.push(frame);
      },
      close(ws) {
        ws.data.outbound.length = 0;
        ws.data.upstream.close();
      },
    },
  });
  const client = createNeonLiveClient({ url: "ws://127.0.0.1:" + relay.port });
  clients.push(client);
  const issue = () => issuer.issue(definition, null, alice);
  const sub = client.open(await issue(), { rows, refresh: issue });
  async function waitFor(predicate: () => boolean, timeout = 20000) {
    const end = Date.now() + timeout;
    while (!predicate()) {
      if (Date.now() >= end) throw new Error("Bounded state timeout");
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  await check("actual SDK initial installed rows match native scalar decoding", async () => {
    await waitFor(() => sub.getSnapshot().status === "live");
    const native = await db
      .select({ id: tasks.id, title: tasks.title, n: tasks.n, enabled: tasks.enabled, ratio: tasks.ratio })
      .from(tasks)
      .where(and(eq(tasks.tenant, "A"), member(alice.identity.subject)))
      .orderBy(tasks.id);
    assert.deepEqual(sub.getSnapshot().data, native);
    assert.equal(sub.getSnapshot().data?.length, 1);
    assert.equal(sub.getSnapshot().data?.[0]?.id, "task");
    await assert.rejects(issuer.issue(definition, null, authority("eve")));
  });
  await check("live receipt-first confirmation waits for held actual Neon frames to be installed", async () => {
    hold = true;
    const r = await mutate("receipt-first", "receipt-first");
    await waitFor(() => buffered.length > 0);
    assert.notEqual(sub.getSnapshot().data?.[0]?.title, "receipt-first");
    let settled = false;
    const pending = sub.confirm(r.receipt, 15000).then((outcome) => {
      settled = true;
      return outcome;
    });
    await Promise.resolve();
    assert.equal(settled, false);
    const count = buffered.length;
    hold = false;
    for (const send of buffered.splice(0)) send();
    assert.equal(await pending, "confirmed");
    assert.equal(sub.getSnapshot().data?.[0]?.title, "receipt-first");
    report.transportBarrier = { heldFrames: count, deliveredFrames: delivered, rawFramesModified: false };
  });
  await check("observed update before receipt consumption confirms exact progress", async () => {
    const r = await mutate("update-first", "update-first");
    await waitFor(() => sub.getSnapshot().data?.[0]?.title === "update-first");
    assert.equal(await sub.confirm(r.receipt, 15000), "confirmed");
  });
  await check("actual SDK unknown future transaction times out without false confirmation", async () => {
    const r = await mutate("timeout-control", "timeout-control");
    assert.equal(r.receipt.transaction.kind, "committed");
    if (r.receipt.transaction.kind !== "committed") throw new Error("Expected txid");
    assert.equal(
      await sub.confirm(
        {
          ...r.receipt,
          transaction: { kind: "committed", txid: String(BigInt(r.receipt.transaction.txid) + 1000000n) },
        },
        150,
      ),
      "unknown",
    );
  });
  await check("concurrent same-key native transactions produce one domain increment and exact replay", async () => {
    const before = (await db.select().from(tasks).where(eq(tasks.id, "task")))[0]!.n;
    const work = () =>
      runNeonMutation({
        ...target,
        connection: connection!,
        metadataNamespace: namespace,
        operation: "acceptance.increment.v1",
        idempotencyKey: "concurrent",
        input: null,
        authority: alice,
        output: v.number(),
        authorize: async () => {},
        execute: async (tx) => {
          const changed = await tx
            .update(tasks)
            .set({ n: sql`${tasks.n}+1` })
            .where(eq(tasks.id, "task"))
            .returning({ n: tasks.n });
          return { kind: "write", value: changed[0]!.n };
        },
      });
    const rs = await Promise.all([work(), work(), work()]);
    assert.deepEqual(rs[0], rs[1]);
    assert.deepEqual(rs[1], rs[2]);
    assert.equal((await db.select().from(tasks).where(eq(tasks.id, "task")))[0]!.n, before + 1);
  });
  await check("external writer appears; filtered and unchanged writes confirm without inventing rows", async () => {
    await db.update(tasks).set({ title: "external-writer" }).where(eq(tasks.id, "task"));
    await waitFor(() => sub.getSnapshot().data?.[0]?.title === "external-writer");
    const before = sub.getSnapshot().data;
    const filtered = await runNeonMutation({
      ...target,
      connection: connection!,
      metadataNamespace: namespace,
      operation: "acceptance.filtered.v1",
      idempotencyKey: "filtered",
      input: null,
      authority: alice,
      output: v.null(),
      authorize: async () => {},
      execute: async (tx) => {
        await tx.update(tasks).set({ title: "filtered-update" }).where(eq(tasks.id, "foreign"));
        return { kind: "write", value: null };
      },
    });
    assert.equal(await sub.confirm(filtered, 15000), "confirmed");
    assert.deepEqual(sub.getSnapshot().data, before);
    const unchanged = await mutate("external-writer", "same-value");
    assert.equal(await sub.confirm(unchanged.receipt, 15000), "confirmed");
    assert.deepEqual(sub.getSnapshot().data, before);
  });
  await check("different-key concurrent same-row receipts both confirm latest installed state", async () => {
    const [a, b] = await Promise.all([mutate("overlap-A", "overlap-A"), mutate("overlap-B", "overlap-B")]);
    assert(a.receipt.transaction.kind === "committed" && b.receipt.transaction.kind === "committed");
    assert.notEqual(a.receipt.transaction.txid, b.receipt.transaction.txid);
    assert.deepEqual(await Promise.all([sub.confirm(a.receipt, 15000), sub.confirm(b.receipt, 15000)]), [
      "confirmed",
      "confirmed",
    ]);
    const native = (await db.select().from(tasks).where(eq(tasks.id, "task")))[0]!.title;
    assert.equal(sub.getSnapshot().data?.[0]?.title, native);
    assert(["overlap-A", "overlap-B"].includes(native));
  });
  await check("different identity and new login generation cannot confirm on old owner", async () => {
    const b = await mutate("bob", "bob", { who: bob });
    assert.equal(await sub.confirm(b.receipt, 500), "unknown");
    const next = await mutate("new-login", "new-login", { who: authority("alice", "different-login") });
    assert.equal(await sub.confirm(next.receipt, 500), "unknown");
  });
  await check("no-write and pending logout remain unknown after late actual frames", async () => {
    const n = await mutate("unchanged", "no-write", { noWrite: true });
    assert.equal(await sub.confirm(n.receipt, 500), "no-write");
    hold = true;
    const late = await mutate("late-after-logout", "late-after-logout");
    await waitFor(() => buffered.length > 0);
    let settled = false;
    const pending = sub.confirm(late.receipt, 15000).then((value) => {
      settled = true;
      return value;
    });
    await Promise.resolve();
    assert.equal(settled, false);
    client.dispose();
    assert.equal(await pending, "unknown");
    assert.equal(await sub.confirm(n.receipt, 500), "unknown");
    hold = false;
    for (const send of buffered.splice(0)) send();
    assert.equal(sub.getSnapshot().status, "closed");
    assert.equal(sub.getSnapshot().data, undefined);
  });
  const secondClient = createNeonLiveClient({ url: url.href });
  clients.push(secondClient);
  const bobIssue = () => issuer.issue(definition, null, bob);
  const bsub = secondClient.open(await bobIssue(), { rows, refresh: bobIssue });
  await check("membership revocation removes visible rows and denies renewed issuance", async () => {
    await waitFor(() => bsub.getSnapshot().status === "live");
    assert.equal(bsub.getSnapshot().data?.length, 1);
    assert.equal(bsub.getSnapshot().data?.[0]?.id, "task");
    await db.delete(members).where(eq(members.subject, "bob"));
    await waitFor(() => bsub.getSnapshot().data?.length === 0);
    await assert.rejects(bobIssue());
    await assert.rejects(mutate("forbidden", "forbidden", { who: bob }));
  });
  const observations: { owner: string; type: string; outcome?: string }[] = [];
  const makeClient = (owner: string) => {
    const c = createNeonLiveClient({
      url: url.href,
      observe: (event) => {
        const observation: (typeof observations)[number] = { owner, type: event.type };
        if ("outcome" in event) observation.outcome = event.outcome;
        observations.push(observation);
      },
    });
    clients.push(c);
    return c;
  };
  let fingerprintPredicate:
    | { sameAuthorization: boolean; sameSessionExpiry: boolean; differentFingerprint: boolean }
    | undefined;
  let refreshEntered = false;
  let returnedOld = false;
  let releaseRefresh: () => void = () => {};
  const refreshGate = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
    releaseRefreshOnExit = resolve;
  });
  const oldClient = makeClient("old");
  const generationClient = makeClient("changed-generation");
  const fingerprintClient = makeClient("changed-fingerprint");
  const old = oldClient.open(await issue(), {
    rows,
    refresh: async () => {
      refreshEntered = true;
      await refreshGate;
      if (stopping) throw new Error("Fixture stopped");
      const fresh = await issue();
      returnedOld = true;
      return fresh;
    },
  });
  const changedGeneration = generationClient.open(await issue(), {
    rows,
    refresh: () => issuer.issue(definition, null, authority("alice", "different-generation")),
  });
  const changedFingerprint = fingerprintClient.open(await issue(), {
    rows,
    refresh: async () => {
      const initial = await issue();
      const next = await issuer.issue(narrowed, null, alice);
      fingerprintPredicate = {
        sameAuthorization: next.authorization === initial.authorization,
        sameSessionExpiry: next.sessionExpiresAt === initial.sessionExpiresAt,
        differentFingerprint: next.query.queryFingerprint !== initial.query.queryFingerprint,
      };
      return next;
    },
  });
  await waitFor(
    () =>
      old.getSnapshot().status === "live" &&
      changedGeneration.getSnapshot().status === "live" &&
      changedFingerprint.getSnapshot().status === "live",
  );
  await check("scheduled renewal rejects changed generation and independently changed fingerprint", async () => {
    await waitFor(
      () =>
        refreshEntered &&
        changedGeneration.getSnapshot().status === "closed" &&
        changedFingerprint.getSnapshot().status === "closed",
      65000,
    );
    assert.deepEqual(fingerprintPredicate, {
      sameAuthorization: true,
      sameSessionExpiry: true,
      differentFingerprint: true,
    });
    assert.equal(changedGeneration.getSnapshot().data, undefined);
    assert.equal(changedFingerprint.getSnapshot().data, undefined);
    assert.equal(
      observations.filter(
        (e) =>
          ["changed-generation", "changed-fingerprint"].includes(e.owner) &&
          e.type === "renewal" &&
          e.outcome === "renewed",
      ).length,
      0,
    );
  });
  await check("disposed in-flight renewal cannot revive an owner after replacement login", async () => {
    assert(refreshEntered);
    oldClient.dispose();
    const oldEvents = observations.filter((e) => e.owner === "old" && e.type !== "confirmation").length;
    const replacementAuthority = authority("alice", "new-login-generation");
    const replacementIssue = () => issuer.issue(definition, null, replacementAuthority);
    const replacementClient = makeClient("replacement");
    const replacement = replacementClient.open(await replacementIssue(), { rows, refresh: replacementIssue });
    await waitFor(() => replacement.getSnapshot().status === "live");
    releaseRefresh();
    await waitFor(() => returnedOld);
    const r = await mutate("replacement-positive", "replacement-positive", { who: replacementAuthority });
    assert.equal(await replacement.confirm(r.receipt, 15000), "confirmed");
    assert.equal(replacement.getSnapshot().data?.[0]?.title, "replacement-positive");
    assert.equal(old.getSnapshot().status, "closed");
    assert.equal(old.getSnapshot().data, undefined);
    assert.equal(await old.confirm(r.receipt, 100), "unknown");
    assert.equal(observations.filter((e) => e.owner === "old" && e.type !== "confirmation").length, oldEvents);
  });
  report.status = "PASS";
} catch (e) {
  report.status = "FAIL";
  report.errorClass = e instanceof Error ? e.name : "Unknown"; /* no raw errors/SQL/capabilities/URI */
} finally {
  stopping = true;
  releaseRefreshOnExit?.();
  hold = false;
  buffered.length = 0;
  for (const c of clients) {
    try {
      c.dispose();
    } catch {
      report.cleanupErrors.push("client");
    }
  }
  for (const up of upstreams) {
    try {
      up.close();
    } catch {
      report.cleanupErrors.push("upstream");
    }
  }
  if (relay) {
    try {
      await relay.stop(true);
      report.relay = "CLOSED";
    } catch {
      report.cleanupErrors.push("relay");
    }
  }
  if (connection) {
    if (allocated) {
      try {
        await connection.db.execute(sql`DROP SCHEMA ${sql.identifier(namespace)} CASCADE`);
        report.cleanup = "OWN_SCHEMA_DROPPED";
      } catch {
        report.cleanup = "FAILED_OWN_SCHEMA_REMAINS";
        report.cleanupErrors.push("schema");
      }
    }
    try {
      await connection.close();
      report.pool = "CLOSED";
    } catch {
      report.cleanupErrors.push("pool");
    }
  }
  report.finished = new Date().toISOString();
  await persist();
  console.log(JSON.stringify(report, null, 2));
}

if (report.status !== "PASS" || report.cleanup !== "OWN_SCHEMA_DROPPED" || report.cleanupErrors.length)
  process.exitCode = 1;
