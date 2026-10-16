import { createHash } from "node:crypto";
import type { BetterAuthOptions } from "better-auth";
import { getAuthTables } from "@better-auth/core/db";
import type { BetterAuthDBSchema, DBFieldAttribute } from "@better-auth/core/db";
import { sql } from "drizzle-orm";
import * as v from "valibot";
import {
  check,
  bigint,
  boolean,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgSchema,
  serial,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { AnyPgColumn, AnyPgColumnBuilder, PgTable } from "drizzle-orm/pg-core";

interface AuthColumnBuilders {
  [name: string]: AnyPgColumnBuilder;
}

export interface BetterAuthSchema {
  readonly namespace: string;
  readonly tables: Readonly<Record<string, PgTable>>;
  readonly ownedTables: Readonly<Record<string, PgTable>>;
  readonly models: BetterAuthDBSchema;
  readonly fingerprint: string;
}

function identifier(value: string): string {
  if (
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value) ||
    Buffer.byteLength(value) > 63 ||
    ["__proto__", "constructor", "prototype"].includes(value)
  )
    throw new Error(`Unsupported Better Auth database identifier: ${value}`);
  return value;
}
function constraintName(table: string, field: string, kind: string) {
  const digest = createHash("sha256").update(`${table}:${field}:${kind}`).digest("hex").slice(0, 12);
  return `${table.slice(0, 30)}_${kind}_${digest}`;
}
function fieldColumn(name: string, field: DBFieldAttribute, idType: BetterAuthOptions["advanced"]) {
  if (field.references?.field === "id") {
    if (idType?.database?.generateId === "serial") return integer(name);
    if (idType?.database?.generateId === "uuid") return uuid(name);
  }
  if (Array.isArray(field.type)) return text(name);
  switch (field.type) {
    case "string":
      return text(name);
    case "number":
      return field.bigint ? bigint(name, { mode: "number" }) : doublePrecision(name);
    case "boolean":
      return boolean(name);
    case "date":
      return timestamp(name, { withTimezone: true, mode: "date" });
    case "json":
      return jsonb(name);
    case "string[]":
      return text(name).array();
    case "number[]":
      return doublePrecision(name).array();
    default:
      throw new Error(`Unsupported Better Auth field type at ${name}`);
  }
}

