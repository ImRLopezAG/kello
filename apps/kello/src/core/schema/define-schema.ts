import { compile } from "./compile";
import type { CompileOptions } from "./compile";
import { fields } from "./fields";
import type { EntityDeclaration } from "./table";
import { derive } from "../validation/derive";
import type { PgTable } from "drizzle-orm/pg-core";
import type { SchemaMetadata } from "./compile";
import * as v from "valibot";
import type { Id } from "./fields";

export interface SchemaDefinition {
  readonly tables: Readonly<Record<string, PgTable>>;
  readonly metadata: SchemaMetadata;
  readonly fingerprint: string;
}
// Recognize only the framework's identity-preserving ID action during browser generation.
const idBrandActions = new WeakSet<object>();
export function isIdBrandAction(action: v.GenericPipeItem): boolean {
  return idBrandActions.has(action);
}

const compiledSchemas = new WeakSet<object>();
const schemaBindings = new WeakMap<SchemaDefinition, (namespace: string) => SchemaDefinition>();

/** Recompile declarations; never mutate shared native Drizzle tables. */
export function bindSchemaNamespace<const Schema extends SchemaDefinition>(schema: Schema, namespace: string): Schema {
  const bind = schemaBindings.get(schema);
  if (!bind) throw new Error("Expected a Kello schema declaration");
  // SAFETY: the registered binding recompiles the same declarations and validators with only a different namespace.
  return bind(namespace) as Schema;
}

export function isKelloSchema(value: unknown): value is SchemaDefinition {
  return value instanceof Object && compiledSchemas.has(value);
}

export function defineSchema<const Entities extends Record<string, EntityDeclaration>>(
  define: (builder: typeof fields) => Entities,
  options: CompileOptions = {},
) {
  const entities = define(fields);
  const compiled = compile(entities, options);
  function id<const Name extends Extract<keyof Entities, string>>(table: Name) {
    if (!Object.hasOwn(entities, table)) throw new Error("Unknown ID table");
    const brand = v.transform((value: string): Id<Name> => {
      // SAFETY: UUID syntax is checked above; table branding is static and does not assert row existence.
      return value as Id<Name>;
    });
    idBrandActions.add(brand);
    return v.pipe(v.string(), v.uuid(), brand);
  }
  const schema = Object.freeze({ ...compiled, validators: derive(entities, compiled.metadata), id });
  compiledSchemas.add(schema);
  schemaBindings.set(schema, (namespace) => defineSchema(() => entities, { namespace }));
  return schema;
}
