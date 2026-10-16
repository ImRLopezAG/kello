import { applicationBase } from "../../../apps/kello/src/core/server/application/definition";
import { oc, eventIterator } from "kello/contract";
import { createRpcRuntime, defineRpcAuth, defineSchema } from "../../../apps/kello/src/core/server";
import { createRpcSocketSession } from "kello/neon";
import { defineRelations, sql } from "drizzle-orm";
import * as v from "valibot";

const config = v.parse(
  v.object({
    LOOM_TEST_DATABASE_URL: v.string(),
    LOOM_TEST_LIFECYCLE_SCHEMA: v.pipe(v.string(), v.regex(/^app_[a-f0-9]+$/)),
    LOOM_TEST_LIFECYCLE_METADATA: v.pipe(v.string(), v.regex(/^loom_[a-f0-9]+$/)),
    LOOM_TEST_LIFECYCLE_PORT: v.pipe(v.string(), v.transform(Number), v.integer(), v.minValue(0), v.maxValue(65535)),
  }),
  process.env,
);
const schema = defineSchema((s) => ({ counter: { value: s.integer().notNull() } }), {
  namespace: config.LOOM_TEST_LIFECYCLE_SCHEMA,
});
const relations = defineRelations(schema.tables);
const contract = { read: oc.output(eventIterator(v.number())) };
const os = applicationBase<typeof contract, typeof schema, typeof relations, Record<never, never>>(
  contract,
  schema,
  relations,
  () => ({}),
);
const read = os.read.handler(({ context }) =>
  context.live(async ({ db }) => {
    const result = await db.execute<{ value: number }>(
      sql`SELECT value FROM ${sql.identifier(config.LOOM_TEST_LIFECYCLE_SCHEMA)}.counter`,
    );
    return v.parse(v.number(), result.rows[0]?.value);
  }),
);
const runtime = await createRpcRuntime({
  schema,
  relations,
  connectionString: config.LOOM_TEST_DATABASE_URL,
  metadataNamespace: config.LOOM_TEST_LIFECYCLE_METADATA,
  deployment: "lifecycle",
  version: "a".repeat(64),
  procedures: [{ path: ["read"], visibility: "public", procedure: read }],
  auth: defineRpcAuth({ authorize: async () => {} }),
  config: { realtime: { pollIntervalMs: 100 } },
  assertActive: async () => {},
});
interface SocketData {
  session?: ReturnType<typeof createRpcSocketSession>;
}
const server = Bun.serve<SocketData>({
  hostname: "127.0.0.1",
  port: config.LOOM_TEST_LIFECYCLE_PORT,
  fetch(request, transport) {
    if (new URL(request.url).pathname === "/api/kello/ticket") {
      return Response.json({ ticket: "a".repeat(43), expiresAt: Date.now() / 1000 + 30 });
    }
    if (transport.upgrade(request, { data: {}, headers: { "sec-websocket-protocol": "kello.orpc.2" } })) return;
    return new Response("Upgrade required", { status: 426 });
  },
  websocket: {
    open(socket) {
      // This process-lifecycle fixture supplies a trusted identity; ticket/JWT authority has separate integration tests.
      socket.data.session = createRpcSocketSession({
        router: runtime.router,
        session: { identity: { issuer: "test", subject: "alice" }, expiresAt: Math.floor(Date.now() / 1000) + 60 },
        socket: {
          get readyState() {
            return socket.readyState;
          },
          get bufferedAmount() {
            return socket.getBufferedAmount();
          },
          send(message) {
            socket.send(message);
          },
          close(code, reason) {
            socket.close(code, reason);
          },
        },
      });
    },
    message(socket, message) {
      socket.data.session?.message(message);
    },
    async close(socket) {
      await socket.data.session?.dispose();
    },
  },
});
process.stdout.write(`${server.port}\n`);
