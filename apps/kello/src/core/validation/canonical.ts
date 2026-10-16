import * as v from "valibot";
import type { JsonValue } from "../schema/fields";

const primitive = v.union([v.null(), v.boolean(), v.pipe(v.number(), v.finite()), v.string()]);
const object = v.record(v.string(), v.unknown());
export function canonical(value: JsonValue): string {
  if (v.is(primitive, value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${Array.from(value, canonical).join(",")}]`;
  if (!v.is(object, value)) throw new Error("Invalid JSON object");
  return `{${Object.entries(value)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`;
}
