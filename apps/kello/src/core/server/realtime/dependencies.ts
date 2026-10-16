import { getTableUniqueName, is } from "drizzle-orm";
import type { AnyRelations } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import type { DatabaseSchema } from "../database/connection";
import { validateSchemaRelations } from "../database/relations";
import { createRevisionReader } from "./revisions";
import type { RevisionReader, TableRevisions } from "./revisions";

/** Native graphs are mutable. Retain the topology that schema validation actually checks. */
function graphTopology(graph: AnyRelations): readonly unknown[] {
  const topology: unknown[] = [];
  for (const [name, config] of Object.entries(graph)) {
    topology.push(name, config.table, is(config.table, PgTable) ? getTableUniqueName(config.table) : undefined);
    for (const [relationName, relation] of Object.entries(config.relations)) {
      topology.push(relationName, relation, relation.sourceTable, relation.targetTable, relation.throughTable);
    }
  }
  return topology;
}

/** Generation-owned mapping. Names from application declarations never become SQL identifiers. */
export function createDependencyRegistry(
  metadataNamespace: string,
  scopes: readonly { readonly scope: string; readonly schema: DatabaseSchema }[],
) {
  const registered = new Map<string, { namespace: string; table: string }>();
  const namespaces = new Map<string, Set<string>>();
  const local = new Map<
    string,
    {
      schema: DatabaseSchema;
      names: ReadonlyMap<string, string>;
      graphs: WeakMap<AnyRelations, readonly unknown[]>;
    }
  >();
  for (const { scope, schema } of scopes) {
    if (local.has(scope)) throw new Error("Duplicate dependency scope");
    const names = new Map<string, string>();
    const tables = namespaces.get(schema.metadata.namespace) ?? new Set<string>();
    for (const entity of schema.metadata.entities) {
      if (names.has(entity.name)) throw new Error(`Ambiguous live dependency: ${entity.name}`);
      const table = schema.tables[entity.name];
      if (!is(table, PgTable)) throw new Error(`Missing compiled dependency table: ${entity.name}`);
      const config = getTableConfig(table);
      if (config.name !== entity.sqlName || (config.schema ?? "public") !== schema.metadata.namespace)
        throw new Error(`Dependency table metadata mismatch: ${entity.name}`);
      const key = JSON.stringify([schema.metadata.namespace, entity.sqlName]);
      registered.set(key, { namespace: schema.metadata.namespace, table: entity.sqlName });
      names.set(entity.name, key);
      tables.add(entity.sqlName);
    }
    if (Object.keys(schema.tables).some((name) => !names.has(name)))
      throw new Error("Unregistered compiled dependency table");
    namespaces.set(schema.metadata.namespace, tables);
    // Snapshot the generation's schema containers; caller mutation cannot change its registered names/tables.
    local.set(scope, {
      schema: {
        tables: Object.freeze({ ...schema.tables }),
        metadata: {
          namespace: schema.metadata.namespace,
          entities: schema.metadata.entities.map((entity) => ({ ...entity })),
        },
      },
      names,
      graphs: new WeakMap(),
    });
  }
  // Validate the merged namespace budget and retain immutable broad-poll readers.
  const allReaders = new Map<string, RevisionReader>();
  for (const [namespace, tables] of [...namespaces].sort(([a], [b]) => a.localeCompare(b))) {
    if (tables.size)
      allReaders.set(namespace, createRevisionReader({ namespace, metadataNamespace, tables: [...tables] }));
  }
  const keys = Object.freeze([...registered.keys()].sort());
  function resolve(scope: string, graph: AnyRelations | undefined, names: Iterable<string>): readonly string[] {
    const entry = local.get(scope);
    if (!entry) throw new Error("Unknown dependency scope");
    if (graph) {
      const topology = graphTopology(graph);
      const previous = entry.graphs.get(graph);
      if (
        !previous ||
        previous.length !== topology.length ||
        topology.some((value, index) => value !== previous[index])
      ) {
        validateSchemaRelations(entry.schema, graph);
        for (const entity of entry.schema.metadata.entities) {
          const table = entry.schema.tables[entity.name];
          if (!table || getTableUniqueName(table) !== `${entry.schema.metadata.namespace}.${entity.sqlName}`)
            throw new Error(`Dependency table metadata mismatch: ${entity.name}`);
        }
        entry.graphs.set(graph, topology);
      }
    }
    return Object.freeze(
      [
        ...new Set(
          [...names].map((name) => {
            const key = entry.names.get(name);
            if (!key) throw new Error(`Unknown live dependency: ${name}`);
            return key;
          }),
        ),
      ].sort(),
    );
  }
  async function read(db: NodePgDatabase, selected: Iterable<string> = keys): Promise<TableRevisions> {
    const grouped = new Map<string, string[]>();
    if (selected !== keys) {
      for (const key of new Set(selected)) {
        const entry = registered.get(key);
        if (!entry) throw new Error("Unknown qualified live dependency");
        const tables = grouped.get(entry.namespace) ?? [];
        tables.push(entry.table);
        grouped.set(entry.namespace, tables);
      }
    }
    const revisions: Record<string, string> = {};
    const readers =
      selected === keys
        ? allReaders
        : new Map(
            [...grouped]
              .sort(([a], [b]) => a.localeCompare(b))
              .map(
                ([namespace, tables]) =>
                  [namespace, createRevisionReader({ namespace, metadataNamespace, tables })] as const,
              ),
          );
    for (const [namespace, read] of readers) {
      const values = await read(db);
      for (const [table, value] of Object.entries(values)) revisions[JSON.stringify([namespace, table])] = value;
    }
    return Object.freeze(revisions);
  }
  return Object.freeze({ keys, resolve, read });
}

export type DependencyRegistry = ReturnType<typeof createDependencyRegistry>;
