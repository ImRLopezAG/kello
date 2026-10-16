import * as v from "valibot";
import type { FieldMetadata, JsonValue } from "../schema/fields";

export type StorageValue =
  | null
  | boolean
  | number
  | string
  | bigint
  | Date
  | readonly StorageValue[]
  | { readonly [key: string]: StorageValue };
export interface StorageRow {
  [field: string]: StorageValue;
}

/** Native database values, before wire codecs convert dates or bigint values. */
export const storageValue: v.GenericSchema<StorageValue> = v.lazy(() =>
  v.union([
    v.null(),
    v.boolean(),
    v.pipe(v.number(), v.finite()),
    v.string(),
    v.bigint(),
    v.date(),
    v.array(storageValue),
    v.record(v.string(), storageValue),
  ]),
);
export const storageRows = v.array(v.record(v.string(), storageValue));

export const json: v.GenericSchema<JsonValue> = v.lazy(() =>
  v.union([
    v.null(),
    v.boolean(),
    v.pipe(v.number(), v.finite()),
    v.string(),
    v.array(json),
    v.record(v.string(), json),
  ]),
);
const uuid = v.pipe(v.string(), v.uuid());
const integer = v.pipe(v.number(), v.integer(), v.minValue(-2147483648), v.maxValue(2147483647));
const bigint = v.pipe(v.bigint(), v.minValue(-9223372036854775808n), v.maxValue(9223372036854775807n));
const milliseconds = v.pipe(v.number(), v.safeInteger());

export function storageParser(field: FieldMetadata): v.GenericSchema<StorageValue> {
  const parser = baseParser(field);
  return field.notNull ? parser : v.nullable(parser);
}
export const systemParsers = { _id: uuid, _createdAt: milliseconds };

function baseParser(field: FieldMetadata): v.GenericSchema<StorageValue> {
  switch (field.kind) {
    case "text":
      return v.string();
    case "boolean":
      return v.boolean();
    case "integer":
      return integer;
    case "bigint":
      return bigint;
    case "uuid":
    case "reference":
      return uuid;
    case "timestamp":
      return v.date();
    case "json":
      return json;
    case "enum":
      return v.picklist(field.enumValues ?? []);
    case "numeric":
      return v.pipe(
        v.string(),
        v.regex(/^-?\d+(\.\d+)?$/),
        v.check((value) => {
          const [whole = "", fraction = ""] = value.replace(/^-/, "").split(".");
          return (
            whole.replace(/^0+/, "").length <= (field.precision ?? 38) - (field.scale ?? 10) &&
            fraction.length <= (field.scale ?? 10)
          );
        }, "Numeric exceeds declared precision or scale"),
      );
  }
}

export const wire: v.GenericSchema<StorageValue, JsonValue> = v.lazy(() =>
  v.union([
    v.null(),
    v.boolean(),
    v.pipe(
      v.number(),
      v.finite(),
      v.check((value) => !Number.isInteger(value) || Number.isSafeInteger(value), "Unsafe integer"),
    ),
    v.string(),
    v.pipe(v.bigint(), v.transform(String)),
    v.pipe(
      v.date(),
      v.transform((value) => value.toISOString()),
    ),
    v.array(wire),
    v.record(v.string(), wire),
  ]),
);

/** Reject unsupported values before committing outputs or sending them to clients. */
export function encodeWire(value: StorageValue): JsonValue {
  return v.parse(wire, value);
}
