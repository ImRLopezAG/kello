import { defineRelations } from "drizzle-orm";
import { defineSchema } from "../../../apps/kello/src/core/schema/define-schema";
import { defineTable } from "../../../apps/kello/src/core/schema/table";
import { fields } from "../../../apps/kello/src/core/schema/fields";
import { createSearchValidators } from "../../../apps/kello/src/core/search/contract";
import type { SearchSelection, SearchLiveSelection, SearchRow } from "../../../apps/kello/src/core/search/types";

const schema = defineSchema(() => ({
  articles: defineTable(
    { title: fields.text().notNull(), body: fields.text() },
    {
      fullText: {
        content: {
          config: "pg_catalog.simple",
          fields: [
            { field: "title", weight: "A" },
            { field: "body", weight: "D" },
          ],
          version: "1",
        },
      },
    },
  ),
  legacy: { title: fields.text() },
}));
const graph = defineRelations(schema.tables, (r) => ({
  articles: { child: r.one.articles({ from: r.articles._id, to: r.articles._id }) },
}));
const validators = createSearchValidators(schema, graph);
const policy = {
  scope: "public",
  columns: ["title"],
  filter: ["title", "body"],
  text: ["title", "body"],
  fullText: ["content"],
  order: ["title"],
} as const;
validators.articles.search(policy);
validators.articles.liveSearch(policy);
// @ts-expect-error Undeclared document.
validators.articles.search({ ...policy, fullText: ["missing"] });
// @ts-expect-error Every source requires text permission.
validators.articles.search({ ...policy, text: ["title"] });
// @ts-expect-error Every source requires filter permission.
validators.articles.search({ ...policy, filter: ["title"] });
// @ts-expect-error Legacy tables cannot grant FTS.
validators.legacy.search({ scope: "public", columns: ["title"], fullText: ["content"] });
// @ts-expect-error Grants belong only to root.
validators.articles.search({ ...policy, relations: { child: policy } });
type Input = SearchSelection<typeof graph, typeof graph.articles, typeof policy>;
type Live = SearchLiveSelection<typeof graph, typeof graph.articles, typeof policy>;
const valid: Input = { fullText: { document: "content", query: "raw" }, columns: { title: true } };
const live: Live = { fullText: { document: "content", query: "" }, loadedPages: 2 };
// @ts-expect-error A query cannot override ranked ordering.
const order: Input = {
  fullText: { document: "content", query: "raw" },
  orderBy: [{ field: "title", direction: "asc" }],
};
// @ts-expect-error No user-owned configuration.
const config: Input = { fullText: { document: "content", query: "raw", config: "pg_catalog.simple" } };
// @ts-expect-error Document names remain literal grants.
const name: Live = { fullText: { document: "missing", query: "raw" } };
// @ts-expect-error Nested selection cannot request FTS.
const nested: Input = { with: { child: { fullText: { document: "content", query: "raw" } } } };
type Legacy = SearchSelection<typeof graph, typeof graph.legacy, { columns: readonly ["title"] }>;
// @ts-expect-error Ungranted inputs cannot request FTS.
const ungranted: Legacy = { fullText: { document: "content", query: "raw" } };
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;
export type ProjectionUnchanged = Assert<
  Equal<
    SearchRow<
      typeof graph,
      typeof graph.articles,
      typeof policy,
      { columns: { title: true }; fullText: { document: "content"; query: string } }
    >,
    { title: string }
  >
>;
void [valid, live, order, config, name, nested, ungranted];
