import { createHash } from "node:crypto";
import { getTableColumns, sql } from "drizzle-orm";
import { check, customType, foreignKey, index, pgSchema, pgTable, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { AnyPgColumnBuilder, PgBuildColumns, PgTable, PgTableFn, PgTableWithColumns } from "drizzle-orm/pg-core";
import { Field } from "./fields";
import type { FieldMetadata, Id } from "./fields";
import { TableDefinition } from "./table";
import type { EntityDeclaration, EntityFields, Fields, TableOptions } from "./table";
import { compileFullText, fullTextVector } from "./full-text";
import type { CompiledFullText, FullTextDeclarations } from "./full-text";

export function sqlName(name: string): string {
  if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(name)) throw new Error(`Invalid schema identifier: ${name}`);
  const result = name
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
  if (Buffer.byteLength(result) > 63) throw new Error(`Schema identifier exceeds PostgreSQL's 63-byte limit: ${name}`);
  if (result.startsWith("loom_")) throw new Error(`Reserved schema identifier: ${name}`);
  return result;
}

function decodeMilliseconds(value: string | number): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new Error("_createdAt exceeds the safe integer range");
  return result;
}
const milliseconds = customType<{ data: number; driverData: string; jsonData: string | number }>({
  dataType: () => "bigint",
  fromDriver: decodeMilliseconds,
  fromJson: decodeMilliseconds,
  toDriver: (value) => String(decodeMilliseconds(value)),
});
function systemColumns<Name extends string>() {
  return {
    _id: uuid("_id")
      .$type<Id<Name>>()
      .primaryKey()
      .default(sql`uuidv7()`),
    _createdAt: milliseconds("_createdAt")
      .notNull()
      .default(sql`floor((EXTRACT(epoch FROM clock_timestamp()) * (1000)::numeric))`),
  };
}
type Columns<Entity extends EntityDeclaration, Name extends string> = {
  [Key in keyof EntityFields<Entity>]: ReturnType<EntityFields<Entity>[Key]["build"]>;
} & ReturnType<typeof systemColumns<Name>>;
export type NativeTables<Entities extends Record<string, EntityDeclaration>> = {
  [Name in keyof Entities & string]: PgTableWithColumns<{
    name: Name;
    schema: string | undefined;
    columns: PgBuildColumns<Name, Columns<Entities[Name], Name>>;
    dialect: "pg";
  }> & {
    /** Type-only document metadata follows the table through native relation graphs; runtime metadata lives on the schema. */
    readonly _: EntityFullText<Entities[Name]>;
  };
};
export interface CompiledField extends FieldMetadata {
  readonly name: string;
  readonly sqlName: string;
}
export interface CompiledEntity {
  readonly name: string;
  readonly sqlName: string;
  readonly fields: readonly CompiledField[];
  readonly options: TableOptions;
}
export interface SchemaMetadata {
  readonly namespace: string;
  readonly entities: readonly CompiledEntity[];
}
type EntityFullText<Entity extends EntityDeclaration> =
  Entity extends TableDefinition<Fields, infer Options>
    ? Options extends { readonly fullText: infer Documents extends FullTextDeclarations }
      ? { readonly fullText: CompiledFullText<Documents> }
      : "fullText" extends keyof Options
        ? Options extends { readonly fullText?: infer Documents extends FullTextDeclarations }
          ? { readonly fullText?: CompiledFullText<Documents> }
          : object
        : object
    : object;
/** Discriminated entity names retain each declaration's literal document keys for later graph policy typing. */
export type CompiledSchemaMetadata<Entities extends Record<string, EntityDeclaration>> = Omit<
  SchemaMetadata,
  "entities"
> & {
  readonly entities: readonly {
    [Name in keyof Entities & string]: Omit<CompiledEntity, "name" | "options"> & {
      readonly name: Name;
      readonly options: Omit<TableOptions, "fullText"> & EntityFullText<Entities[Name]>;
    };
  }[keyof Entities & string][];
};
export interface CompileOptions {
  readonly namespace?: string;
}
interface ColumnBuilders extends Record<string, AnyPgColumnBuilder> {}

