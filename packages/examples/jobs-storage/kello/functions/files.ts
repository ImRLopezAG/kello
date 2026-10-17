import { os } from "../_generated/rpc";
import { ORPCError } from "@orpc/server";
import type { InvocationIdentity } from "kello/server";
import { and, eq, sql } from "drizzle-orm";
import * as v from "valibot";
import schema from "../schema";
import { jobStatus } from "../validation";

const { files } = schema.tables;
function owned(identity: InvocationIdentity | null) {
  if (!identity) throw new ORPCError("FORBIDDEN");
  return and(
    eq(files.ownerIssuer, identity.issuer),
    eq(files.ownerId, identity.subject),
    eq(files.ownerTenant, identity.tenantId ?? ""),
  );
}

const list = os.files.list.live(({ context: { db, identity } }) =>
  db
    .select({
      _id: files._id,
      intentId: sql<string>`${files.intentId}`.as("intentId"),
      bucket: files.bucket,
      size: files.size,
      contentType: sql<string>`${files.contentType}`.as("contentType"),
      sha256: files.sha256,
      summary: files.summary,
    })
    .from(files)
    .where(owned(identity))
    .orderBy(files._createdAt, files._id)
    .limit(100),
);

const status = os.files.status.handler(
  async ({
    context: {
      db,
      identity,
      tables: { files },
    },
    input: { intentId },
  }) => {
    const [file] = await db
      .select({ jobId: files.jobId })
      .from(files)
      .where(and(owned(identity), eq(files.intentId, intentId)));
    if (!file) throw new ORPCError("FORBIDDEN");
    if (!file.jobId) return null;
    // This example uses the default metadata namespace from its independent config.
    const result = await db.execute(sql`SELECT state, attempts FROM loom_meta.jobs WHERE id = ${file.jobId}::uuid`);
    const [job] = v.parse(v.array(jobStatus), result.rows);
    return job ?? null;
  },
);

export default os.files.router({ list, status });
