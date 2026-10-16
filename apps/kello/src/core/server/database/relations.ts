import { is, Relation } from "drizzle-orm";
import type { AnyRelations } from "drizzle-orm";
import { PgTable, getTableConfig } from "drizzle-orm/pg-core";
import * as v from "valibot";
import type { DatabaseSchema } from "./connection";

const nativeRelations = v.record(
  v.string(),
  v.object({
    table: v.custom<PgTable>((value) => is(value, PgTable)),
    name: v.string(),
    relations: v.record(
      v.string(),
      v.custom<Relation>((value) => is(value, Relation)),
    ),
  }),
);

export function isNativeRelations(value: unknown): value is AnyRelations {
  return v.is(nativeRelations, value);
}

export function validateSchemaRelations(schema: DatabaseSchema, relations: AnyRelations): void {
  const declared = new Set(schema.metadata.entities.map((entity) => entity.name));
  const compiledTables = new Set(Object.values(schema.tables));
  for (const [name, table] of Object.entries(schema.tables)) {
    if (!is(table, PgTable) || !declared.has(name)) throw new Error(`Unsupported compiled table: ${name}`);
    const config = getTableConfig(table);
    if ((config.schema ?? "public") !== schema.metadata.namespace) throw new Error(`Table namespace mismatch: ${name}`);
    if (relations[name]?.table !== table) throw new Error(`Relations must use the compiled table: ${name}`);
  }
  for (const name of declared)
    if (!Object.hasOwn(schema.tables, name)) throw new Error(`Missing compiled table: ${name}`);
  for (const [name, config] of Object.entries(relations)) {
    if (schema.tables[name] !== config.table) throw new Error(`Relations must use the compiled table: ${name}`);
    for (const relation of Object.values(config.relations)) {
      if (!is(relation, Relation)) throw new Error(`Unsupported relation API: ${name}`);
      if (relation.sourceTable !== config.table)
        throw new Error(`Relation source is outside its compiled table: ${name}`);
      if (!is(relation.targetTable, PgTable) || !compiledTables.has(relation.targetTable))
        throw new Error(`Relation target is outside schema: ${name}`);
      if (relation.throughTable && (!is(relation.throughTable, PgTable) || !compiledTables.has(relation.throughTable)))
        throw new Error(`Relation junction is outside schema: ${name}`);
    }
  }
}
