import { defineRelations, sql, type SQLWrapper } from "drizzle-orm";
import { index, pgSchema, text, uuid } from "drizzle-orm/pg-core";

/** U1-only native fixture; no schema DSL or public search API. */
export function fullTextVector(fields: { title: SQLWrapper; body: SQLWrapper }) {
  return sql`setweight(to_tsvector('simple'::regconfig, coalesce(${fields.title}, '')), 'A') || setweight(to_tsvector('simple'::regconfig, coalesce(${fields.body}, '')), 'D')`;
}

export function fullTextRank(fields: { title: SQLWrapper; body: SQLWrapper }, query: string) {
  return sql`ts_rank_cd(ARRAY[0.1,0.2,0.4,1.0]::real[], (${fullTextVector(fields)}), plainto_tsquery('simple'::regconfig, ${query}), 32)::real`;
}

export function createFullTextFixture(namespace: string) {
  const schema = pgSchema(namespace);
  const documents = schema.table(
    "documents",
    {
      _id: uuid("_id").primaryKey(),
      owner: text("owner").notNull(),
      title: text("title"),
      body: text("body"),
      parentId: uuid("parent_id"),
    },
    (table) => [index("documents_fts_gin").using("gin", fullTextVector(table))],
  );
  const relations = defineRelations({ documents }, (r) => ({
    documents: {
      children: r.many.documents({ from: r.documents._id, to: r.documents.parentId, alias: "children" }),
    },
  }));
  return { schema, documents, relations };
}
