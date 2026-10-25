/** Bundled only by cloud-jobs-smoke; the nonce authorizes this temporary test probe. */
import assert from "node:assert/strict";
import { ORPCError, os } from "@orpc/server";
import { defineRelations, sql } from "drizzle-orm";
import { createRpcHttpApp } from "kello/neon";
import {
  bindRpcDatabaseProcedure,
  connectDatabase,
  createDatabaseMiddleware,
  createProjectProcedures,
  createRpcJobQueue,
  createRpcJobWorker,
  defineSchema,
  encodeRpcJobCall,
} from "kello/server";
import * as v from "valibot";

const version = "a".repeat(64);
const schema = defineSchema(() => ({}));
const relations = defineRelations(schema.tables);
const probe = os.input(v.strictObject({ nonce: v.pipe(v.string(), v.uuid()) })).handler(async ({ input }) => {
  if (input.nonce !== process.env.KELLO_PROBE_NONCE) throw new ORPCError("UNAUTHORIZED");
  const connectionString = v.parse(v.string(), process.env.KELLO_RUNTIME_URL);
  const metadataNamespace = v.parse(
    v.pipe(v.string(), v.regex(/^loom_cloud_jobs_[a-f0-9]+$/)),
    process.env.KELLO_METADATA,
  );
  const connection = await connectDatabase({ schema, relations, connectionString });
  let worker: ReturnType<typeof createRpcJobWorker> | undefined;
  try {
    const { procedure } = createProjectProcedures(schema);
    const table = sql`${sql.identifier(metadataNamespace)}.${sql.identifier("counter")}`;
    const task = procedure
      .use(createDatabaseMiddleware(relations, "write", schema))
      .input(v.strictObject({ amount: v.number() }))
      .handler(async ({ context, input }) => {
        assert.equal(context.identity?.subject, "cloud-probe");
        assert(context.job?.id);
        await context.db.execute(sql`UPDATE ${table} SET value = value + ${input.amount}`);
        return { applied: input.amount };
      });
    const replay = { metadataNamespace, deployment: "cloud-probe" };
    const internal = [{ path: ["increment"], procedure: task }];
    const queue = createRpcJobQueue({ ...replay, version, db: connection.db, internal });
    const id = await connection.transaction((transaction) =>
      queue.enqueue(
        transaction,
        encodeRpcJobCall(version, ["increment"], { amount: 7 }),
        { issuer: "test", subject: "cloud-probe" },
        {
          dueAt: new Date(0),
          deduplicationKey: input.nonce,
        },
      ),
    );
    worker = createRpcJobWorker({
      queue,
      internal: [
        {
          path: ["increment"],
          procedure: bindRpcDatabaseProcedure(task, { connection, replay, authorize: async () => {} }),
        },
      ],
      assertActive: async () => {},
    });
    const completed = await worker.run(1);
    assert.deepEqual(completed, { claimed: 1, completed: 1, failed: 0, leaseLost: 0 });
    assert.equal((await queue.inspect(id))?.state, "succeeded");
    assert.deepEqual((await connection.db.execute<{ value: number }>(sql`SELECT value FROM ${table}`)).rows, [
      { value: 7 },
    ]);
    return { succeeded: true, value: 7 };
  } finally {
    try {
      await worker?.stop();
    } finally {
      await connection.close();
    }
  }
});
export default createRpcHttpApp({
  router: { probe },
  version,
  origins: ["https://kello-smoke.invalid"],
  allowAnonymous: true,
  verify: async () => {
    throw new Error("Test probe accepts only its nonce");
  },
});
