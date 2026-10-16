import type { StandardSchemaV1 } from "@standard-schema/spec";
import { sql } from "drizzle-orm";
import { bigint, boolean, integer, jsonb, numeric, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { AnyPgColumnBuilder, PgColumnBuilder, PgColumnBuilderConfig } from "drizzle-orm/pg-core";

declare const entityId: unique symbol;
/** Entity-branded UUID string. The brand prevents mixing table IDs in typed code; validating its syntax does not check row existence or ownership. */
export type Id<Entity extends string> = string & { readonly [entityId]: Entity };
/** JSON-compatible values accepted by JSON fields; dates and bigint require an explicit representation. */
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };
/** Storage category used by schema compilation and migration comparison. */
export type StorageKind =
  | "text"
  | "boolean"
  | "integer"
  | "bigint"
  | "numeric"
  | "uuid"
  | "timestamp"
  | "json"
  | "enum"
  | "reference";
/** Foreign-key target and PostgreSQL deletion behavior. */
export interface Reference {
  readonly target: string;
  readonly onDelete: "restrict" | "cascade" | "set null";
}
/** Immutable storage metadata retained independently of native Drizzle column builders. */
export interface FieldMetadata {
  readonly kind: StorageKind;
  readonly notNull: boolean;
  readonly unique: boolean;
  readonly defaultValue?: string | undefined;
  readonly reference?: Reference | undefined;
  readonly enumValues?: readonly string[] | undefined;
  readonly precision?: number | undefined;
  readonly scale?: number | undefined;
}
/** Column builder, storage metadata, and optional Standard Schema validator for a field. */
export interface FieldDefinition {
  readonly metadata: FieldMetadata;
  readonly build: (name: string) => AnyPgColumnBuilder;
  readonly validator?: StandardSchemaV1 | undefined;
}

/** An immutable declaration; every compilation creates fresh native builders. */
export class Field<
  B extends PgColumnBuilder<PgColumnBuilderConfig>,
  V extends StandardSchemaV1 | undefined = undefined,
> implements FieldDefinition {
  readonly metadata: FieldMetadata;
  constructor(
    readonly build: (name: string) => B,
    metadata: FieldMetadata,
    readonly validator?: V,
  ) {
    this.metadata = Object.freeze(metadata);
    Object.freeze(this);
  }
  /** Attach request validation while preserving the native column storage type. */
  validate<Validator extends StandardSchemaV1>(validator: Validator) {
    return new Field(this.build, this.metadata, validator);
  }
  /** Require a non-null database value and reflect that requirement in generated types. */
  notNull() {
    return new Field((name) => this.build(name).notNull(), { ...this.metadata, notNull: true }, this.validator);
  }
  /** Add a database uniqueness constraint for this column. */
  unique() {
    return new Field((name) => this.build(name).unique(), { ...this.metadata, unique: true }, this.validator);
  }
  /** Set a database default used when an insert omits this field. */
  default(value: B["_"]["data"] & (string | number | boolean | bigint | Date)) {
    const stored = value instanceof Date ? value.toISOString() : value;
    return new Field(
      (name) => this.build(name).default(sql`${stored}`.inlineParams()),
      {
        ...this.metadata,
        defaultValue: String(stored),
      },
      this.validator,
    );
  }
}

function field<B extends PgColumnBuilder<PgColumnBuilderConfig>>(kind: StorageKind, build: (name: string) => B) {
  return new Field(build, { kind, notNull: false, unique: false });
}
/** PostgreSQL numeric precision (total digits) and scale (fractional digits). */
export interface NumericOptions {
  readonly precision: number;
  readonly scale: number;
}
/** Foreign-key deletion policy. Choose cascade only when deleting the referenced row should delete dependent rows. */
export interface ReferenceOptions {
  readonly onDelete?: Reference["onDelete"];
}

export const fields = Object.freeze({
  text: () => field("text", (name) => text(name)),
  boolean: () => field("boolean", (name) => boolean(name)),
  integer: () => field("integer", (name) => integer(name)),
  bigint: () => field("bigint", (name) => bigint(name, { mode: "bigint" })),
  numeric: (options: NumericOptions = { precision: 38, scale: 10 }) => {
    if (
      !Number.isInteger(options.precision) ||
      options.precision < 1 ||
      options.precision > 1000 ||
      !Number.isInteger(options.scale) ||
      options.scale < 0 ||
      options.scale > options.precision
    ) {
      throw new Error("numeric requires precision 1..1000 and scale 0..precision");
    }
    const { precision, scale } = options;
    return new Field((name) => numeric(name, { precision, scale }), {
      kind: "numeric",
      notNull: false,
      unique: false,
      precision,
      scale,
    });
  },
  uuid: () => field("uuid", (name) => uuid(name)),
  timestamp: () => field("timestamp", (name) => timestamp(name, { withTimezone: true, mode: "date" })),
  json: () => field("json", (name) => jsonb(name).$type<JsonValue>()),
  enum: <const Values extends readonly [string, ...string[]]>(values: Values) => {
    if (new Set(values).size !== values.length) throw new Error("enum values must be distinct");
    // SAFETY: copying preserves every element and tuple position; freezing prevents later mutation.
    const enumValues = Object.freeze([...values]) as Values;
    return new Field((name) => text(name, { enum: enumValues }), {
      kind: "enum",
      notNull: false,
      unique: false,
      enumValues,
    });
  },
  reference: <const Target extends string>(target: Target, options: ReferenceOptions = {}) =>
    new Field((name) => uuid(name).$type<Id<Target>>(), {
      kind: "reference",
      notNull: false,
      unique: false,
      reference: Object.freeze({ target, onDelete: options.onDelete ?? "restrict" }),
    }),
});
