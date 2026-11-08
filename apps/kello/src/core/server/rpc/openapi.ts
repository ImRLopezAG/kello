import { OpenAPIGenerator, OpenAPIGeneratorError } from "@orpc/openapi";
import type { OpenAPIGeneratorOptions, OpenAPIGeneratorGenerateOptions, OpenAPIDocument } from "@orpc/openapi";
import { ValibotToJsonSchemaConverter } from "@orpc/valibot";
import { EffectSchemaToJsonSchemaConverter } from "@orpc/effect";
import { isStandardSchemaOptional } from "@orpc/json-schema";
import type { AnyRouter } from "@orpc/server";
import type { AnySchema } from "@orpc/contract";
import type { StandardJSONSchemaV1 } from "@standard-schema/spec";
import * as v from "valibot";
import { rpcErrorStatusMap } from "./error-status";

type Converter = NonNullable<OpenAPIGeneratorOptions["converters"]>[number];

function hasJsonSchema(schema: AnySchema | undefined): schema is AnySchema & StandardJSONSchemaV1 {
  return v.is(
    v.object({
      "~standard": v.object({ jsonSchema: v.object({ input: v.function(), output: v.function() }) }),
    }),
    schema,
  );
}

/** Precise OpenAPI export requires explicit output schemas. Native generation
 * supplies path-aware diagnostics; its permissive unknown-schema fallback is disabled. */
export function generateRpcOpenAPI(
  router: AnyRouter,
  options: OpenAPIGeneratorGenerateOptions<"3.2.0"> = {},
): Promise<OpenAPIDocument<"3.2.0">> {
  const converters: Converter[] = [
    new ValibotToJsonSchemaConverter({ errorMode: "throw" }),
    // Native converter: Effect's own JSON Schema document, with hoisted $defs. Errors propagate.
    new EffectSchemaToJsonSchemaConverter(),
    {
      condition: hasJsonSchema,
      convert(schema, direction) {
        if (!hasJsonSchema(schema)) throw new TypeError("Expected Standard JSON Schema");
        // Do not use upstream's fallback-to-{} conversion: unsupported public
        // contracts must fail generation instead of becoming unconstrained.
        const result = schema["~standard"].jsonSchema[direction]({ target: "draft-2020-12" });
        return [result, isStandardSchemaOptional(schema, direction)];
      },
    },
  ];
  const strict: Converter = {
    condition: () => true,
    convert(schema, direction) {
      if (schema === undefined) return [{}, true];
      const converter = converters.find((candidate) => candidate.condition(schema, direction));
      if (!converter)
        throw new OpenAPIGeneratorError(`Unsupported ${direction} schema vendor: ${schema["~standard"].vendor}`);
      try {
        return converter.convert(schema, direction);
      } catch {
        throw new OpenAPIGeneratorError(
          `Unsupported ${direction} schema conversion; supply a representable public contract`,
        );
      }
    },
  };
  return new OpenAPIGenerator({ converters: [strict] }).generate(router, {
    errorStatusMap: rpcErrorStatusMap,
    ...options,
    filter(contract, path) {
      const include = v.is(v.function(), options.filter) ? options.filter(contract, path) : options.filter;
      if (include === false) return false;
      const outputs = contract["~orpc"].outputSchemas;
      if (!outputs || (Array.isArray(outputs) && outputs.length === 0)) {
        throw new OpenAPIGeneratorError(`Procedure at ${path.join(".") || "(root)"}: explicit output schema required`);
      }
      return true;
    },
  });
}