/** Native auth tables deliberately bypass Kello's entity columns and public validators. */
export function compileBetterAuthSchema(options: BetterAuthOptions, namespace: string): BetterAuthSchema {
  identifier(namespace);
  if (["public", "neon_auth", "information_schema"].includes(namespace) || namespace.startsWith("pg_"))
    throw new Error("Better Auth requires a private owned namespace");
  if (options.advanced?.database?.generateId === false)
    throw new Error("Unsupported Better Auth database-generated ID mode; use serial, uuid, or a string generator");
  if (options.advanced?.database?.joins)
    throw new Error("Better Auth database joins require generated relations and are not supported by this binding");
  const models = getAuthTables(options);
  const names = new Set<string>();
  for (const [key, model] of Object.entries(models)) {
    identifier(key);
    const name = identifier(model.modelName);
    if (names.has(name)) throw new Error(`Duplicate Better Auth table name: ${name}`);
    names.add(name);
    const columns = new Set(["id"]);
    for (const [fieldKey, field] of Object.entries(model.fields)) {
      identifier(fieldKey);
      const column = identifier(field.fieldName ?? fieldKey);
      if (["_id", "_createdAt"].includes(column))
        throw new Error(`Better Auth cannot use Kello entity columns: ${name}.${column}`);
      if (columns.has(column)) throw new Error(`Duplicate Better Auth column: ${name}.${column}`);
      columns.add(column);
      if (Array.isArray(field.type) && !v.safeParse(v.pipe(v.array(v.string()), v.minLength(1)), field.type).success)
        throw new Error(`Unsupported Better Auth enum: ${name}.${column}`);
      if (field.bigint && field.type !== "number") throw new Error(`Unsupported Better Auth bigint: ${name}.${column}`);
      if (field.references) {
        const target = models[field.references.model];
        if (!target || (field.references.field !== "id" && !Object.hasOwn(target.fields, field.references.field)))
          throw new Error(`Unknown Better Auth reference: ${name}.${column}`);
      }
    }
  }
  const tables: Record<string, PgTable> = {};
  const ownedTables: Record<string, PgTable> = {};
  const schema = pgSchema(namespace);
  for (const [modelKey, model] of Object.entries(models).sort(([a], [b]) => a.localeCompare(b))) {
    const mode = options.advanced?.database?.generateId;
    const columns: AuthColumnBuilders = {
      id:
        mode === "serial"
          ? serial("id").primaryKey()
          : mode === "uuid"
            ? uuid("id").defaultRandom().primaryKey()
            : text("id").primaryKey(),
    };
    for (const [key, field] of Object.entries(model.fields).sort(([a], [b]) => a.localeCompare(b))) {
      const name = field.fieldName ?? key;
      const column = fieldColumn(name, field, options.advanced);
      columns[name] = field.required === false ? column : column.notNull();
    }
    const table = schema.table(model.modelName, columns, (tableColumns) => {
      const extras = [];
      for (const [key, field] of Object.entries(model.fields)) {
        const column = tableColumns[field.fieldName ?? key]!;
        if (Array.isArray(field.type)) {
          const values = sql.join(
            field.type.map((value) => sql.raw(`'${value.replaceAll("'", "''")}'`)),
            sql`, `,
          );
          extras.push(check(constraintName(model.modelName, key, "enum"), sql`${column} in (${values})`));
        }
        if (field.unique) extras.push(uniqueIndex(constraintName(model.modelName, key, "unique")).on(column));
        else if (field.index) extras.push(index(constraintName(model.modelName, key, "idx")).on(column));
        if (field.references) {
          const target = models[field.references.model]!;
          const targetName = target.fields[field.references.field]?.fieldName ?? field.references.field;
          const targetTable = tables[target.modelName]!;
          // SAFETY: names were resolved from the canonical model schema before table construction.
          const foreignColumn = (targetTable as PgTable & Record<string, AnyPgColumn>)[targetName]!;
          extras.push(
            foreignKey({
              name: constraintName(model.modelName, key, "fk"),
              columns: [column],
              foreignColumns: [foreignColumn],
            }).onDelete(field.references.onDelete ?? "cascade"),
          );
        }
      }
      for (const specification of model.indexes ?? []) {
        const [first, ...rest] = specification.fields.map(
          (name) => tableColumns[model.fields[name]?.fieldName ?? name]!,
        );
        if (!first) throw new Error(`Empty Better Auth index: ${modelKey}`);
        extras.push(
          (specification.unique
            ? uniqueIndex(
                specification.name ?? constraintName(model.modelName, specification.fields.join(":"), "unique"),
              )
            : index(specification.name ?? constraintName(model.modelName, specification.fields.join(":"), "idx"))
          ).on(first, ...rest),
        );
      }
      return extras;
    });
    tables[model.modelName] = table;
    if (!model.disableMigrations) ownedTables[model.modelName] = table;
  }
  const structure = Object.entries(models)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, model]) => ({
      key,
      name: model.modelName,
      external: model.disableMigrations ?? false,
      fields: Object.entries(model.fields)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, field]) => ({
          key,
          name: field.fieldName ?? key,
          type: field.type,
          required: field.required !== false,
          unique: field.unique ?? false,
          index: field.index ?? false,
          bigint: field.bigint ?? false,
          references: field.references
            ? [field.references.model, field.references.field, field.references.onDelete ?? "cascade"]
            : null,
        })),
      indexes: model.indexes ?? [],
    }));
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        namespace,
        plugins: (options.plugins ?? [])
          .map((plugin) => [plugin.id, plugin.version ?? null])
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
        id:
          options.advanced?.database?.generateId === "serial"
            ? "serial"
            : options.advanced?.database?.generateId === "uuid"
              ? "uuid"
              : "text",
        structure,
      }),
    )
    .digest("hex");
  return Object.freeze({
    namespace,
    tables: Object.freeze(tables),
    ownedTables: Object.freeze(ownedTables),
    models,
    fingerprint,
  });
}
