import { ValibotToJsonSchemaConverter } from "@orpc/valibot";
import type { StandardJSONSchemaV1, StandardSchemaV1 } from "@standard-schema/spec";
import * as v from "valibot";
import { isIdBrandAction } from "kello/internal/tooling";

function hasZodJSONSchema(rows: StandardSchemaV1): rows is StandardSchemaV1 & StandardJSONSchemaV1 {
  return v.is(
    v.object({
      vendor: v.literal("zod"),
      jsonSchema: v.object({ input: v.function(), output: v.function() }),
    }),
    rows["~standard"],
  );
}

// JSON Schema conversion omits custom checks and overwrite actions. Inspect
// Zod's source definitions first; only the flat, validation-preserving subset
// may cross the server-to-browser generation boundary.
const zodDefinition = v.pipe(
  v.object({ _zod: v.object({ def: v.record(v.string(), v.unknown()) }) }),
  v.transform((schema) => schema._zod.def),
);
type ZodDefinition = v.InferOutput<typeof zodDefinition>;

function validateZodFormatOptions(definition: ZodDefinition): void {
  if (definition.pattern !== undefined && v.parse(v.instance(RegExp), definition.pattern).flags)
    throw new Error("Live output JSON Schema cannot preserve regex flags");
  if (["protocol", "hostname", "normalize"].some((key) => definition[key] !== undefined))
    throw new Error("Live output JSON Schema cannot preserve URL options");
}

function validateZodSource(definition: ZodDefinition): void {
  if (definition.coerce) throw new Error("Unsupported live output coercion");
  validateZodFormatOptions(definition);
  const representedChecks = new Set([
    "min_length",
    "max_length",
    "length_equals",
    "greater_than",
    "less_than",
    "multiple_of",
    "number_format",
    "string_format",
  ]);
  for (const check of v.parse(v.array(v.unknown()), definition.checks ?? [])) {
    const definition = v.parse(zodDefinition, check);
    const kind = v.parse(v.string(), definition.check);
    validateZodFormatOptions(definition);
    if (!representedChecks.has(kind)) throw new Error("Unsupported live output refinement or transformation");
  }
  switch (definition.type) {
    case "array":
      validateZodSource(v.parse(zodDefinition, definition.element));
      break;
    case "object":
      for (const field of Object.values(v.parse(v.record(v.string(), v.unknown()), definition.shape)))
        validateZodSource(v.parse(zodDefinition, field));
      break;
    case "optional":
    case "nullable":
      validateZodSource(v.parse(zodDefinition, definition.innerType));
      break;
    case "union":
      for (const option of v.parse(v.array(v.unknown()), definition.options))
        validateZodSource(v.parse(zodDefinition, option));
      break;
    case "string":
    case "number":
    case "boolean":
    case "null":
    case "literal":
    case "enum":
      break;
    default:
      throw new Error("Unsupported live output schema");
  }
}

/** Generate browser-only validators, not imports of server schema bindings.
 * Unsupported output codecs/refinements refuse generation rather than silently
 * weakening validation. Input validation remains native oRPC/Standard Schema. */
