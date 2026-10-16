import { defineRelations, eq } from "drizzle-orm";
import {
  createDatabaseMiddleware,
  createProjectContext,
  createProjectProcedures,
  defineSchema,
  defineTable,
} from "../../../apps/loom/src/core/server/index";
import type { ProcedureContext } from "../../../apps/loom/src/core/server/index";
import { searchErrors } from "../../../apps/loom/src/core/search/errors";
import { defaultSearchBudgets } from "../../../apps/loom/src/core/search/public";

/** Native source fixture: the runtime, not this fixture, owns live evaluation. */
export function fullTextLiveFixture(namespace: string, fullTextTimeoutMs = 30000) {
  const schema = defineSchema(
    (f) => ({
      documents: defineTable(
        {
          tenant: f.text().notNull(),
          label: f.text().notNull(),
          title: f.text(),
          body: f.text(),
        },
        {
          fullText: {
            content: {
              config: "pg_catalog.simple",
              version: "1",
              fields: [
                { field: "title", weight: "A" },
                { field: "body", weight: "D" },
              ],
            },
          },
        },
      ),
      labels: defineTable({ name: f.text().notNull() }),
      documentLabels: defineTable({
        documentId: f.reference("documents").notNull(),
        labelId: f.reference("labels").notNull(),
      }),
      memberships: defineTable({ tenant: f.text().notNull(), subject: f.text().notNull() }),
    }),
    { namespace },
  );
  const relations = defineRelations(schema.tables, (r) => ({
    documents: {
      labels: r.many.labels({
        from: r.documents._id.through(r.documentLabels.documentId),
        to: r.labels._id.through(r.documentLabels.labelId),
      }),
    },
  }));
  const { validators } = createProjectContext(schema, relations);
  const { procedure } = createProjectProcedures(schema, relations);
  const live = validators.tables.documents.liveSearch({
    budgets: { ...defaultSearchBudgets, fullTextTimeoutMs },
    columns: ["label"],
    filter: ["title", "body"],
    text: ["title", "body"],
    fullText: ["content"],
    scope: {
      name: "tenant",
      version: "1",
      where: ({ table, identity }: { table: typeof schema.tables.documents; identity: ProcedureContext["identity"] }) =>
        eq(table.tenant, identity?.tenantId ?? "anonymous"),
    },
    through: { documentLabels: "public" },
    relations: { labels: { scope: "public", columns: ["name"] } },
  });
  const watch = procedure
    .errors({ ...searchErrors, FORBIDDEN: { status: 403, message: "Membership revoked" } })
    .use(createDatabaseMiddleware(relations, "read", schema))
    .input(live.input)
    .output(live.output)
    .handler(({ context, input }) => context.search.documents.watch(input));
  return { schema, relations, watch };
}
