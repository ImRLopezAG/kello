import { sql } from "drizzle-orm";
import * as v from "valibot";
import type { SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { Fields } from "./table";

export type FullTextConfig = "pg_catalog.english" | "pg_catalog.simple";
export type FullTextWeight = "A" | "B" | "C" | "D";
export interface FullTextDocument<Key extends string = string> {
  readonly config: FullTextConfig;
  readonly fields: readonly { readonly field: Key; readonly weight: FullTextWeight }[];
  readonly version: string;
}
export type FullTextDeclarations<Key extends string = string> = Readonly<Record<string, FullTextDocument<Key>>>;
/** Native text and enum data types exclude UUIDs, numerics, and relation IDs. */
export type FullTextFieldKey<F extends Fields> = {
  [Key in keyof F & string]: ReturnType<F[Key]["build"]>["_"]["dataType"] extends "string" | "string enum"
    ? Key
    : never;
}[keyof F & string];
type CompiledFullTextSources<Sources extends FullTextDocument["fields"]> = {
  readonly [Index in keyof Sources]: {
    readonly field: Sources[Index]["field"];
    readonly weight: Sources[Index]["weight"];
  };
};
export type CompiledFullText<Documents extends FullTextDeclarations = FullTextDeclarations> = {
  readonly [Name in keyof Documents]: {
    readonly config: Documents[Name]["config"];
    readonly fields: CompiledFullTextSources<Documents[Name]["fields"]>;
    readonly version: Documents[Name]["version"];
    readonly representation: "expression";
  };
};

/** Snapshot author-owned lists without adding metadata when the declaration is absent. */
export function copyFullText<const Documents extends FullTextDeclarations>(documents: Documents): Documents {
  // SAFETY: every document key and literal is retained; only nested objects and arrays are copied/frozen.
  return Object.freeze(
    Object.fromEntries(
      Object.entries(documents).map(([name, document]) => [
        name,
        Object.freeze({
          ...document,
          fields: Object.freeze(document.fields.map((source) => Object.freeze({ ...source }))),
        }),
      ]),
    ),
  ) as Documents;
}

/** Compile validated schema declarations into canonical, expression-owned metadata. */
export function compileFullText(
  documents: FullTextDeclarations,
  fields: Fields,
  identifier: (name: string) => string,
): CompiledFullText {
  const entries = Object.entries(documents).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (entries.length < 1 || entries.length > 8) throw new Error("fullText requires 1..8 documents");
  const names = new Set<string>();
  return Object.freeze(
    Object.fromEntries(
      entries.map(([name, document]) => {
        const normalized = identifier(name);
        if (names.has(normalized)) throw new Error(`Full-text document SQL-name collision: ${name}`);
        names.add(normalized);
        if (document.config !== "pg_catalog.english" && document.config !== "pg_catalog.simple")
          throw new Error(`Invalid full-text configuration: ${name}`);
        if (
          !v.is(
            v.pipe(
              v.string(),
              v.check((value) => value.trim().length > 0 && !value.includes("\0")),
            ),
            document.version,
          )
        )
          throw new Error(`Invalid full-text version: ${name}`);
        if (document.fields.length < 1 || document.fields.length > 8)
          throw new Error(`Full-text document requires 1..8 fields: ${name}`);
        const sources = new Set<string>();
        for (const source of document.fields) {
          const field = Object.hasOwn(fields, source.field) ? fields[source.field] : undefined;
          if (!field || (field.metadata.kind !== "text" && field.metadata.kind !== "enum"))
            throw new Error(`Full-text source must be a root text/enum field: ${name}.${source.field}`);
          if (sources.has(source.field)) throw new Error(`Duplicate full-text source: ${name}.${source.field}`);
          sources.add(source.field);
          if (!["A", "B", "C", "D"].includes(source.weight)) throw new Error(`Invalid full-text weight: ${name}`);
        }
        return [
          name,
          Object.freeze({
            config: document.config,
            fields: Object.freeze(document.fields.map(({ field, weight }) => Object.freeze({ field, weight }))),
            version: document.version,
            representation: "expression" as const,
          }),
        ];
      }),
    ),
  );
}

/** Resolve native columns at the call site so indexes and aliased queries share exactly one vector expression. */
export function fullTextVector<Key extends string>(
  document: FullTextDocument<Key>,
  column: (field: Key) => AnyPgColumn,
): SQL {
  // Configs and weights are schema-owned allowlisted literals, never user query parameters.
  const config =
    document.config === "pg_catalog.english"
      ? sql`'pg_catalog.english'::regconfig`
      : document.config === "pg_catalog.simple"
        ? sql`'pg_catalog.simple'::regconfig`
        : undefined;
  if (!config) throw new Error("Invalid full-text configuration");
  const weights = { A: sql`'A'::"char"`, B: sql`'B'::"char"`, C: sql`'C'::"char"`, D: sql`'D'::"char"` };
  return sql`(${sql.join(
    document.fields.map((source) => {
      const weight = weights[source.weight];
      if (!weight) throw new Error("Invalid full-text weight");
      return sql`setweight(to_tsvector(${config}, coalesce(${column(source.field)}, '')), ${weight})`;
    }),
    sql` || `,
  )})`;
}