export function liveRowsSource(rows: StandardSchemaV1): string {
  if (hasZodJSONSchema(rows)) validateZodSource(v.parse(zodDefinition, rows));
  const converter = new ValibotToJsonSchemaConverter({
    errorMode: "throw",
    overrideAction: ({ valibotAction, jsonSchema }) => (isIdBrandAction(valibotAction) ? jsonSchema : undefined),
  });
  const [schema, optional] = converter.condition(rows, "output")
    ? converter.convert(rows, "output")
    : hasZodJSONSchema(rows)
      ? [rows["~standard"].jsonSchema.output({ target: "draft-2020-12" }), false]
      : (() => {
          throw new Error("Live output generation requires a Valibot or Zod row-array schema");
        })();
  if (optional || !v.is(v.object({ type: v.literal("array"), items: v.object({ type: v.literal("object") }) }), schema))
    throw new Error("Live output must be an array of flat scalar rows");
  const schemaNode = v.record(v.string(), v.unknown());
  function emit(node: v.InferOutput<typeof schemaNode>, level: number): string {
    const permitted = new Set([
      "type",
      "items",
      "properties",
      "required",
      "additionalProperties",
      "anyOf",
      "enum",
      "const",
      "minLength",
      "maxLength",
      "pattern",
      "format",
      "minimum",
      "maximum",
      "exclusiveMinimum",
      "exclusiveMaximum",
      "multipleOf",
      "minItems",
      "maxItems",
      "$schema",
      "title",
      "description",
    ]);
    if (Object.keys(node).some((key) => !permitted.has(key))) throw new Error("Unsupported live output validation");
    let base: string;
    if (node.anyOf) {
      if (level < 2) throw new Error("Live output rows must be flat");
      base = `v.union([${v
        .parse(v.array(v.unknown()), node.anyOf)
        .map((part) => emit(v.parse(schemaNode, part), level))
        .join(",")}])`;
    } else if ("const" in node) base = `v.literal(${JSON.stringify(node.const)})`;
    else if (node.enum) base = `v.picklist(${JSON.stringify(node.enum)})`;
    else if (node.type === "array" && level === 0) base = `v.array(${emit(v.parse(schemaNode, node.items), 1)})`;
    else if (node.type === "object" && level === 1) {
      const required = new Set(v.parse(v.array(v.string()), node.required ?? []));
      const properties = v.parse(v.record(v.string(), v.unknown()), node.properties);
      const fields = Object.entries(properties).map(
        ([name, field]) =>
          `[${JSON.stringify(name)}]:${required.has(name) ? emit(v.parse(schemaNode, field), 2) : `v.optional(${emit(v.parse(schemaNode, field), 2)})`}`,
      );
      if (node.additionalProperties !== undefined && node.additionalProperties !== false)
        throw new Error("Live output requires declared fields only");
      base = `v.${node.additionalProperties === false ? "strictObject" : "object"}({${fields.join(",")}})`;
    } else if (level >= 2 && v.is(v.picklist(["string", "number", "integer", "boolean", "null"]), node.type))
      base = node.type === "integer" ? "v.pipe(v.number(),v.integer())" : `v.${node.type}()`;
    else throw new Error("Live output supports only flat scalar fields");
    const checks: string[] = [];
    const actions = {
      minLength: "minLength",
      maxLength: "maxLength",
      minimum: "minValue",
      maximum: "maxValue",
      multipleOf: "multipleOf",
      minItems: "minLength",
      maxItems: "maxLength",
    };
    for (const [keyword, action] of Object.entries(actions))
      if (node[keyword] !== undefined) checks.push(`v.${action}(${JSON.stringify(node[keyword])})`);
    if (node.pattern !== undefined) checks.push(`v.regex(new RegExp(${JSON.stringify(node.pattern)}))`);
    if (node.format !== undefined) {
      const formats = new Map([
        ["uuid", "uuid"],
        ["email", "email"],
        ["uri", "url"],
        ["date-time", "isoTimestamp"],
        ["date", "isoDate"],
      ]);
      const action = formats.get(v.parse(v.string(), node.format));
      if (!action) throw new Error("Unsupported live field format");
      checks.push(`v.${action}()`);
    }
    for (const [keyword, comparison] of [
      ["exclusiveMinimum", ">"],
      ["exclusiveMaximum", "<"],
    ])
      if (keyword && node[keyword] !== undefined)
        checks.push(`v.check(value => value ${comparison} ${JSON.stringify(node[keyword])})`);
    return checks.length ? `v.pipe(${base},${checks.join(",")})` : base;
  }
  const source = emit(v.parse(schemaNode, schema), 0);
  // Use the application's installed schema runtime. Zod's public converter
  // consumes the same restricted scalar schema checked by emit above.
  return hasZodJSONSchema(rows) ? `z.fromJSONSchema(${JSON.stringify(schema)})` : source;
}
