import { fields } from "../../../apps/kello/src/core/schema/fields";
import { call, ORPCError } from "@orpc/server";
import type { InferSchemaInput } from "@orpc/server";
import { Context } from "effect";
import { defineRelations, eq } from "drizzle-orm";
import {
  bindRpcDatabaseProcedure,
  connectDatabase,
  createDatabaseMiddleware,
  createProjectContext,
  createProjectProcedures,
  defineSchema,
  defineTable,
  Invocation,
} from "../../../apps/kello/src/core/server/index";
import type { ProcedureContext } from "../../../apps/kello/src/core/server/index";
import { searchErrors } from "../../../apps/kello/src/core/search/errors";
import { searchSchemaMetadata } from "../../../apps/kello/src/core/search/metadata";

interface RankFixtureExtraFields {
  added?: ReturnType<typeof fields.text>;
}

/** Source-only native fixture; no query dispatch, cursor oracle or production seam. */
export function rankHandlerSchema(
  namespace: string,
  variant: {
    config?: "pg_catalog.simple" | "pg_catalog.english";
    weight?: "A" | "B";
    documentVersion?: string;
    schemaChange?: boolean;
  } = {},
) {
  const additionalFields: RankFixtureExtraFields = {};
  if (variant.schemaChange) additionalFields.added = fields.text();
  return defineSchema(
    (f) => ({
      documents: defineTable(
        {
          label: f.text().notNull(),
          owner: f.text().notNull(),
          title: f.text(),
          body: f.text(),
          published: f.boolean().notNull(),
          searchRank: f.text().notNull(),
          ...additionalFields,
        },
        {
          fullText: {
            content: {
              config: variant.config ?? "pg_catalog.simple",
              version: variant.documentVersion ?? "1",
              fields: [
                { field: "title", weight: variant.weight ?? "A" },
                { field: "body", weight: "D" },
              ],
            },
          },
        },
      ),
    }),
    { namespace },
  );
}

export function rankHandlerIdentity(subject = "alice", tenantId = "tenant-a"): ProcedureContext {
  const invocation = {
    identity: { issuer: "https://rank.test", subject, tenantId },
    requestId: crypto.randomUUID(),
    signal: new AbortController().signal,
  };
  return { ...invocation, "effect/context": Context.make(Invocation, invocation) };
}

export async function rankHandler(
  schema: ReturnType<typeof rankHandlerSchema>,
  connectionString: string,
  metadataNamespace: string,
  variant: { key?: string; policyVersion?: string; contract?: string } = {},
) {
  const relations = defineRelations(schema.tables);
  const connection = await connectDatabase({ schema, relations, connectionString, maxConnections: 1 });
  try {
    const { validators } = createProjectContext(schema, relations);
    const { procedure } = createProjectProcedures(schema, relations);
    const policy = {
      columns: ["label", "title", "body", "searchRank"],
      filter: ["published", "title", "body"],
      text: ["title", "body"],
      fullText: ["content"],
      scope: {
        name: "owner",
        version: variant.policyVersion ?? "1",
        where: ({
          table,
          identity,
        }: {
          table: typeof schema.tables.documents;
          identity: ProcedureContext["identity"];
        }) => eq(table.owner, identity?.subject ?? "anonymous"),
      },
    } as const;
    const finite = validators.tables.documents.search(policy);
    const read = createDatabaseMiddleware(relations, "read", schema);
    const options = {
      connection,
      replay: { metadataNamespace, deployment: "fts-u4" },
      search: {
        branchId: "fts-u4-local",
        key: variant.key ?? "04".repeat(32),
        contract: variant.contract ?? "fts-u4/search",
      },
      authorize: async ({ identity }: ProcedureContext) => {
        if (!identity) throw new ORPCError("UNAUTHORIZED");
      },
    };
    const list = bindRpcDatabaseProcedure(
      procedure
        .errors(searchErrors)
        .use(read)
        .input(finite.input)
        .output(finite.output)
        .handler(({ context, input }) => context.search.documents.paginate(input)),
      options,
    );
    const descriptor = searchSchemaMetadata(finite.input)?.descriptor;
    if (!descriptor) throw new Error("Missing native rank descriptor");
    return {
      connection,
      descriptor,
      request: (input: InferSchemaInput<typeof finite.input>, context = rankHandlerIdentity()) =>
        call(list, input, { context }),
    };
  } catch (error) {
    await connection.close();
    throw error;
  }
}
