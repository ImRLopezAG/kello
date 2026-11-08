import assert from "node:assert/strict";
import {
  connectDatabase,
  createRpcJobQueue,
  createRpcJobWorker,
  defineSchema,
  createProjectProcedures,
  createDatabaseMiddleware,
  bindRpcDatabaseProcedure,
} from "kello/server";
import { ORPCError } from "@orpc/server";
import { defineRelations, sql } from "drizzle-orm";
import * as v from "valibot";

assert.equal(Number(process.versions.node.split(".")[0]), 24);
assert.equal("Bun" in globalThis, false);
const config = v.parse(
  v.object({
    KELLO_TEST_DATABASE_URL: v.string(),
    KELLO_TEST_JOB_METADATA: v.string(),
    KELLO_TEST_JOB_SCHEMA: v.string(),
    KELLO_TEST_JOB_CRASH: v.picklist(["claimed", "committed"]),
  }),
  process.env,
);
const schema = defineSchema(() => ({}));
const relations = defineRelations(schema.tables);
const connection = await connectDatabase({
  schema,
  relations,
  connectionString: config.KELLO_TEST_DATABASE_URL,
});
const version = "a".repeat(64);
const deployment = "worker-test";
const metadataNamespace = config.KELLO_TEST_JOB_METADATA;
const { procedure } = createProjectProcedures(schema);
const authorize = async (context: { identity: { subject: string } | null }) => {
  if (context.identity?.subject !== "alice") throw new ORPCError("FORBIDDEN");
};
const write = procedure
  .use(createDatabaseMiddleware(relations, "write", schema))
  .input(v.null())
  .output(v.number())
  .handler(async ({ context }) => {
    assert.ok(context.job);
    assert.equal(context.job.attempt, 1);
    const result = await context.db.execute<{ value: number }>(
      sql`UPDATE ${sql.identifier(config.KELLO_TEST_JOB_SCHEMA)}.effects SET value=value+1 RETURNING value`,
    );
    return result.rows[0]?.value ?? -1;
  });
const internal = [
  {
    path: ["jobs", "write"],
    procedure: bindRpcDatabaseProcedure(write, { connection, replay: { deployment, metadataNamespace }, authorize }),
  },
];
const queue = createRpcJobQueue({ db: connection.db, version, internal, deployment, metadataNamespace });
async function pause(stage: "claimed" | "committed"): Promise<void> {
  if (stage !== config.KELLO_TEST_JOB_CRASH) return;
  process.stdout.write(`${stage}\n`);
  await new Promise<void>(() => {});
}
const worker = createRpcJobWorker({
  queue: {
    ...queue,
    claim: async (owner, seconds) => {
      const job = await queue.claim(owner, seconds);
      assert.ok(job);
      await pause("claimed");
      return job;
    },
    complete: async (lease, value) => {
      await pause("committed");
      return queue.complete(lease, value);
    },
  },
  internal,
  // Explicit trusted local fixture. Cloud activation verification is a separate adapter gate.
  assertActive: async () => {},
  leaseSeconds: 1,
});
try {
  await worker.run(1);
} finally {
  await worker.stop();
  await connection.close();
}