export function compile<const Entities extends Record<string, EntityDeclaration>>(
  entities: Entities,
  options: CompileOptions,
) {
  const namespace = options.namespace ?? "public";
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(namespace)) throw new Error("Invalid PostgreSQL namespace");
  const declarations = new Map(
    Object.entries(entities)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, entity]) => [
        name,
        entity instanceof TableDefinition ? entity : new TableDefinition<Fields>(entity, {}),
      ]),
  );
  const usedNames = new Set<string>();
  const metadata: SchemaMetadata = Object.freeze({
    namespace,
    entities: Object.freeze(
      [...declarations].map(([name, table]) => {
        const tableName = sqlName(name);
        if (usedNames.has(tableName)) throw new Error(`Entity SQL-name collision: ${name}`);
        usedNames.add(tableName);
        const columns = new Set<string>(["_id", "_createdAt"]);
        const compiledFields = Object.entries(table.fields)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, field]) => {
            const path = `${name}.${key}`;
            if (!(field instanceof Field)) throw new Error(`Unsupported field declaration: ${path}`);
            if (key.startsWith("_")) throw new Error(`Reserved field: ${path}`);
            const columnName = sqlName(key);
            if (columns.has(columnName)) throw new Error(`Field SQL-name collision: ${path}`);
            columns.add(columnName);
            const { kind, notNull, unique, defaultValue, reference, enumValues, precision, scale } = field.metadata;
            if (reference && !declarations.has(reference.target))
              throw new Error(`Unknown reference at ${path}: ${reference.target}`);
            if (reference?.onDelete === "set null" && notNull)
              throw new Error(`Cannot set null on required reference: ${path}`);
            return Object.freeze({
              name: key,
              sqlName: columnName,
              kind,
              notNull,
              unique,
              defaultValue,
              reference,
              enumValues,
              precision,
              scale,
            });
          });
        for (const key of [
          ...(table.options.serverFields ?? []),
          ...(table.options.commandFields ?? []),
          ...(table.options.indexes ?? []).flatMap((entry) => entry.fields),
        ]) {
          if (!Object.hasOwn(table.fields, key)) throw new Error(`Unknown field in ${name} policy/index: ${key}`);
        }
        for (const key of table.options.publicFields ?? []) {
          if (key !== "_id" && key !== "_createdAt" && !Object.hasOwn(table.fields, key))
            throw new Error(`Unknown public field: ${name}.${key}`);
        }
        for (const key of table.options.commandFields ?? []) {
          if (table.options.serverFields?.includes(key))
            throw new Error(`Server field cannot be a command input: ${name}.${key}`);
        }
        const structuralOptions: TableOptions = {
          indexes: table.options.indexes ?? Object.freeze([]),
          serverFields: table.options.serverFields ?? Object.freeze([]),
          commandFields: table.options.commandFields ?? Object.freeze([]),
          publicFields: table.options.publicFields ?? Object.freeze([]),
        };
        if (table.options.fullText !== undefined)
          Object.assign(structuralOptions, {
            fullText: compileFullText(table.options.fullText, table.fields, sqlName),
          });
        Object.freeze(structuralOptions);
        return Object.freeze({
          name,
          sqlName: tableName,
          fields: Object.freeze(compiledFields),
          options: structuralOptions,
        });
      }),
    ),
  });

  const tables: Record<string, PgTable> = {};
  const createTable: PgTableFn<string | undefined> = namespace === "public" ? pgTable : pgSchema(namespace).table;
  for (const entity of metadata.entities) {
    const definition = declarations.get(entity.name);
    if (!definition) throw new Error(`Missing declaration: ${entity.name}`);
    const columns: ColumnBuilders = { ...systemColumns() };
    for (const field of entity.fields) {
      const declaration = definition.fields[field.name];
      if (!declaration) throw new Error(`Missing field: ${entity.name}.${field.name}`);
      columns[field.name] = declaration.build(field.sqlName);
    }
    tables[entity.name] = createTable(entity.sqlName, columns, (built) => {
      const constraints = [];
      for (const field of entity.fields) {
        const column = built[field.name];
        if (!column) throw new Error(`Missing compiled column: ${entity.name}.${field.name}`);
        if (field.reference) {
          const { target, onDelete } = field.reference;
          const referenced = tables[target];
          if (!referenced) throw new Error(`Missing compiled reference: ${target}`);
          const targetId = getTableColumns(referenced)._id;
          if (!targetId) throw new Error(`Missing system identity: ${target}`);
          constraints.push(foreignKey({ columns: [column], foreignColumns: [targetId] }).onDelete(onDelete));
        }
        if (field.enumValues) {
          constraints.push(
            check(
              constraintName(entity.sqlName, field.sqlName, "enum"),
              sql`${column} = ANY (ARRAY[${sql.join(
                field.enumValues.map((value) => sql`${value}::text`),
                sql`, `,
              )}])`.inlineParams(),
            ),
          );
        }
      }
      for (const [position, entry] of (entity.options.indexes ?? []).entries()) {
        const indexed = entry.fields.map((key) => {
          const column = built[key];
          if (!column) throw new Error(`Missing index column: ${entity.name}.${key}`);
          return column;
        });
        const first = indexed[0];
        if (!first) throw new Error(`Empty index: ${entity.name}`);
        const name = constraintName(entity.sqlName, String(position), "idx");
        constraints.push((entry.unique ? uniqueIndex(name) : index(name)).on(first, ...indexed.slice(1)));
      }
      for (const [documentName, document] of Object.entries(entity.options.fullText ?? {})) {
        const documentSqlName = sqlName(documentName);
        const identity = createHash("sha256")
          .update(JSON.stringify([entity.sqlName, documentSqlName]))
          .digest("hex")
          .slice(0, 16);
        constraints.push(
          index(constraintName(entity.sqlName, `${documentSqlName}_${identity}`, "fts_idx")).using(
            "gin",
            fullTextVector(document, (key) => {
              const column = built[key];
              if (!column) throw new Error(`Missing full-text column: ${entity.name}.${key}`);
              return column;
            }),
          ),
        );
      }
      return constraints;
    });
  }
  // SAFETY: each declaration key is compiled exactly once using its field factories and the two typed system columns.
  const nativeTables = tables as NativeTables<Entities>;
  return Object.freeze({
    tables: Object.freeze(nativeTables),
    // SAFETY: metadata is built once per declaration with its unchanged entity/document keys.
    metadata: metadata as CompiledSchemaMetadata<Entities>,
    fingerprint: createHash("sha256").update(JSON.stringify(metadata)).digest("hex"),
  });
}

function constraintName(table: string, field: string, suffix: string): string {
  const name = `${table}_${field}_${suffix}`;
  return name.length <= 63
    ? name
    : `${name.slice(0, 46)}_${createHash("sha256").update(name).digest("hex").slice(0, 16)}`;
}
